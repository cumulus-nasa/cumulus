'use strict';

const test = require('ava');
const cryptoRandomString = require('crypto-random-string');
const { constructCollectionId } = require('../Collections');

const {
  getMessagePdr,
  messageHasPdr,
  getMessagePdrPANSent,
  getMessagePdrPANMessage,
  getMessagePdrRunningExecutions,
  getMessagePdrCompletedExecutions,
  getMessagePdrFailedExecutions,
  getMessagePdrStats,
  getPdrPercentCompletion,
  generatePdrApiRecordFromMessage,
} = require('../PDRs');

test.beforeEach((t) => {
  t.context.pdr = {
    name: `pdr${cryptoRandomString({ length: 5 })}`,
    PANSent: true,
    PANmessage: 'message',
  };

  const collectionName = cryptoRandomString({ length: 5 });
  const collectionVersion = '1';
  t.context.collectionId = constructCollectionId(collectionName, collectionVersion);

  t.context.providerId = cryptoRandomString({ length: 5 });

  t.context.cumulusMessage = {
    cumulus_meta: {
      state_machine: 'state-machine',
      execution_name: 'execution1',
      workflow_start_time: Date.now(),
    },
    meta: {
      status: 'running',
      collection: {
        name: collectionName,
        version: collectionVersion,
      },
      provider: {
        id: t.context.providerId,
        protocol: 's3',
        host: 'random-bucket',
      },
    },
    payload: {
      pdr: {
        name: cryptoRandomString({ length: 5 }),
      },
    },
  };
});

test('getMessagePdr returns correct PDR object', (t) => {
  const { pdr } = t.context;
  t.deepEqual(
    getMessagePdr({
      payload: {
        pdr,
      },
    }),
    pdr
  );
});

test('getMessagePdr returns undefined if there is no PDR', (t) => {
  t.is(getMessagePdr({
    payload: {},
  }), undefined);
});

test('messageHasPdr correctly returns true if there is a PDR', (t) => {
  const { pdr } = t.context;
  t.true(messageHasPdr({
    payload: {
      pdr,
    },
  }));
});

test('messageHasPdr correct returns false if there is no PDR', (t) => {
  t.false(messageHasPdr({
    payload: {},
  }));
});

test('getMessagePdrPANSent returns correct value', (t) => {
  const { pdr } = t.context;
  pdr.PANSent = true;
  t.true(getMessagePdrPANSent({
    payload: {
      pdr: {
        PANSent: true,
      },
    },
  }));
  pdr.PANSent = false;
  t.false(getMessagePdrPANSent({
    payload: {
      pdr,
    },
  }));
});

test('getMessagePdrPANSent returns false if there is no PANsent value', (t) => {
  t.false(getMessagePdrPANSent({}));
});

test('getMessagePdrPANMessage returns correct value', (t) => {
  const { pdr } = t.context;
  t.is(getMessagePdrPANMessage({
    payload: {
      pdr,
    },
  }), pdr.PANmessage);
});

test('getMessagePdrPANMessage returns "N/A" if there is no PANMessage value', (t) => {
  t.is(getMessagePdrPANMessage({}), 'N/A');
});

test('getMessagePdrRunningExecutions returns correct number of executions', (t) => {
  const { pdr } = t.context;
  t.is(
    getMessagePdrRunningExecutions({
      payload: {
        pdr,
        running: ['one', 'two', 'three'],
      },
    }),
    3
  );
});

test('getMessagePdrRunningExecutions returns 0 if there are no running executions', (t) => {
  const { pdr } = t.context;
  t.is(
    getMessagePdrRunningExecutions({
      payload: {
        pdr,
      },
    }),
    0
  );
});

test('getMessagePdrCompletedExecutions returns correct number of executions', (t) => {
  const { pdr } = t.context;
  t.is(
    getMessagePdrCompletedExecutions({
      payload: {
        pdr,
        completed: ['one'],
      },
    }),
    1
  );
});

test('getMessagePdrCompletedExecutions returns 0 if there are no completed executions', (t) => {
  const { pdr } = t.context;
  t.is(
    getMessagePdrCompletedExecutions({
      payload: {
        pdr,
      },
    }),
    0
  );
});

test('getMessagePdrFailedExecutions returns correct number of executions', (t) => {
  const { pdr } = t.context;
  t.is(
    getMessagePdrFailedExecutions({
      payload: {
        pdr,
        failed: ['one'],
      },
    }),
    1
  );
});

test('getMessagePdrFailedExecutions returns 0 if there are no failed executions', (t) => {
  const { pdr } = t.context;
  t.is(
    getMessagePdrFailedExecutions({
      payload: {
        pdr,
      },
    }),
    0
  );
});

test('getMessagePdrStats returns correct stats', (t) => {
  const { pdr } = t.context;
  t.deepEqual(
    getMessagePdrStats({
      pdr,
      payload: {
        running: ['one', 'two'],
        completed: ['three', 'four'],
        failed: ['five', 'six'],
      },
    }),
    {
      processing: 2,
      completed: 2,
      failed: 2,
      total: 6,
    }
  );
});

test('getPdrPercentCompletion returns correct percentage', (t) => {
  t.is(
    getPdrPercentCompletion({
      processing: 2,
      completed: 2,
      failed: 0,
      total: 4,
    }),
    50
  );
  t.is(
    getPdrPercentCompletion({
      processing: 6,
      completed: 2,
      failed: 2,
      total: 10,
    }),
    40
  );
  t.is(
    getPdrPercentCompletion({
      processing: 0,
      completed: 1,
      failed: 0,
      total: 1,
    }),
    100
  );
});

test('generatePdrApiRecordFromMessage() returns undefined if message.payload.pdr is not set', (t) => {
  const pdrRecord = generatePdrApiRecordFromMessage({});
  t.is(pdrRecord, undefined);
});

test('generatePdrApiRecordFromMessage() throws error if message.payload.pdr.name is not set', (t) => {
  t.throws(() => generatePdrApiRecordFromMessage({
    payload: {
      pdr: {},
    },
  }),
  { message: 'Could not find name on PDR object {}' });
});

test('generatePdrApiRecordFromMessage() throws error if message.meta.status is not set', (t) => {
  const {
    cumulusMessage,
  } = t.context;
  delete cumulusMessage.meta.status;
  t.throws(
    () => generatePdrApiRecordFromMessage(cumulusMessage),
    { message: 'meta.status required to generate a PDR record' }
  );
});

test('generatePdrApiRecordFromMessage() throws error if message.meta.collection is not set', (t) => {
  const {
    cumulusMessage,
  } = t.context;
  delete cumulusMessage.meta.collection;
  t.throws(
    () => generatePdrApiRecordFromMessage(cumulusMessage),
    { message: 'meta.collection required to generate a PDR record' }
  );
});

test('generatePdrApiRecordFromMessage() throws error if message.meta.provider is not set', (t) => {
  const {
    cumulusMessage,
  } = t.context;
  delete cumulusMessage.meta.provider;
  t.throws(
    () => generatePdrApiRecordFromMessage(cumulusMessage),
    { message: 'meta.provider required to generate a PDR record' }
  );
});

test('generatePdrApiRecordFromMessage() throws error if execution ARN cannot be determined', (t) => {
  const {
    cumulusMessage,
  } = t.context;
  delete cumulusMessage.meta.provider;
  t.throws(
    () => generatePdrApiRecordFromMessage(cumulusMessage)
  );
});

test('generatePdrApiRecordFromMessage() generates a completed PDR record', (t) => {
  const {
    cumulusMessage,
    collectionId,
    providerId,
  } = t.context;

  const pdrName = cryptoRandomString({ length: 5 });
  cumulusMessage.meta.status = 'completed';
  const workflowStartTime = Date.now();
  cumulusMessage.cumulus_meta.workflow_start_time = workflowStartTime;

  const pdr = {
    name: pdrName,
  };
  cumulusMessage.payload = {
    pdr,
    completed: ['arn1'],
  };

  const record = generatePdrApiRecordFromMessage(cumulusMessage);

  t.is(record.status, 'completed');
  t.is(record.collectionId, collectionId);
  t.is(record.createdAt, workflowStartTime);
  t.is(record.provider, providerId);
  t.is(record.stats.failed, 0);
  t.is(record.stats.processing, 0);
  t.is(record.stats.completed, 1);
  t.is(record.stats.total, 1);
  t.is(record.progress, 100);
  t.is(typeof record.duration, 'number');
});

test('generatePdrApiRecordFromMessage() generates a failed PDR record', (t) => {
  const {
    cumulusMessage,
    collectionId,
    providerId,
  } = t.context;

  const pdrName = cryptoRandomString({ length: 5 });
  cumulusMessage.meta.status = 'failed';
  const workflowStartTime = Date.now();
  cumulusMessage.cumulus_meta.workflow_start_time = workflowStartTime;

  const pdr = {
    name: pdrName,
  };
  cumulusMessage.payload = {
    pdr,
    failed: ['arn1'],
  };

  const record = generatePdrApiRecordFromMessage(cumulusMessage);

  t.is(record.status, 'failed');
  t.is(record.collectionId, collectionId);
  t.is(record.createdAt, workflowStartTime);
  t.is(record.provider, providerId);
  const stats = record.stats;
  t.is(stats.total, 1);
  t.is(stats.failed, 1);
  t.is(stats.processing, 0);
  t.is(stats.completed, 0);
  t.is(record.progress, 100);
  t.is(typeof record.duration, 'number');
});

test('generatePdrApiRecordFromMessage() sets PDR properties when included', (t) => {
  const {
    cumulusMessage,
  } = t.context;
  const pdrName = cryptoRandomString({ length: 5 });
  const PANmessage = 'test message';

  const pdr = {
    name: pdrName,
    PANSent: true,
    PANmessage,
  };

  cumulusMessage.payload = {
    pdr,
  };

  const record = generatePdrApiRecordFromMessage(cumulusMessage);

  t.true(record.PANSent);
  t.is(record.PANmessage, PANmessage);
});
