const cryptoRandomString = require('crypto-random-string');
const omit = require('lodash/omit');
const test = require('ava');

const Granule = require('@cumulus/api/models/granules');
const s3Utils = require('@cumulus/aws-client/S3');

const { dynamodbDocClient } = require('@cumulus/aws-client/services');
const { fakeFileFactory } = require('@cumulus/api/lib/testUtils');
const {
  CollectionPgModel,
  destroyLocalTestDb,
  ExecutionPgModel,
  fakeCollectionRecordFactory,
  fakeExecutionRecordFactory,
  FilePgModel,
  generateLocalTestDb,
  GranulesExecutionsPgModel,
  GranulePgModel,
  tableNames,
  translateApiGranuleToPostgresGranule,
} = require('@cumulus/db');
const { RecordAlreadyMigrated, PostgresUpdateFailed } = require('@cumulus/errors');

// eslint-disable-next-line node/no-unpublished-require
const { migrationDir } = require('../../db-migration');
const { migrateGranuleRecord, migrateFileRecord, migrateGranulesAndFiles } = require('../dist/lambda/granulesAndFiles');

const buildCollectionId = (name, version) => `${name}___${version}`;

const dateString = new Date().toString();
const bucket = cryptoRandomString({ length: 10 });

const fileOmitList = ['granule_cumulus_id', 'cumulus_id', 'created_at', 'updated_at'];
const fakeFile = () => fakeFileFactory({
  bucket,
  key: cryptoRandomString({ length: 10 }),
  size: 1098034,
  fileName: 'MOD09GQ.A4369670.7bAGCH.006.0739896140643.hdf',
  checksum: 'checkSum01',
  checksumType: 'md5',
  type: 'data',
  source: 'source',
});

const generateTestGranule = (params) => ({
  granuleId: cryptoRandomString({ length: 5 }),
  status: 'running',
  cmrLink: cryptoRandomString({ length: 10 }),
  published: false,
  duration: 10,
  files: [
    fakeFile(),
  ],
  error: {},
  productVolume: 1119742,
  timeToPreprocess: 0,
  beginningDateTime: dateString,
  endingDateTime: dateString,
  processingStartDateTime: dateString,
  processingEndDateTime: dateString,
  lastUpdateDateTime: dateString,
  timeToArchive: 0,
  productionDateTime: dateString,
  timestamp: Date.now(),
  createdAt: Date.now() - 200 * 1000,
  updatedAt: Date.now(),
  ...params,
});

let granulesModel;

const testDbName = `data_migration_2_${cryptoRandomString({ length: 10 })}`;

test.before(async (t) => {
  await s3Utils.createBucket(bucket);
  process.env.stackName = cryptoRandomString({ length: 10 });
  process.env.system_bucket = bucket;

  process.env.GranulesTable = cryptoRandomString({ length: 10 });

  granulesModel = new Granule();
  await granulesModel.createTable();

  t.context.granulePgModel = new GranulePgModel();
  t.context.filePgModel = new FilePgModel();
  t.context.granulesExecutionsPgModel = new GranulesExecutionsPgModel();

  const { knexAdmin, knex } = await generateLocalTestDb(
    testDbName,
    migrationDir
  );
  t.context.knexAdmin = knexAdmin;
  t.context.knex = knex;
});

test.beforeEach(async (t) => {
  const collectionPgModel = new CollectionPgModel();
  const testCollection = fakeCollectionRecordFactory();

  const collectionResponse = await collectionPgModel.create(
    t.context.knex,
    testCollection
  );
  t.context.testCollection = testCollection;
  t.context.collectionCumulusId = collectionResponse[0];

  const executionPgModel = new ExecutionPgModel();
  const executionUrl = cryptoRandomString({ length: 5 });
  const testExecution = fakeExecutionRecordFactory({
    url: executionUrl,
  });

  const executionResponse = await executionPgModel.create(
    t.context.knex,
    testExecution
  );
  t.context.testExecution = testExecution;
  t.context.executionCumulusId = executionResponse[0];

  t.context.testGranule = generateTestGranule({
    collectionId: buildCollectionId(testCollection.name, testCollection.version),
    execution: executionUrl,
  });
});

test.afterEach.always(async (t) => {
  // TODO: we should be just removing the records via `delete` methods
  await t.context.knex(tableNames.files).del();
  await t.context.knex(tableNames.granulesExecutions).del();
  await t.context.knex(tableNames.granules).del();
  await t.context.knex(tableNames.collections).del();
  await t.context.knex(tableNames.executions).del();
});

test.after.always(async (t) => {
  await granulesModel.deleteTable();

  await s3Utils.recursivelyDeleteS3Bucket(bucket);

  await destroyLocalTestDb({
    ...t.context,
    testDbName,
  });
});

test.serial('migrateGranuleRecord correctly migrates granule record', async (t) => {
  const {
    collectionCumulusId,
    executionCumulusId,
    granulesExecutionsPgModel,
    granulePgModel,
    knex,
    testGranule,
  } = t.context;

  const [granuleCumulusId] = await migrateGranuleRecord(testGranule, knex);
  const record = await granulePgModel.get(knex, {
    cumulus_id: granuleCumulusId,
  });

  t.deepEqual(
    omit(record, ['cumulus_id']),
    {
      granule_id: testGranule.granuleId,
      status: testGranule.status,
      collection_cumulus_id: collectionCumulusId,
      published: testGranule.published,
      duration: testGranule.duration,
      time_to_archive: testGranule.timeToArchive,
      time_to_process: testGranule.timeToPreprocess,
      product_volume: testGranule.productVolume.toString(),
      error: testGranule.error,
      cmr_link: testGranule.cmrLink,
      pdr_cumulus_id: null,
      provider_cumulus_id: null,
      query_fields: null,
      beginning_date_time: new Date(testGranule.beginningDateTime),
      ending_date_time: new Date(testGranule.endingDateTime),
      last_update_date_time: new Date(testGranule.lastUpdateDateTime),
      processing_end_date_time: new Date(testGranule.processingEndDateTime),
      processing_start_date_time: new Date(testGranule.processingStartDateTime),
      production_date_time: new Date(testGranule.productionDateTime),
      timestamp: new Date(testGranule.timestamp),
      created_at: new Date(testGranule.createdAt),
      updated_at: new Date(testGranule.updatedAt),
    }
  );
  t.deepEqual(
    await granulesExecutionsPgModel.search(
      knex,
      { granule_cumulus_id: granuleCumulusId }
    ),
    [executionCumulusId].map((executionId) => ({
      granule_cumulus_id: Number(granuleCumulusId),
      execution_cumulus_id: executionId,
    }))
  );
});

test.serial('migrateFileRecord correctly migrates file record', async (t) => {
  const {
    filePgModel,
    granulePgModel,
    knex,
    testGranule,
  } = t.context;

  const testFile = testGranule.files[0];
  const granule = await translateApiGranuleToPostgresGranule(testGranule, knex);
  const [granuleCumulusId] = await granulePgModel.create(knex, granule);
  await migrateFileRecord(testFile, granuleCumulusId, knex);

  const record = await filePgModel.get(knex, { bucket: testFile.bucket, key: testFile.key });

  t.deepEqual(
    omit(record, fileOmitList),
    {
      bucket: testFile.bucket,
      checksum_value: testFile.checksum,
      checksum_type: testFile.checksumType,
      key: testFile.key,
      path: null,
      file_size: testFile.size.toString(),
      file_name: testFile.fileName,
      source: testFile.source,
    }
  );
});

test.serial('migrateFileRecord correctly migrates file record with null bucket and key', async (t) => {
  const {
    filePgModel,
    granulePgModel,
    knex,
    testGranule,
  } = t.context;

  const testFile = fakeFileFactory({
    bucket: undefined,
    key: undefined,
  });
  testGranule.files = [testFile];

  const granule = await translateApiGranuleToPostgresGranule(testGranule, knex);
  const [granuleCumulusId] = await granulePgModel.create(knex, granule);
  await migrateFileRecord(testFile, granuleCumulusId, knex);

  const record = await filePgModel.get(knex, { bucket: null, key: null });

  t.deepEqual(
    omit(record, fileOmitList),
    {
      bucket: null,
      checksum_value: null,
      checksum_type: null,
      key: null,
      path: null,
      file_size: null,
      file_name: testFile.fileName,
      source: null,
    }
  );
});

test.serial('migrateGranuleRecord throws error on invalid source data from DynamoDB', async (t) => {
  const {
    knex,
    testGranule,
  } = t.context;

  delete testGranule.collectionId;

  await t.throwsAsync(
    migrateGranuleRecord(testGranule, knex),
    { name: 'SchemaValidationError' }
  );
});

test.serial('migrateGranuleRecord handles nullable fields on source granule data', async (t) => {
  const {
    collectionCumulusId,
    executionCumulusId,
    granulePgModel,
    granulesExecutionsPgModel,
    knex,
    testGranule,
  } = t.context;

  delete testGranule.pdrName;
  delete testGranule.cmrLink;
  delete testGranule.published;
  delete testGranule.duration;
  delete testGranule.files;
  delete testGranule.error;
  delete testGranule.productVolume;
  delete testGranule.timeToPreprocess;
  delete testGranule.beginningDateTime;
  delete testGranule.endingDateTime;
  delete testGranule.processingStartDateTime;
  delete testGranule.processingEndDateTime;
  delete testGranule.lastUpdateDateTime;
  delete testGranule.timeToArchive;
  delete testGranule.productionDateTime;
  delete testGranule.timestamp;
  delete testGranule.provider;
  delete testGranule.queryFields;
  delete testGranule.version;

  const [granuleCumulusId] = await migrateGranuleRecord(testGranule, knex);
  const record = await granulePgModel.get(knex, {
    cumulus_id: granuleCumulusId,
  });

  t.deepEqual(
    omit(record, ['cumulus_id']),
    {
      granule_id: testGranule.granuleId,
      status: testGranule.status,
      collection_cumulus_id: collectionCumulusId,
      published: testGranule.published,
      duration: null,
      time_to_archive: null,
      time_to_process: null,
      product_volume: null,
      error: null,
      cmr_link: null,
      pdr_cumulus_id: null,
      provider_cumulus_id: null,
      query_fields: null,
      beginning_date_time: null,
      ending_date_time: null,
      last_update_date_time: null,
      processing_end_date_time: null,
      processing_start_date_time: null,
      production_date_time: null,
      timestamp: null,
      created_at: new Date(testGranule.createdAt),
      updated_at: new Date(testGranule.updatedAt),
    }
  );
  t.deepEqual(
    await granulesExecutionsPgModel.search(
      knex,
      { granule_cumulus_id: granuleCumulusId }
    ),
    [executionCumulusId].map((executionId) => ({
      granule_cumulus_id: Number(granuleCumulusId),
      execution_cumulus_id: executionId,
    }))
  );
});

test.serial('migrateGranuleRecord throws RecordAlreadyMigrated error if previously migrated record is newer', async (t) => {
  const {
    knex,
    testGranule,
  } = t.context;

  const testGranule1 = testGranule;
  const testGranule2 = {
    ...testGranule1,
    updatedAt: Date.now() - 1000,
  };

  await migrateGranuleRecord(testGranule1, knex);

  await t.throwsAsync(
    migrateGranuleRecord(testGranule2, knex),
    { instanceOf: RecordAlreadyMigrated }
  );
});

test.serial('migrateGranuleRecord throws error if upsert does not return any rows', async (t) => {
  const {
    knex,
    testCollection,
    testExecution,
  } = t.context;

  const testGranule = generateTestGranule({
    collectionId: buildCollectionId(testCollection.name, testCollection.version),
    execution: testExecution.url,
  });

  await migrateGranuleRecord(testGranule, knex);

  const newerGranule = {
    ...testGranule,
    updatedAt: Date.now(),
  };

  await t.throwsAsync(
    migrateGranuleRecord(newerGranule, knex),
    { instanceOf: PostgresUpdateFailed }
  );
});

test.serial('migrateGranuleRecord updates an already migrated record if the updated date is newer', async (t) => {
  const {
    knex,
    granulePgModel,
    testCollection,
    testExecution,
    collectionCumulusId,
  } = t.context;

  const testGranule = generateTestGranule({
    collectionId: buildCollectionId(testCollection.name, testCollection.version),
    execution: testExecution.url,
    status: 'completed',
  });

  await migrateGranuleRecord(testGranule, knex);

  const newerGranule = {
    ...testGranule,
    updatedAt: Date.now(),
  };

  const [granuleCumulusId] = await migrateGranuleRecord(newerGranule, knex);
  const record = await granulePgModel.get(knex, {
    cumulus_id: granuleCumulusId,
  });

  t.deepEqual(
    omit(record, ['cumulus_id']),
    {
      granule_id: testGranule.granuleId,
      status: testGranule.status,
      collection_cumulus_id: collectionCumulusId,
      published: testGranule.published,
      duration: testGranule.duration,
      time_to_archive: testGranule.timeToArchive,
      time_to_process: testGranule.timeToPreprocess,
      product_volume: testGranule.productVolume.toString(),
      error: testGranule.error,
      cmr_link: testGranule.cmrLink,
      pdr_cumulus_id: null,
      provider_cumulus_id: null,
      query_fields: null,
      beginning_date_time: new Date(testGranule.beginningDateTime),
      ending_date_time: new Date(testGranule.endingDateTime),
      last_update_date_time: new Date(testGranule.lastUpdateDateTime),
      processing_end_date_time: new Date(testGranule.processingEndDateTime),
      processing_start_date_time: new Date(testGranule.processingStartDateTime),
      production_date_time: new Date(testGranule.productionDateTime),
      timestamp: new Date(testGranule.timestamp),
      created_at: new Date(testGranule.createdAt),
      updated_at: new Date(newerGranule.updatedAt),
    }
  );
});

test.serial('migrateFileRecord handles nullable fields on source file data', async (t) => {
  const {
    filePgModel,
    granulePgModel,
    knex,
    testGranule,
  } = t.context;

  const testFile = testGranule.files[0];

  delete testFile.bucket;
  delete testFile.checksum;
  delete testFile.checksumType;
  delete testFile.fileName;
  delete testFile.key;
  delete testFile.path;
  delete testFile.size;
  delete testFile.source;

  const granule = await translateApiGranuleToPostgresGranule(testGranule, knex);
  const [granuleCumulusId] = await granulePgModel.create(knex, granule);
  await migrateFileRecord(testFile, granuleCumulusId, knex);

  const record = await filePgModel.get(knex, { bucket: null, key: null });

  t.deepEqual(
    omit(record, fileOmitList),
    {
      bucket: null,
      checksum_value: null,
      checksum_type: null,
      file_size: null,
      file_name: null,
      key: null,
      source: null,
      path: null,
    }
  );
});

test.serial('migrateGranulesAndFiles skips already migrated granule record', async (t) => {
  const {
    knex,
    testGranule,
  } = t.context;

  await migrateGranuleRecord(testGranule, knex);
  await granulesModel.create(testGranule);

  t.teardown(() => {
    granulesModel.delete(testGranule);
  });

  const migrationSummary = await migrateGranulesAndFiles(process.env, knex);
  t.deepEqual(migrationSummary, {
    filesSummary: {
      dynamoRecords: 1,
      failed: 0,
      skipped: 0,
      success: 0,
    },
    granulesSummary: {
      dynamoRecords: 1,
      failed: 0,
      skipped: 1,
      success: 0,
    },
  });

  const records = await knex(tableNames.granules);
  t.is(records.length, 1);
});

test.serial('migrateGranulesAndFiles processes multiple granules and files', async (t) => {
  const {
    knex,
    testCollection,
    testExecution,
    testGranule,
  } = t.context;

  const testGranule1 = testGranule;

  const testGranule2 = generateTestGranule({
    collectionId: buildCollectionId(testCollection.name, testCollection.version),
    execution: testExecution.url,
  });

  await Promise.all([
    granulesModel.create(testGranule1),
    granulesModel.create(testGranule2),
  ]);

  t.teardown(async () => {
    granulesModel.delete({ granuleId: testGranule1.granuleId });
    granulesModel.delete({ granuleId: testGranule2.granuleId });
  });

  const migrationSummary = await migrateGranulesAndFiles(process.env, knex);
  t.deepEqual(migrationSummary, {
    filesSummary: {
      dynamoRecords: 2,
      failed: 0,
      skipped: 0,
      success: 2,
    },
    granulesSummary: {
      dynamoRecords: 2,
      failed: 0,
      skipped: 0,
      success: 2,
    },
  });
  const records = await knex(tableNames.granules);
  const fileRecords = await knex(tableNames.files);
  t.is(records.length, 2);
  t.is(fileRecords.length, 2);
});

test.serial('migrateGranulesAndFiles processes all non-failing granule records and does not process files of failing granule records', async (t) => {
  const {
    knex,
    testCollection,
    testExecution,
    testGranule,
  } = t.context;

  const testGranule2 = generateTestGranule({
    collectionId: buildCollectionId(testCollection.name, testCollection.version),
    execution: testExecution.url,
  });

  // remove required field so record will fail
  delete testGranule.collectionId;

  await Promise.all([
    dynamodbDocClient().put({
      TableName: process.env.GranulesTable,
      Item: testGranule,
    }).promise(),
    granulesModel.create(testGranule2),
  ]);

  t.teardown(async () => {
    granulesModel.delete({ granuleId: testGranule.granuleId });
    granulesModel.delete({ granuleId: testGranule2.granuleId });
  });

  const migrationSummary = await migrateGranulesAndFiles(process.env, knex);
  t.deepEqual(migrationSummary, {
    filesSummary: {
      dynamoRecords: 2,
      failed: 1,
      skipped: 0,
      success: 1,
    },
    granulesSummary: {
      dynamoRecords: 2,
      failed: 1,
      skipped: 0,
      success: 1,
    },
  });
  const records = await knex(tableNames.granules);
  const fileRecords = await knex(tableNames.files);
  t.is(records.length, 1);
  t.is(fileRecords.length, 1);
});