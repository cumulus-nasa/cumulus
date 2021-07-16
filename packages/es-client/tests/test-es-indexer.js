'use strict';

const test = require('ava');
const rewire = require('rewire');
const awsServices = require('@cumulus/aws-client/services');
const s3Utils = require('@cumulus/aws-client/S3');
const { randomString, randomId } = require('@cumulus/common/test-utils');
const { IndexExistsError } = require('@cumulus/errors');
const { constructCollectionId } = require('@cumulus/message/Collections');

const indexer = rewire('../indexer');
const { Search } = require('../search');

const { bootstrapElasticSearch } = require('../bootstrap');

const esIndex = randomString();

process.env.system_bucket = randomString();
process.env.stackName = randomString();

let esClient;

test.before(async (t) => {
  // create the tables
  t.context.esAlias = randomString();
  process.env.ES_INDEX = t.context.esAlias;

  // create the elasticsearch index and add mapping
  await bootstrapElasticSearch('fakehost', esIndex, t.context.esAlias);
  esClient = await Search.es();
  // create bucket
  await awsServices.s3().createBucket({ Bucket: process.env.system_bucket }).promise();
});

test.after.always(async () => {
  await esClient.indices.delete({ index: esIndex });
  await s3Utils.recursivelyDeleteS3Bucket(process.env.system_bucket);
});

test.serial('deleteGranule deletes granule record and creates deletedgranule record', async (t) => {
  const { esAlias } = t.context;

  const granuleType = 'granule';
  const granule = {
    granuleId: randomString(),
  };
  const collection = {
    name: randomString(),
    version: 1,
  };
  const collectionId = constructCollectionId(collection.name, collection.version);
  granule.collectionId = collectionId;

  // create granule record
  let r = await indexer.indexGranule(esClient, granule, esAlias, granuleType);
  t.is(r.result, 'created');

  const esGranulesClient = new Search(
    {},
    granuleType,
    esAlias
  );
  t.true(await esGranulesClient.exists(granule.granuleId, collectionId, granuleType));

  r = await indexer.deleteGranule({
    esClient,
    granuleId: granule.granuleId,
    type: granuleType,
    collectionId,
    index: esAlias,
  });
  t.is(r.result, 'deleted');
  t.false(await esGranulesClient.exists(granule.granuleId, collectionId, granuleType));

  // the deletedgranule record is added
  const deletedGranParams = {
    index: esAlias,
    type: 'deletedgranule',
    id: granule.granuleId,
    parent: collectionId,
  };

  let deletedRecord = await esClient.get(deletedGranParams)
    .then((response) => response.body);
  t.true(deletedRecord.found);
  t.deepEqual(deletedRecord._source.files, granule.files);
  t.is(deletedRecord._parent, collectionId);
  t.is(deletedRecord._id, granule.granuleId);
  t.truthy(deletedRecord._source.deletedAt);

  // the deletedgranule deletedRecord is removed if the granule is ingested again
  r = await indexer.indexGranule(esClient, granule, esAlias, granuleType);
  t.is(r.result, 'created');
  deletedRecord = await esClient.get(deletedGranParams, { ignore: [404] })
    .then((response) => response.body);
  t.false(deletedRecord.found);
});

test.serial('creating multiple deletedgranule records and retrieving them', async (t) => {
  const { esAlias } = t.context;

  const granuleIds = [];
  const granules = [];
  const collectionId = constructCollectionId(randomString(), 1);

  for (let i = 0; i < 11; i += 1) {
    const newgran = {
      granuleId: randomString(),
      collectionId,
    };
    granules.push(newgran);
    granuleIds.push(newgran.granuleId);
  }

  // add the records
  let response = await Promise.all(granules.map((g) => indexer.indexGranule(esClient, g, esAlias)));
  t.is(response.length, 11);
  await esClient.indices.refresh();

  // now delete the records
  response = await Promise.all(granules
    .map((g) => indexer
      .deleteGranule({
        esClient,
        granuleId: g.granuleId,
        type: 'granule',
        collectionId: g.collectionId,
        index: esAlias,
      })));
  t.is(response.length, 11);
  response.forEach((r) => t.is(r.result, 'deleted'));

  await esClient.indices.refresh();

  // retrieve deletedgranule records which are deleted within certain range
  // and are from a given collection
  const deletedGranParams = {
    index: esAlias,
    type: 'deletedgranule',
    body: {
      query: {
        bool: {
          must: [
            {
              range: {
                deletedAt: {
                  gte: 'now-1d',
                  lte: 'now+1s',
                },
              },
            },
            {
              parent_id: {
                type: 'deletedgranule',
                id: collectionId,
              },
            }],
        },
      },
    },
  };

  response = await esClient.search(deletedGranParams)
    .then((searchResponse) => searchResponse.body);
  t.is(response.hits.total, 11);
  response.hits.hits.forEach((r) => {
    t.is(r._parent, collectionId);
    t.true(granuleIds.includes(r._source.granuleId));
  });
});

test.serial('indexing a rule record', async (t) => {
  const { esAlias } = t.context;

  const testRecord = {
    name: randomString(),
  };

  const r = await indexer.indexRule(esClient, testRecord, esAlias);

  // make sure record is created
  t.is(r.result, 'created');

  // check the record exists
  const record = await esClient.get({
    index: esAlias,
    type: 'rule',
    id: testRecord.name,
  }).then((response) => response.body);

  t.is(record._id, testRecord.name);
  t.is(typeof record._source.timestamp, 'number');
});

test.serial('indexing a provider record', async (t) => {
  const { esAlias } = t.context;

  const testRecord = {
    id: randomString(),
  };

  const r = await indexer.indexProvider(esClient, testRecord, esAlias);

  // make sure record is created
  t.is(r.result, 'created');

  // check the record exists
  const record = await esClient.get({
    index: esAlias,
    type: 'provider',
    id: testRecord.id,
  }).then((response) => response.body);

  t.is(record._id, testRecord.id);
  t.is(typeof record._source.timestamp, 'number');
});

test.serial('indexing a collection record', async (t) => {
  const { esAlias } = t.context;

  const collection = {
    name: randomString(),
    version: '001',
  };

  const collectionId = constructCollectionId(collection.name, collection.version);
  const r = await indexer.indexCollection(esClient, collection, esAlias);

  // make sure record is created
  t.is(r.result, 'created');

  // check the record exists
  const record = await esClient.get({
    index: esAlias,
    type: 'collection',
    id: collectionId,
  }).then((response) => response.body);

  t.is(record._id, collectionId);
  t.is(record._source.name, collection.name);
  t.is(record._source.version, collection.version);
  t.is(typeof record._source.timestamp, 'number');
});

test.serial('indexing collection records with different versions', async (t) => {
  const { esAlias } = t.context;

  const name = randomString();
  /* eslint-disable no-await-in-loop */
  for (let i = 1; i < 11; i += 1) {
    const version = `00${i}`;
    const key = `key${i}`;
    const value = `value${i}`;
    const collection = {
      name: name,
      version: version,
      [`${key}`]: value,
    };

    const r = await indexer.indexCollection(esClient, collection, esAlias);
    // make sure record is created
    t.is(r.result, 'created');
  }
  /* eslint-enable no-await-in-loop */

  await esClient.indices.refresh();
  // check each record exists and is not affected by other collections
  for (let i = 1; i < 11; i += 1) {
    const version = `00${i}`;
    const key = `key${i}`;
    const value = `value${i}`;
    const collectionId = constructCollectionId(name, version);
    const record = await esClient.get({ // eslint-disable-line no-await-in-loop
      index: esAlias,
      type: 'collection',
      id: collectionId,
    }).then((response) => response.body);

    t.is(record._id, collectionId);
    t.is(record._source.name, name);
    t.is(record._source.version, version);
    t.is(record._source[key], value);
    t.is(typeof record._source.timestamp, 'number');
  }
});

test.serial('updating a collection record', async (t) => {
  const { esAlias } = t.context;

  const collection = {
    name: randomString(),
    version: '001',
    anyObject: {
      key: 'value',
      key1: 'value1',
      key2: 'value2',
    },
    anyKey: 'anyValue',
  };

  // updatedCollection has some parameters removed
  const updatedCollection = {
    name: collection.name,
    version: '001',
    anyparams: {
      key1: 'value1',
    },
  };

  const collectionId = constructCollectionId(collection.name, collection.version);
  let r = await indexer.indexCollection(esClient, collection, esAlias);

  // make sure record is created
  t.is(r.result, 'created');

  // update the collection record
  r = await indexer.indexCollection(esClient, updatedCollection, esAlias);
  t.is(r.result, 'updated');

  // check the record exists
  const record = await esClient.get({
    index: esAlias,
    type: 'collection',
    id: collectionId,
  }).then((response) => response.body);

  t.is(record._id, collectionId);
  t.is(record._source.name, updatedCollection.name);
  t.is(record._source.version, updatedCollection.version);
  t.deepEqual(record._source.anyparams, updatedCollection.anyparams);
  t.is(record._source.anyKey, undefined);
  t.is(typeof record._source.timestamp, 'number');
});

test.serial('delete a provider record', async (t) => {
  const { esAlias } = t.context;

  const id = randomString();
  const testRecord = {
    id,
  };
  const type = 'provider';

  let r = await indexer.indexProvider(esClient, testRecord, esAlias, type);

  // make sure record is created
  t.is(r.result, 'created');
  t.is(r._id, testRecord.id);
  const esProvidersClient = new Search(
    {},
    'provider',
    process.env.ES_INDEX
  );
  t.true(await esProvidersClient.exists(id));

  r = await indexer.deleteProvider({
    esClient,
    id: testRecord.id,
    index: esAlias,
  });

  t.is(r.result, 'deleted');

  await t.throwsAsync(
    () => esClient.get({ index: esAlias, type, id: testRecord.id }),
    { message: 'Response Error' }
  );
  t.false(await esProvidersClient.exists(id));
});

test.serial('deleteExecution deletes an execution record', async (t) => {
  const { esAlias } = t.context;

  const testRecord = {
    arn: randomString(),
  };
  const type = 'execution';

  await indexer.indexExecution(esClient, testRecord, esAlias, type);

  const esExecutionsClient = new Search(
    {},
    type,
    esAlias
  );
  t.true(await esExecutionsClient.exists(testRecord.arn));

  await indexer.deleteExecution({
    esClient,
    arn: testRecord.arn,
    type,
    index: esAlias,
  });

  t.false(await esExecutionsClient.exists(testRecord.arn));
});

test.serial('deleteAsyncOperation deletes an async operation record', async (t) => {
  const { esAlias } = t.context;

  const testRecord = {
    id: randomString(),
  };
  const type = 'asyncOperation';

  let r = await indexer.indexAsyncOperation(esClient, testRecord, esAlias, type);

  // make sure record is created
  t.is(r.result, 'created');
  t.is(r._id, testRecord.id);
  const esAsyncOperationsClient = new Search(
    {},
    'asyncOperation',
    esAlias
  );
  t.true(await esAsyncOperationsClient.exists(testRecord.id));

  r = await indexer.deleteAsyncOperation({
    esClient,
    id: testRecord.id,
    type,
    index: esAlias,
  });

  t.is(r.result, 'deleted');
  t.false(await esAsyncOperationsClient.exists(testRecord.id));
});

test.serial('deleteReconciliationReport deletes a reconciliation report record', async (t) => {
  const { esAlias } = t.context;

  const testRecord = {
    name: randomString(),
  };
  const type = 'reconciliationReport';

  let r = await indexer.indexReconciliationReport(esClient, testRecord, esAlias, type);

  // make sure record is created
  t.is(r.result, 'created');
  t.is(r._id, testRecord.name);

  r = await indexer.deleteReconciliationReport({
    esClient,
    name: testRecord.name,
    type,
    index: esAlias,
  });

  t.is(r.result, 'deleted');

  await t.throwsAsync(
    () => esClient.get({ index: esAlias, type, id: testRecord.name }),
    { message: 'Response Error' }
  );
});

test.serial('indexing a granule record', async (t) => {
  const { esAlias } = t.context;

  const granule = {
    granuleId: randomString(),
    collectionId: `${randomString}___1`,
  };

  await indexer.indexGranule(esClient, granule, esAlias);

  // test granule record is added
  const record = await esClient.get({
    index: esAlias,
    type: 'granule',
    id: granule.granuleId,
    parent: granule.collectionId,
  }).then((response) => response.body);
  t.is(record._id, granule.granuleId);
});

test.serial('indexing a PDR record', async (t) => {
  const { esAlias } = t.context;

  const pdr = {
    pdrName: randomString(),
  };

  // fake pdr index to elasticsearch (this is done in a lambda function)
  await indexer.indexPdr(esClient, pdr, esAlias);

  // test granule record is added
  const record = await esClient.get({
    index: esAlias,
    type: 'pdr',
    id: pdr.pdrName,
  }).then((response) => response.body);
  t.is(record._id, pdr.pdrName);
  t.falsy(record._source.error);
});

test.serial('updateAsyncOperation updates an async operation record', async (t) => {
  const { esAlias } = t.context;

  const id = randomString();
  const asyncOperation = {
    id,
    status: 'RUNNING',
  };

  await indexer.indexAsyncOperation(esClient, asyncOperation, esAlias);

  const record = await esClient.get({
    index: esAlias,
    type: 'asyncOperation',
    id,
  }).then((response) => response.body);
  t.is(record._source.status, 'RUNNING');

  await indexer.updateAsyncOperation(
    esClient,
    id,
    {
      status: 'SUCCEEDED',
    },
    esAlias
  );

  const updatedRecord = await esClient.get({
    index: esAlias,
    type: 'asyncOperation',
    id,
  }).then((response) => response.body);
  t.is(updatedRecord._source.status, 'SUCCEEDED');
});

test.serial('deleting a collection record', async (t) => {
  const { esAlias } = t.context;

  const collection = {
    name: randomString(),
    version: '001',
  };

  const collectionId = constructCollectionId(collection.name, collection.version);
  const r = await indexer.indexCollection(esClient, collection, esAlias);

  // make sure record is created
  t.is(r.result, 'created');

  // check the record exists
  const esCollectionsClient = new Search(
    {},
    'collection',
    esAlias
  );
  t.true(await esCollectionsClient.exists(collectionId));

  await indexer.deleteCollection({
    esClient,
    collectionId,
    index: esAlias,
  });
  t.false(await esCollectionsClient.exists(collectionId));
});

test.serial('deleting a rule record', async (t) => {
  const { esAlias } = t.context;
  const name = randomString();
  const testRecord = {
    name,
  };

  await indexer.indexRule(esClient, testRecord, esAlias);

  // check the record exists
  const esRulesClient = new Search(
    {},
    'rule',
    esAlias
  );
  t.true(await esRulesClient.exists(name));

  await indexer.deleteRule({
    esClient,
    name,
    index: esAlias,
  });
  t.false(await esRulesClient.exists(name));
});

test.serial('deleting a PDR record', async (t) => {
  const { esAlias } = t.context;

  const pdrName = randomString();
  const pdr = {
    pdrName,
  };

  // fake pdr index to elasticsearch (this is done in a lambda function)
  await indexer.indexPdr(esClient, pdr, esAlias);

  // check the record exists
  const esPdrsClient = new Search(
    {},
    'pdr',
    esAlias
  );
  t.true(await esPdrsClient.exists(pdrName));

  await indexer.deletePdr({
    esClient,
    name: pdrName,
    index: esAlias,
  });
  t.false(await esPdrsClient.exists(pdrName));
});

test.serial('Create new index', async (t) => {
  const newIndex = randomId('esindex');

  await indexer.createIndex(esClient, newIndex);

  try {
    const indexExists = await esClient.indices.exists({ index: newIndex })
      .then((response) => response.body);

    t.true(indexExists);
  } finally {
    await esClient.indices.delete({ index: newIndex });
  }
});

test.serial('Create new index - index already exists', async (t) => {
  const newIndex = randomId('esindex');

  await indexer.createIndex(esClient, newIndex);

  await t.throwsAsync(
    indexer.createIndex(esClient, newIndex),
    {
      instanceOf: IndexExistsError,
      message: `Index ${newIndex} exists and cannot be created.`,
    }
  );

  await esClient.indices.delete({ index: newIndex });
});

test.serial('Create new index with number of shards env var set', async (t) => {
  const newIndex = randomId('esindex');

  process.env.ES_INDEX_SHARDS = 4;

  try {
    await indexer.createIndex(esClient, newIndex);

    const indexSettings = await esClient.indices.get({ index: newIndex })
      .then((response) => response.body);

    t.is(indexSettings[newIndex].settings.index.number_of_shards, '4');
  } finally {
    delete process.env.ES_INDEX_SHARDS;
    await esClient.indices.delete({ index: newIndex });
  }
});
