const test = require('ava');
const sinon = require('sinon');

const S3 = require('@cumulus/aws-client/S3');
const { randomId } = require('@cumulus/common/test-utils');

const { fakeFileFactory, fakeGranuleFactoryV2 } = require('../../../lib/testUtils');
const Granule = require('../../../models/granules');

test.before(async (t) => {
  process.env.GranulesTable = randomId('granule');

  const fakeStepFunctionUtils = {
    describeExecution: () => Promise.resolve({}),
  };
  const fakeCmrUtils = {
    getGranuleTemporalInfo: () => Promise.resolve({}),
  };

  const granuleModel = new Granule({
    cmrUtils: fakeCmrUtils,
    stepFunctionUtils: fakeStepFunctionUtils,
  });
  t.context.granuleModel = granuleModel;
  await granuleModel.createTable();
});

test.beforeEach((t) => {
  t.context.collectionId = randomId('collection');
  t.context.provider = {
    name: randomId('name'),
    protocol: 's3',
    host: randomId('host'),
  };
  t.context.workflowStartTime = Date.now();
  t.context.workflowStatus = 'completed';
});

test('_storeGranuleRecord() can be used to create a new running granule', async (t) => {
  const { granuleModel } = t.context;

  const granule = fakeGranuleFactoryV2({
    status: 'running',
  });

  await granuleModel._storeGranuleRecord(granule);

  const fetchedItem = await granuleModel.get({ granuleId: granule.granuleId });

  t.is(fetchedItem.status, 'running');
});

test('_storeGranuleRecord() can be used to create a new completed granule', async (t) => {
  const { granuleModel } = t.context;

  const granule = fakeGranuleFactoryV2();

  await granuleModel._storeGranuleRecord(granule);

  const fetchedItem = await granuleModel.get({ granuleId: granule.granuleId });

  t.is(fetchedItem.status, 'completed');
});

test('_storeGranuleRecord() can be used to create a new failed granule', async (t) => {
  const { granuleModel } = t.context;

  const granule = fakeGranuleFactoryV2({ status: 'failed' });

  await granuleModel._storeGranuleRecord(granule);

  const fetchedItem = await granuleModel.get({ granuleId: granule.granuleId });

  t.is(fetchedItem.status, 'failed');
});

test('_storeGranuleRecord() can be used to update a completed granule', async (t) => {
  const { granuleModel } = t.context;

  const granule = fakeGranuleFactoryV2();

  await granuleModel._storeGranuleRecord(granule);

  const updatedGranule = {
    ...granule,
    productVolume: 500,
  };

  await granuleModel._storeGranuleRecord(updatedGranule);

  const fetchedItem = await granuleModel.get({ granuleId: granule.granuleId });

  t.is(fetchedItem.status, 'completed');
  t.is(fetchedItem.productVolume, 500);
});

test('_storeGranuleRecord() can be used to update a failed granule', async (t) => {
  const { granuleModel } = t.context;

  const granule = fakeGranuleFactoryV2({ status: 'failed' });

  await granuleModel._storeGranuleRecord(granule);

  const newError = { cause: 'fail' };
  const updatedGranule = {
    ...granule,
    error: newError,
  };

  await granuleModel._storeGranuleRecord(updatedGranule);

  const fetchedItem = await granuleModel.get({ granuleId: granule.granuleId });

  t.is(fetchedItem.status, 'failed');
  t.deepEqual(fetchedItem.error, newError);
});

test('_storeGranuleRecord() will allow a completed status to replace a running status for same execution', async (t) => {
  const { granuleModel } = t.context;

  const granule = fakeGranuleFactoryV2({ status: 'running' });

  await granuleModel._storeGranuleRecord(granule);

  const updatedGranule = {
    ...granule,
    status: 'completed',
  };

  await granuleModel._storeGranuleRecord(updatedGranule);

  const fetchedItem = await granuleModel.get({ granuleId: granule.granuleId });

  t.deepEqual(fetchedItem, updatedGranule);
});

test('_storeGranuleRecord() will allow a failed status to replace a running status for same execution', async (t) => {
  const { granuleModel } = t.context;

  const granule = fakeGranuleFactoryV2({ status: 'running' });

  await granuleModel._storeGranuleRecord(granule);

  const updatedGranule = {
    ...granule,
    status: 'failed',
  };

  await granuleModel._storeGranuleRecord(updatedGranule);

  const fetchedItem = await granuleModel.get({ granuleId: granule.granuleId });

  t.deepEqual(fetchedItem, updatedGranule);
});

test('_storeGranuleRecord() will not allow a running status to replace a completed status for same execution', async (t) => {
  const { granuleModel } = t.context;

  const granule = fakeGranuleFactoryV2();

  await granuleModel._storeGranuleRecord(granule);

  const updatedGranule = {
    ...granule,
    status: 'running',
  };

  await t.notThrowsAsync(granuleModel._storeGranuleRecord(updatedGranule));

  const fetchedItem = await granuleModel.get({ granuleId: granule.granuleId });

  t.deepEqual(fetchedItem, granule);
});

test('_storeGranuleRecord() will not allow a running status to replace a failed status for same execution', async (t) => {
  const { granuleModel } = t.context;

  const granule = fakeGranuleFactoryV2({ status: 'failed' });

  await granuleModel._storeGranuleRecord(granule);

  const updatedGranule = {
    ...granule,
    status: 'running',
  };

  await t.notThrowsAsync(granuleModel._storeGranuleRecord(updatedGranule));

  const fetchedItem = await granuleModel.get({ granuleId: granule.granuleId });

  t.deepEqual(fetchedItem, granule);
});

test('_storeGranuleRecord() will allow a running status to replace a completed status for a new execution', async (t) => {
  const { granuleModel } = t.context;

  const granule = fakeGranuleFactoryV2();

  await granuleModel._storeGranuleRecord(granule);
  const updateTime = Date.now();

  const updatedGranule = {
    ...granule,
    execution: 'new-execution-url',
    status: 'running',
    createdAt: updateTime,
  };

  await granuleModel._storeGranuleRecord(updatedGranule);

  const fetchedItem = await granuleModel.get({ granuleId: granule.granuleId });

  t.deepEqual(
    fetchedItem,
    {
      ...granule,
      status: 'running',
      createdAt: updateTime,
      execution: 'new-execution-url',
    }
  );
});

test('_storeGranuleRecord() will allow a running status to replace a failed status for a new execution', async (t) => {
  const { granuleModel } = t.context;

  const granule = fakeGranuleFactoryV2({ status: 'failed' });

  await granuleModel._storeGranuleRecord(granule);
  const updateTime = Date.now();

  const updatedGranule = {
    ...granule,
    execution: 'new-execution-url',
    status: 'running',
    createdAt: updateTime,
  };

  await granuleModel._storeGranuleRecord(updatedGranule);

  const fetchedItem = await granuleModel.get({ granuleId: granule.granuleId });

  t.deepEqual(
    fetchedItem,
    {
      ...granule,
      status: 'running',
      createdAt: updateTime,
      execution: 'new-execution-url',
    }
  );
});

test('_validateAndStoreGranuleRecord() will not allow a final status for an older execution to replace a running status for a newer execution ', async (t) => {
  const { granuleModel } = t.context;

  const timeVal = Date.now();

  const granule = fakeGranuleFactoryV2();

  const originalGranule = {
    ...granule,
    createdAt: timeVal + 1000000,
    status: 'running',
  };

  await granuleModel._validateAndStoreGranuleRecord(originalGranule);

  const updatedGranule = {
    ...granule,
    execution: 'new-execution-url',
    status: 'failed',
  };

  await t.notThrowsAsync(granuleModel._validateAndStoreGranuleRecord(updatedGranule));

  const fetchedItem = await granuleModel.get({ granuleId: granule.granuleId });

  t.deepEqual(fetchedItem, originalGranule);
});

test('_validateAndStoreGranuleRecord() will not allow a final status for an older execution to replace a final status for a newer execution ', async (t) => {
  const { granuleModel } = t.context;

  const timeVal = Date.now();

  const granule = fakeGranuleFactoryV2();

  const originalGranule = {
    ...granule,
    createdAt: timeVal + 1000000,
    status: 'completed',
  };

  await granuleModel._validateAndStoreGranuleRecord(originalGranule);

  const updatedGranule = {
    ...granule,
    execution: 'alt-execution-url',
    status: 'failed',
  };

  await t.notThrowsAsync(granuleModel._validateAndStoreGranuleRecord(updatedGranule));

  const fetchedItem = await granuleModel.get({ granuleId: granule.granuleId });
  t.deepEqual(fetchedItem, originalGranule);
});

test('_validateAndStoreGranuleRecord() will allow a final status for a new execution to replace a final status for an older execution ', async (t) => {
  const { granuleModel } = t.context;

  const granule = fakeGranuleFactoryV2();

  await granuleModel._validateAndStoreGranuleRecord({
    ...granule,
    status: 'completed',
  });

  const updatedGranule = {
    ...granule,
    createdAt: Date.now(),
    execution: 'alt-execution-url',
    status: 'failed',
  };

  await granuleModel._validateAndStoreGranuleRecord(updatedGranule);

  const fetchedItem = await granuleModel.get({ granuleId: granule.granuleId });

  t.deepEqual(fetchedItem, updatedGranule);
});

test('_validateAndStoreGranuleRecord() does throw validation error', async (t) => {
  const { granuleModel } = t.context;

  const granule = fakeGranuleFactoryV2();
  // granule without granuleId should fail validation
  delete granule.granuleId;

  await t.throwsAsync(granuleModel._validateAndStoreGranuleRecord(granule));
});

test('_validateAndStoreGranuleRecord() throws an error if trying to update granule to failed -> running without a new execution', async (t) => {
  const { granuleModel } = t.context;

  const granule = fakeGranuleFactoryV2({ status: 'failed' });

  await granuleModel._validateAndStoreGranuleRecord(granule);

  const updatedGranule = {
    ...granule,
    status: 'running',
  };

  await t.notThrowsAsync(granuleModel._validateAndStoreGranuleRecord(updatedGranule));
});

test('storeGranuleFromCumulusMessage() throws an error for a failing record', async (t) => {
  const {
    granuleModel,
  } = t.context;

  const granule1 = fakeGranuleFactoryV2({
    files: [fakeFileFactory()],
  });

  // cause record to fail
  delete granule1.granuleId;

  await t.throwsAsync(granuleModel.storeGranuleFromCumulusMessage(granule1));
});

test('storeGranuleFromCumulusMessage() correctly stores granule record', async (t) => {
  const {
    granuleModel,
  } = t.context;

  const bucket = randomId('bucket-');
  await S3.createBucket(bucket);
  t.teardown(() => S3.recursivelyDeleteS3Bucket(bucket));

  const granule1 = fakeGranuleFactoryV2({
    files: [fakeFileFactory({ bucket })],
  });

  await S3.s3PutObject({ Bucket: bucket, Key: granule1.files[0].key, Body: 'asdf' });

  await granuleModel.storeGranuleFromCumulusMessage(granule1);

  t.true(await granuleModel.exists({ granuleId: granule1.granuleId }));
});

test('storeGranulesFromCumulusMessage() stores multiple granules from Cumulus message', async (t) => {
  const { granuleModel } = t.context;

  const bucket = randomId('bucket-');
  await S3.createBucket(bucket);

  try {
    const granule1 = fakeGranuleFactoryV2({
      files: [fakeFileFactory({ bucket })],
    });
    const granule2 = fakeGranuleFactoryV2({
      files: [fakeFileFactory({ bucket })],
    });

    await Promise.all([
      S3.s3PutObject({ Bucket: bucket, Key: granule1.files[0].key, Body: 'asdf' }),
      S3.s3PutObject({ Bucket: bucket, Key: granule2.files[0].key, Body: 'asdf' }),
    ]);

    const cumulusMessage = {
      cumulus_meta: {
        execution_name: randomId('execution'),
        state_machine: 'state-machine',
        workflow_start_time: Date.now(),
      },
      meta: {
        collection: {
          name: 'name',
          version: '001',
        },
        provider: {
          host: 'example-bucket',
          protocol: 's3',
        },
        status: 'completed',
      },
      payload: {
        granules: [
          granule1,
          granule2,
        ],
      },
    };

    await granuleModel.storeGranulesFromCumulusMessage(cumulusMessage);

    t.true(await granuleModel.exists({ granuleId: granule1.granuleId }));
    t.true(await granuleModel.exists({ granuleId: granule2.granuleId }));
  } finally {
    await S3.recursivelyDeleteS3Bucket(bucket);
  }
});

test.serial('storeGranulesFromCumulusMessage() handles failing and succcessful granules independently', async (t) => {
  const { granuleModel } = t.context;

  const bucket = randomId('bucket-');
  await S3.createBucket(bucket);
  t.teardown(() => S3.recursivelyDeleteS3Bucket(bucket));

  const granule1 = fakeGranuleFactoryV2({
    files: [fakeFileFactory({ bucket })],
  });
  const granule2 = fakeGranuleFactoryV2();

  await S3.s3PutObject({ Bucket: bucket, Key: granule1.files[0].key, Body: 'asdf' });

  const cumulusMessage = {
    cumulus_meta: {
      execution_name: randomId('execution'),
      state_machine: 'state-machine',
      workflow_start_time: Date.now(),
    },
    meta: {
      collection: {
        name: 'name',
        version: '001',
      },
      provider: {
        host: 'example-bucket',
        protocol: 's3',
      },
      status: 'completed',
    },
    payload: {
      granules: [
        granule1,
        granule2,
      ],
    },
  };

  sinon.stub(Granule.prototype, 'storeGranuleFromCumulusMessage')
    .withArgs(sinon.match({ granuleId: granule2.granuleId }))
    .rejects(new Error('fail'));
  Granule.prototype.storeGranuleFromCumulusMessage.callThrough();
  t.teardown(() => Granule.prototype.storeGranuleFromCumulusMessage.restore());

  await granuleModel.storeGranulesFromCumulusMessage(cumulusMessage);

  t.true(await granuleModel.exists({ granuleId: granule1.granuleId }));
  t.false(await granuleModel.exists({ granuleId: granule2.granuleId }));
});
