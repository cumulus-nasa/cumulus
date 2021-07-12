const cryptoRandomString = require('crypto-random-string');
const omit = require('lodash/omit');
const test = require('ava');
const uuid = require('uuid/v4');

const AsyncOperation = require('@cumulus/api/models/async-operation');
const { dynamodbDocClient } = require('@cumulus/aws-client/services');
const {
  createBucket,
  recursivelyDeleteS3Bucket,
} = require('@cumulus/aws-client/S3');
const {
  generateLocalTestDb,
  destroyLocalTestDb,
  AsyncOperationPgModel,
} = require('@cumulus/db');
const { RecordAlreadyMigrated } = require('@cumulus/errors');

const {
  migrateAsyncOperationRecord,
  migrateAsyncOperations,
} = require('../dist/lambda/async-operations');

// eslint-disable-next-line node/no-unpublished-require
const { migrationDir } = require('../../db-migration');

const testDbName = `data_migration_1_${cryptoRandomString({ length: 10 })}`;

const generateFakeAsyncOperation = (params) => ({
  id: uuid(),
  description: 'unittest async operation',
  output: '\"Index from database complete\"',
  operationType: 'ES Index',
  status: 'SUCCEEDED',
  taskArn: 'arn:aws:ecs:task:1234',
  createdAt: (Date.now() - 1000),
  updatedAt: Date.now(),
  ...params,
});

let asyncOperationsModel;

test.before(async (t) => {
  process.env.stackName = cryptoRandomString({ length: 10 });
  process.env.system_bucket = cryptoRandomString({ length: 10 });
  process.env.AsyncOperationsTable = cryptoRandomString({ length: 10 });

  await createBucket(process.env.system_bucket);

  asyncOperationsModel = new AsyncOperation({
    stackName: process.env.stackName,
    systemBucket: process.env.system_bucket,
  });
  await asyncOperationsModel.createTable();

  t.context.asyncOperationPgModel = new AsyncOperationPgModel();

  const { knex, knexAdmin } = await generateLocalTestDb(testDbName, migrationDir);
  t.context.knex = knex;
  t.context.knexAdmin = knexAdmin;
});

test.afterEach.always(async (t) => {
  await t.context.knex('async_operations').del();
});

test.after.always(async (t) => {
  await asyncOperationsModel.deleteTable();
  await recursivelyDeleteS3Bucket(process.env.system_bucket);
  await destroyLocalTestDb({
    knex: t.context.knex,
    knexAdmin: t.context.knexAdmin,
    testDbName,
  });
});

test.serial('migrateAsyncOperationRecord correctly migrates asyncOperation record', async (t) => {
  const { knex, asyncOperationPgModel } = t.context;

  const fakeAsyncOp = generateFakeAsyncOperation();
  await migrateAsyncOperationRecord(fakeAsyncOp, t.context.knex);

  const createdRecord = await asyncOperationPgModel.get(
    knex,
    { id: fakeAsyncOp.id }
  );

  t.deepEqual(
    omit(createdRecord, ['cumulus_id']),
    omit({
      ...fakeAsyncOp,
      operation_type: fakeAsyncOp.operationType,
      task_arn: fakeAsyncOp.taskArn,
      output: { output: JSON.parse(fakeAsyncOp.output) },
      created_at: new Date(fakeAsyncOp.createdAt),
      updated_at: new Date(fakeAsyncOp.updatedAt),
    },
    ['createdAt', 'updatedAt', 'operationType', 'taskArn'])
  );
});

test.serial('migrateAsyncOperationRecord correctly migrates asyncOperation record where record.output is an array', async (t) => {
  const output = '[\"string\",\"test-string"]';
  const fakeAsyncOp = generateFakeAsyncOperation({ output });
  await migrateAsyncOperationRecord(fakeAsyncOp, t.context.knex);

  const createdRecord = await t.context.knex.queryBuilder()
    .select()
    .table('async_operations')
    .where({ id: fakeAsyncOp.id })
    .first();

  t.deepEqual(
    omit(createdRecord, ['cumulus_id']),
    omit({
      ...fakeAsyncOp,
      operation_type: fakeAsyncOp.operationType,
      task_arn: fakeAsyncOp.taskArn,
      output: { output: JSON.parse(fakeAsyncOp.output) },
      created_at: new Date(fakeAsyncOp.createdAt),
      updated_at: new Date(fakeAsyncOp.updatedAt),
    },
    ['createdAt', 'updatedAt', 'operationType', 'taskArn'])
  );
});

test.serial('migrateAsyncOperationRecord migrates asyncOperation record with undefined nullables', async (t) => {
  const { knex, asyncOperationPgModel } = t.context;

  const fakeAsyncOp = generateFakeAsyncOperation();
  delete fakeAsyncOp.output;
  delete fakeAsyncOp.taskArn;
  await migrateAsyncOperationRecord(fakeAsyncOp, t.context.knex);

  const createdRecord = await asyncOperationPgModel.get(
    knex,
    { id: fakeAsyncOp.id }
  );

  t.deepEqual(
    omit(createdRecord, ['cumulus_id']),
    omit({
      ...fakeAsyncOp,
      operation_type: fakeAsyncOp.operationType,
      output: null,
      task_arn: null,
      created_at: new Date(fakeAsyncOp.createdAt),
      updated_at: new Date(fakeAsyncOp.updatedAt),
    },
    ['createdAt', 'updatedAt', 'operationType'])
  );
});

test.serial('migrateAsyncOperationRecord throws RecordAlreadyMigrated error if already migrated record is newer', async (t) => {
  const fakeAsyncOp = generateFakeAsyncOperation({
    updatedAt: Date.now(),
  });

  await migrateAsyncOperationRecord(fakeAsyncOp, t.context.knex);

  const olderFakeAsyncOp = {
    ...fakeAsyncOp,
    updatedAt: Date.now() - 1000, // older than fakeAsyncOp
  };

  await t.throwsAsync(
    migrateAsyncOperationRecord(olderFakeAsyncOp, t.context.knex),
    { instanceOf: RecordAlreadyMigrated }
  );
});

test.serial('migrateAsyncOperationRecord updates an already migrated record if the updated date is newer', async (t) => {
  const { knex, asyncOperationPgModel } = t.context;

  const fakeAsyncOp = generateFakeAsyncOperation({
    updatedAt: Date.now() - 1000,
  });
  await migrateAsyncOperationRecord(fakeAsyncOp, t.context.knex);

  const newerFakeAsyncOp = generateFakeAsyncOperation({
    ...fakeAsyncOp,
    updatedAt: Date.now(),
  });
  await migrateAsyncOperationRecord(newerFakeAsyncOp, t.context.knex);

  const createdRecord = await asyncOperationPgModel.get(
    knex,
    { id: fakeAsyncOp.id }
  );

  t.deepEqual(createdRecord.updated_at, new Date(newerFakeAsyncOp.updatedAt));
});

test.serial('migrateAsyncOperations processes multiple async operations', async (t) => {
  const { knex, asyncOperationPgModel } = t.context;

  const fakeAsyncOp1 = generateFakeAsyncOperation();
  const fakeAsyncOp2 = generateFakeAsyncOperation();

  await Promise.all([
    asyncOperationsModel.create(fakeAsyncOp1),
    asyncOperationsModel.create(fakeAsyncOp2),
  ]);
  t.teardown(() => Promise.all([
    asyncOperationsModel.delete({ id: fakeAsyncOp1.id }),
    asyncOperationsModel.delete({ id: fakeAsyncOp2.id }),
  ]));

  const migrationSummary = await migrateAsyncOperations(process.env, t.context.knex);
  t.deepEqual(migrationSummary, {
    dynamoRecords: 2,
    skipped: 0,
    failed: 0,
    success: 2,
  });

  const records = await asyncOperationPgModel.search(
    knex,
    {}
  );
  t.is(records.length, 2);
});

test.serial('migrateAsyncOperations processes all non-failing records', async (t) => {
  const { knex, asyncOperationPgModel } = t.context;

  const fakeAsyncOp1 = generateFakeAsyncOperation();
  const fakeAsyncOp2 = generateFakeAsyncOperation();

  // remove required source field so that record will fail
  delete fakeAsyncOp1.status;

  await Promise.all([
    // Have to use Dynamo client directly because creating
    // via model won't allow creation of an invalid record
    dynamodbDocClient().put({
      TableName: process.env.AsyncOperationsTable,
      Item: fakeAsyncOp1,
    }).promise(),
    asyncOperationsModel.create(fakeAsyncOp2),
  ]);
  t.teardown(() => Promise.all([
    asyncOperationsModel.delete({ id: fakeAsyncOp1.id }),
    asyncOperationsModel.delete({ id: fakeAsyncOp2.id }),
  ]));

  const migrationSummary = await migrateAsyncOperations(process.env, t.context.knex);
  t.deepEqual(migrationSummary, {
    dynamoRecords: 2,
    skipped: 0,
    failed: 1,
    success: 1,
  });
  const records = await asyncOperationPgModel.search(
    knex,
    {}
  );
  t.is(records.length, 1);
});

test.serial('migrateAsyncOperationRecord correctly migrates asyncOperation record where record.output is a string', async (t) => {
  const output = 'some-string';
  const fakeAsyncOp = generateFakeAsyncOperation({ output });
  await migrateAsyncOperationRecord(fakeAsyncOp, t.context.knex);

  const createdRecord = await t.context.knex.queryBuilder()
    .select()
    .table('async_operations')
    .where({ id: fakeAsyncOp.id })
    .first();

  t.deepEqual(
    omit(createdRecord, ['cumulus_id']),
    omit({
      ...fakeAsyncOp,
      operation_type: fakeAsyncOp.operationType,
      task_arn: fakeAsyncOp.taskArn,
      output: { output: fakeAsyncOp.output },
      created_at: new Date(fakeAsyncOp.createdAt),
      updated_at: new Date(fakeAsyncOp.updatedAt),
    },
    ['createdAt', 'updatedAt', 'operationType', 'taskArn'])
  );
});
