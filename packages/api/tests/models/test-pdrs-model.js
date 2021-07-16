'use strict';

const test = require('ava');

const { randomId, randomString } = require('@cumulus/common/test-utils');

const { fakePdrFactoryV2 } = require('../../lib/testUtils');
const Pdr = require('../../models/pdrs');

let pdrsModel;

test.before(async () => {
  process.env.PdrsTable = randomString();
  pdrsModel = new Pdr();
  await pdrsModel.createTable();
});

test.after.always(async () => {
  await pdrsModel.deleteTable();
});

test('storePdr() returns undefined if there is no pdr', async (t) => {
  const output = await pdrsModel.storePdr();
  t.is(output, undefined);
});

test('storePdr() throws error if record is invalid', async (t) => {
  await t.throwsAsync(
    pdrsModel.storePdr({})
  );
});

test(
  'storePdr() updates the database if status is running and the execution is different',
  async (t) => {
    const initialExecution = 'execution-1';
    const pdr = fakePdrFactoryV2({
      status: 'running',
      execution: initialExecution,
    });

    await pdrsModel.storePdr(pdr);

    t.is(
      (await pdrsModel.get({ pdrName: pdr.pdrName })).execution,
      initialExecution
    );

    const updatedExecution = 'execution-2';
    const updatedPdr = {
      ...pdr,
      execution: updatedExecution,
    };

    await pdrsModel.storePdr(updatedPdr);

    const record = await pdrsModel.get({ pdrName: pdr.pdrName });
    t.is(record.status, 'running');
    t.is(record.execution, updatedExecution);
  }
);

test(
  'storePdr() does not update PDR record if update is from an older execution',
  async (t) => {
    const pdr = fakePdrFactoryV2({
      status: 'completed',
      createdAt: (Date.now() + 10000000000),
      stats: {
        completed: 3,
        total: 3,
      },
      execution: randomId('exec'),
    });

    await pdrsModel.storePdr(pdr);

    const updatedPdr = {
      ...pdr,
      status: 'running',
      createdAt: Date.now(),
      stats: {
        processing: 2,
        total: 2,
      },
    };

    const response = await pdrsModel.storePdr(updatedPdr);
    t.is(response, undefined);

    const record = await pdrsModel.get({ pdrName: pdr.pdrName });
    t.is(record.status, 'completed');
    t.is(record.stats.completed, 3);
    t.falsy(record.stats.processing);
  }
);

test(
  'storePdr() does not update same-execution if progress is less than current',
  async (t) => {
    const execution = randomId('exec');
    const pdr = fakePdrFactoryV2({
      status: 'completed',
      stats: {
        completed: 3,
        total: 3,
      },
      progress: 100,
      execution,
    });
    await pdrsModel.storePdr(pdr);

    t.is(
      (await pdrsModel.get({ pdrName: pdr.pdrName })).execution,
      execution
    );

    const updatedPdr = {
      ...pdr,
      status: 'running',
      stats: {
        processing: 3,
        total: 3,
      },
      progress: 0,
    };

    const response = await pdrsModel.storePdr(updatedPdr);
    t.is(response, undefined);

    const record = await pdrsModel.get({ pdrName: pdr.pdrName });
    t.is(record.status, 'completed');
    t.is(record.stats.completed, 3);
  }
);

test(
  'storePdr() does not update PDR record if update is from an older completed execution',
  async (t) => {
    const execution = randomId('exec');
    const pdr = fakePdrFactoryV2({
      status: 'completed',
      createdAt: (Date.now() + 10000000000),
      stats: {
        completed: 3,
        total: 3,
      },
      progress: 100,
      execution,
    });
    await pdrsModel.storePdr(pdr);

    const updatedExecution = randomId('exec');
    const updatedPdr = {
      ...pdr,
      status: 'failed',
      stats: {
        failed: 2,
        total: 2,
      },
      createdAt: Date.now(),
      execution: updatedExecution,
    };
    const response = await pdrsModel.storePdr(updatedPdr);
    t.is(response, undefined);

    const record = await pdrsModel.get({ pdrName: pdr.pdrName });
    t.is(record.status, 'completed');
    t.is(record.execution, execution);
    t.is(record.stats.completed, 3);
    t.falsy(record.stats.failed);
  }
);

test(
  'storePdr() does not update if PDR record is from an older, prior completed execution',
  async (t) => {
    const execution = randomId('exec');
    const pdr = fakePdrFactoryV2({
      status: 'completed',
      createdAt: (Date.now() + 10000000000),
      stats: {
        completed: 3,
        total: 3,
      },
      progress: 100,
      execution,
    });
    await pdrsModel.storePdr(pdr);

    const updatedPdr = {
      ...pdr,
      status: 'failed',
      stats: {
        failed: 2,
        total: 2,
      },
      createdAt: Date.now(),
    };
    const response = await pdrsModel.storePdr(updatedPdr);
    t.is(response, undefined);

    const record = await pdrsModel.get({ pdrName: pdr.pdrName });
    t.is(record.status, 'completed');
    t.is(record.stats.completed, 3);
  }
);

test('storePdr() overwrites a same-execution running status if progress was made',
  async (t) => {
    const execution = randomId('exec');
    const pdr = fakePdrFactoryV2({
      status: 'running',
      createdAt: (Date.now() + 10000000000),
      stats: {
        processing: 5,
        total: 5,
      },
      progress: 0,
      execution,
    });

    await pdrsModel.storePdr(pdr);
    t.is(
      (await pdrsModel.get({ pdrName: pdr.pdrName })).execution,
      execution
    );

    const updatedPdr = {
      ...pdr,
      stats: {
        processing: 1,
        completed: 4,
        total: 5,
      },
      progress: 20,
    };

    await pdrsModel.storePdr(updatedPdr);

    const record = await pdrsModel.get({ pdrName: pdr.pdrName });
    t.is(record.stats.processing, 1);
    t.is(record.stats.completed, 4);
  });
