'use strict';

const test = require('ava');
const rewire = require('rewire');
const attr = require('dynamodb-data-types').AttributeValue;
const awsServices = require('@cumulus/aws-client/services');
const { recursivelyDeleteS3Bucket } = require('@cumulus/aws-client/S3');
const { constructCollectionId } = require('@cumulus/message/Collections');
const { randomString } = require('@cumulus/common/test-utils');
const { bootstrapElasticSearch } = require('@cumulus/es-client/bootstrap');
const { Search } = require('@cumulus/es-client/search');

const models = require('../../models');
const dbIndexer = rewire('../../lambdas/db-indexer');
const {
  fakeCollectionFactory,
  fakeGranuleFactoryV2,
  fakeExecutionFactory,
  fakeFileFactory,
  fakeProviderFactory,
} = require('../../lib/testUtils');
const GranuleFilesCache = require('../../lib/GranuleFilesCache');

const {
  getTableName,
  getTableIndexDetails,
  handler,
  getParentId,
  getRecordId,
  performDelete,
  performIndex,
} = dbIndexer;

let esClient;
const esIndex = randomString();
process.env.stackName = randomString();
process.env.system_bucket = randomString();
process.env.CollectionsTable = randomString();
process.env.ExecutionsTable = randomString();
process.env.FilesTable = randomString();
process.env.GranulesTable = randomString();
process.env.PdrsTable = randomString();
process.env.ProvidersTable = randomString();
process.env.RulesTable = randomString();

const buildDynamoStreamRecord = ({
  eventName, tableName, keys, oldImage, newImage,
}) => {
  const record = {
    eventID: '1',
    eventName,
    eventVersion: '1.0',
    eventSource: 'aws:dynamodb',
    awsRegion: 'us-east-1',
    eventSourceARN: `arn:aws:dynamodb:us-east-1:account-id:table/${tableName}/stream/2015-06-27T00:48:05.899`,
    dynamodb: {
      Keys: attr.wrap(keys),
      SequenceNumber: '1',
      SizeBytes: eventName === 'REMOVE' ? -1 : 1,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    },
  };

  if (['INSERT', 'MODIFY'].includes(eventName)) {
    record.dynamodb.NewImage = attr.wrap(newImage);
  }

  if (['MODIFY', 'REMOVE'].includes(eventName)) {
    record.dynamodb.OldImage = attr.wrap(oldImage);
  }

  return record;
};

const buildCollectionRecord = ({ type, oldCollection, newCollection }) => {
  let keys;
  if (type === 'REMOVE') {
    keys = {
      name: oldCollection.name,
      version: oldCollection.version,
    };
  } else {
    keys = {
      name: newCollection.name,
      version: newCollection.version,
    };
  }

  return buildDynamoStreamRecord({
    eventName: type,
    tableName: process.env.CollectionsTable,
    keys,
    oldImage: oldCollection,
    newImage: newCollection,
  });
};

const buildExecutionRecord = ({ type, oldExecution, newExecution }) => {
  const arn = type === 'REMOVE' ? oldExecution.arn : newExecution.arn;

  return buildDynamoStreamRecord({
    eventName: type,
    tableName: process.env.ExecutionsTable,
    keys: { arn },
    oldImage: oldExecution,
    newImage: newExecution,
  });
};

const buildGranuleRecord = ({ type, oldGranule, newGranule }) => {
  const granuleId = type === 'REMOVE' ? oldGranule.granuleId : newGranule.granuleId;

  return buildDynamoStreamRecord({
    eventName: type,
    tableName: process.env.GranulesTable,
    keys: { granuleId },
    oldImage: oldGranule,
    newImage: newGranule,
  });
};

let collectionModel;
let executionModel;
let granuleModel;
let ruleModel;

test.before(async (t) => {
  await awsServices.s3().createBucket({ Bucket: process.env.system_bucket }).promise();

  // create tables
  collectionModel = new models.Collection();
  granuleModel = new models.Granule();
  executionModel = new models.Execution();
  ruleModel = new models.Rule();

  await Promise.all([
    collectionModel.createTable(),
    executionModel.createTable(),
    granuleModel.createTable(),
    ruleModel.createTable(),
  ]);

  // bootstrap the esIndex
  esClient = await Search.es();

  t.context.esAlias = randomString();
  process.env.ES_INDEX = t.context.esAlias;

  await bootstrapElasticSearch('fakehost', esIndex, t.context.esAlias);
});

test.after.always(async () => {
  await collectionModel.deleteTable();
  await granuleModel.deleteTable();
  await executionModel.deleteTable();
  await ruleModel.deleteTable();

  await recursivelyDeleteS3Bucket(process.env.system_bucket);
  await esClient.indices.delete({ index: esIndex });
});

test('getRecordId() returns correct ID for collection record', (t) => {
  const collection = {
    name: randomString(),
    version: '0.0.0',
  };
  t.is(
    getRecordId('collection', collection),
    constructCollectionId(collection.name, collection.version)
  );
});

test('getRecordId() returns correct ID for non-collection record', (t) => {
  const execution = {
    arn: randomString(),
  };
  t.is(
    getRecordId('execution', execution),
    execution.arn
  );
});

test('getParentId() returns correct ID for granule record', (t) => {
  const granule = {
    collectionId: randomString(),
  };
  t.is(getParentId('granule', granule), granule.collectionId);
});

test('getParentId() returns null for non-granule record', (t) => {
  t.is(getParentId('collection', {}), undefined);
});

test('getTableName() returns undefined for invalid input', (t) => {
  t.is(
    getTableName('bad-input'),
    undefined
  );
});

test('getTableName() returns the full name of the DynamoDB table associated with the incoming record', (t) => {
  const tableName = randomString();
  const eventSourceARN = `arn:aws:dynamodb:us-east-1:account-id:table/${tableName}/stream/2015-06-27T00:48:05.899`;
  t.is(getTableName(eventSourceARN), tableName);
});

test('getTableIndexDetails() returns undefined for unsupported table', (t) => {
  t.is(getTableIndexDetails('fake-table-name'), undefined);
  t.is(getTableIndexDetails(GranuleFilesCache.cacheTableName()), undefined);
});

test('getTableIndexDetails() returns the correct function name and index type', (t) => {
  t.deepEqual(getTableIndexDetails(process.env.CollectionsTable), {
    deleteFnName: 'deleteCollection',
    indexFnName: 'indexCollection',
    indexType: 'collection',
  });
});

test('performIndex() indexes a record to ES', async (t) => {
  const { esAlias } = t.context;
  const providerIndex = new Search({}, 'provider', esAlias);
  const provider = fakeProviderFactory();
  await performIndex('indexProvider', esClient, provider);
  const indexedRecord = await providerIndex.get(provider.id);
  // delete dynamically generated values for comparisons
  delete indexedRecord._id;
  delete indexedRecord.timestamp;
  t.deepEqual(indexedRecord, provider);
});

test('performDelete() deletes a record from ES', async (t) => {
  const { esAlias } = t.context;
  const providerIndex = new Search({}, 'provider', esAlias);
  const provider = fakeProviderFactory();

  await performIndex('indexProvider', esClient, provider);
  const indexedRecord = await providerIndex.get(provider.id);
  t.is(indexedRecord.id, provider.id);

  await performDelete('deleteProvider', esClient, 'provider', provider.id);
  const deletedRecord = await providerIndex.get(provider.id);
  t.is(deletedRecord.detail, 'Record not found');
});

test.serial('create, update and delete a collection in DynamoDB and ES', async (t) => {
  const { esAlias } = t.context;

  const c = fakeCollectionFactory();

  const insertRecord = buildCollectionRecord({
    type: 'INSERT',
    newCollection: c,
  });

  // fake the lambda trigger
  await handler({ Records: [insertRecord] });

  const collectionIndex = new Search({}, 'collection', esAlias);
  let indexedRecord = await collectionIndex.get(constructCollectionId(c.name, c.version));

  t.is(indexedRecord.name, c.name);

  // change the record
  const modifyRecord = buildCollectionRecord({
    type: 'MODIFY',
    oldCollection: c,
    newCollection: { ...c, dataType: 'testing' },
  });

  // fake the lambda trigger
  await handler({ Records: [modifyRecord] });

  indexedRecord = await collectionIndex.get(constructCollectionId(c.name, c.version));
  t.is(indexedRecord.dataType, 'testing');

  // delete the record
  const removeRecord = buildCollectionRecord({
    type: 'REMOVE',
    oldCollection: { ...c, dataType: 'testing' },
  });

  // fake the lambda trigger
  await handler({ Records: [removeRecord] });

  const response = await collectionIndex.get(constructCollectionId(c.name, c.version));
  t.is(response.detail, 'Record not found');
});

test.serial('create, update and delete a granule in DynamoDB and ES', async (t) => {
  const { esAlias } = t.context;

  const fakeFile = fakeFileFactory();
  const fakeGranule = fakeGranuleFactoryV2({ files: [fakeFile] });

  const insertRecord = buildGranuleRecord({
    type: 'INSERT',
    newGranule: fakeGranule,
  });

  // fake the lambda trigger
  await handler({ Records: [insertRecord] });

  const granuleIndex = new Search({}, 'granule', esAlias);
  let indexedRecord = await granuleIndex.get(fakeGranule.granuleId);

  t.is(indexedRecord.granuleId, fakeGranule.granuleId);

  // change the record
  const modifyRecord = buildGranuleRecord({
    type: 'MODIFY',
    oldGranule: fakeGranule,
    newGranule: { ...fakeGranule, status: 'failed' },
  });

  // fake the lambda trigger
  await handler({ Records: [modifyRecord] });

  indexedRecord = await granuleIndex.get(fakeGranule.granuleId);
  t.is(indexedRecord.status, 'failed');

  // delete the record
  const removeRecord = buildGranuleRecord({
    type: 'REMOVE',
    oldGranule: { ...fakeGranule, status: 'failed' },
  });

  // fake the lambda trigger
  await handler({ Records: [removeRecord] });

  indexedRecord = await granuleIndex.get(fakeGranule.granuleId);
  t.is(indexedRecord.detail, 'Record not found');

  const deletedGranIndex = new Search({}, 'deletedgranule', esAlias);
  const deletedGranRecord = await deletedGranIndex.get(fakeGranule.granuleId);
  t.is(deletedGranRecord.granuleId, fakeGranule.granuleId);
});

test.serial('create, update and delete an execution in DynamoDB and es', async (t) => {
  const { esAlias } = t.context;

  const fakeRecord = fakeExecutionFactory();

  const insertRecord = buildExecutionRecord({
    type: 'INSERT',
    newExecution: fakeRecord,
  });

  // fake the lambda trigger
  await handler({ Records: [insertRecord] });

  const recordIndex = new Search({}, 'execution', esAlias);
  let indexedRecord = await recordIndex.get(fakeRecord.arn);

  t.is(indexedRecord.arn, fakeRecord.arn);

  // change the record
  const modifyRecord = buildExecutionRecord({
    type: 'MODIFY',
    oldExecution: fakeRecord,
    newExecution: { ...fakeRecord, status: 'failed' },
  });

  // fake the lambda trigger
  await handler({ Records: [modifyRecord] });

  indexedRecord = await recordIndex.get(fakeRecord.arn);
  t.is(indexedRecord.status, 'failed');

  // delete the record
  const removeRecord = buildExecutionRecord({
    type: 'REMOVE',
    oldExecution: { ...fakeRecord, status: 'failed' },
  });

  // fake the lambda trigger
  await handler({ Records: [removeRecord] });

  indexedRecord = await recordIndex.get(fakeRecord.arn);
  t.is(indexedRecord.detail, 'Record not found');
});

test.serial('The db-indexer does not throw an exception when execution fails', async (t) => {
  const insertRecord = buildExecutionRecord({
    type: 'INSERT',
    newExecution: fakeExecutionFactory(),
  });

  // fake the lambda trigger
  await t.notThrowsAsync(
    dbIndexer.__with__({
      indexer: {
        indexExecution: () => Promise.reject(new Error('oh no')),
      },
    })(() => handler({ Records: [insertRecord] }))
  );
});
