'use strict';

const request = require('supertest');
const test = require('ava');
const get = require('lodash/get');
const sinon = require('sinon');

const {
  localStackConnectionEnv,
  generateLocalTestDb,
  destroyLocalTestDb,
} = require('@cumulus/db');
const asyncOperations = require('@cumulus/async-operations');
const awsServices = require('@cumulus/aws-client/services');
const {
  recursivelyDeleteS3Bucket,
} = require('@cumulus/aws-client/S3');
const { randomString, randomId } = require('@cumulus/common/test-utils');
const { EcsStartTaskError, IndexExistsError } = require('@cumulus/errors');
const { bootstrapElasticSearch } = require('@cumulus/es-client/bootstrap');
const { Search, defaultIndexAlias } = require('@cumulus/es-client/search');
const mappings = require('@cumulus/es-client/config/mappings.json');

const { migrationDir } = require('../../../../lambdas/db-migration');
const models = require('../../models');
const assertions = require('../../lib/assertions');
const {
  createFakeJwtAuthToken,
  setAuthorizedOAuthUsers,
} = require('../../lib/testUtils');

const esIndex = randomString();

process.env.AccessTokensTable = randomString();
process.env.AsyncOperationsTable = randomString();
process.env.TOKEN_SECRET = randomString();
process.env.stackName = randomString();
process.env.system_bucket = randomString();

// import the express app after setting the env variables
const { app } = require('../../app');
const { indexFromDatabase } = require('../../endpoints/elasticsearch');

let jwtAuthToken;
let accessTokenModel;
let asyncOperationsModel;
let esClient;

/**
 * Index fake data
 *
 * @returns {undefined} - none
 */
async function indexData() {
  const rules = [
    { name: 'Rule1' },
    { name: 'Rule2' },
    { name: 'Rule3' },
  ];

  await Promise.all(rules.map(async (rule) => {
    await esClient.index({
      index: esIndex,
      type: 'rule',
      id: rule.name,
      body: rule,
    });
  }));

  await esClient.indices.refresh();
}

/**
 * Create and alias index by going through ES bootstrap
 *
 * @param {string} indexName - index name
 * @param {string} aliasName  - alias name
 * @returns {undefined} - none
 */
async function createIndex(indexName, aliasName) {
  await bootstrapElasticSearch('fakehost', indexName, aliasName);
  esClient = await Search.es();
}

const testDbName = randomId('elasticsearch');

test.before(async (t) => {
  await awsServices.s3().createBucket({ Bucket: process.env.system_bucket }).promise();

  const username = randomString();
  await setAuthorizedOAuthUsers([username]);

  accessTokenModel = new models.AccessToken();
  await accessTokenModel.createTable();

  asyncOperationsModel = new models.AsyncOperation({
    stackName: process.env.stackName,
    systemBucket: process.env.system_bucket,
    tableName: process.env.AsyncOperationsTable,
  });
  await asyncOperationsModel.createTable();

  jwtAuthToken = await createFakeJwtAuthToken({ accessTokenModel, username });

  t.context.esAlias = randomString();
  process.env.ES_INDEX = t.context.esAlias;
  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
    PG_DATABASE: testDbName,
  };

  const { knex, knexAdmin } = await generateLocalTestDb(testDbName, migrationDir);
  t.context.testKnex = knex;
  t.context.testKnexAdmin = knexAdmin;

  // create the elasticsearch index and add mapping
  await createIndex(esIndex, t.context.esAlias);

  await indexData();
});

test.after.always(async (t) => {
  await accessTokenModel.deleteTable();
  await asyncOperationsModel.deleteTable();
  await esClient.indices.delete({ index: esIndex });
  await destroyLocalTestDb({
    knex: t.context.testKnex,
    knexAdmin: t.context.testKnexAdmin,
    testDbName,
  });
  await recursivelyDeleteS3Bucket(process.env.system_bucket);
});

test('PUT snapshot without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .post('/elasticsearch/create-snapshot')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test('PUT snapshot with an invalid access token returns an unauthorized response', async (t) => {
  const response = await request(app)
    .post('/elasticsearch/create-snapshot')
    .set('Accept', 'application/json')
    .set('Authorization', 'Bearer ThisIsAnInvalidAuthorizationToken')
    .expect(401);

  assertions.isInvalidAccessTokenResponse(t, response);
});

test.serial('Reindex - multiple aliases found', async (t) => {
  // Prefixes for error message predictability
  const indexName = `z-${randomString()}`;
  const otherIndexName = `a-${randomString()}`;

  const aliasName = randomString();

  await esClient.indices.create({
    index: indexName,
    body: { mappings },
  });

  await esClient.indices.putAlias({
    index: indexName,
    name: aliasName,
  });

  await esClient.indices.create({
    index: otherIndexName,
    body: { mappings },
  });

  await esClient.indices.putAlias({
    index: otherIndexName,
    name: aliasName,
  });

  const response = await request(app)
    .post('/elasticsearch/reindex')
    .send({ aliasName })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.body.message, `Multiple indices found for alias ${aliasName}. Specify source index as one of [${otherIndexName}, ${indexName}].`);

  await esClient.indices.delete({ index: indexName });
  await esClient.indices.delete({ index: otherIndexName });
});

test.serial('Reindex - specify a source index that does not exist', async (t) => {
  const { esAlias } = t.context;

  const response = await request(app)
    .post('/elasticsearch/reindex')
    .send({ aliasName: esAlias, sourceIndex: 'source-index' })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.body.message, 'Source index source-index does not exist.');
});

test.serial('Reindex - specify a source index that is not aliased', async (t) => {
  const { esAlias } = t.context;
  const indexName = 'source-index';
  const destIndex = randomString();

  await esClient.indices.create({
    index: indexName,
    body: { mappings },
  });

  const response = await request(app)
    .post('/elasticsearch/reindex')
    .send({
      aliasName: esAlias,
      sourceIndex: indexName,
      destIndex,
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.body.message, `Reindexing to ${destIndex} from ${indexName}. Check the reindex-status endpoint for status.`);

  // Check the reindex status endpoint to see if the operation has completed
  let statusResponse = await request(app)
    .get('/elasticsearch/reindex-status')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  /* eslint-disable no-await-in-loop */
  while (Object.keys(statusResponse.body.reindexStatus.nodes).length > 0) {
    statusResponse = await request(app)
      .get('/elasticsearch/reindex-status')
      .set('Authorization', `Bearer ${jwtAuthToken}`)
      .expect(200);
  }
  /* eslint-enable no-await-in-loop */

  await esClient.indices.delete({ index: indexName });
  await esClient.indices.delete({ index: destIndex });
});

test.serial('Reindex request returns 400 with the expected message when source index matches destination index.', async (t) => {
  const indexName = randomId('index');
  await esClient.indices.create({
    index: indexName,
    body: { mappings },
  });

  const response = await request(app)
    .post('/elasticsearch/reindex')
    .send({ destIndex: indexName, sourceIndex: indexName })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.body.message, `source index(${indexName}) and destination index(${indexName}) must be different.`);
  await esClient.indices.delete({ index: indexName });
});

test.serial('Reindex request returns 400 with the expected message when source index matches the default destination index.', async (t) => {
  const date = new Date();
  const defaultIndexName = `cumulus-${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;

  try {
    await createIndex(defaultIndexName);
  } catch (error) {
    if (!(error instanceof IndexExistsError)) throw error;
  }

  t.teardown(async () => {
    await esClient.indices.delete({ index: defaultIndexName });
  });

  const response = await request(app)
    .post('/elasticsearch/reindex')
    .send({ sourceIndex: defaultIndexName })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.body.message, `source index(${defaultIndexName}) and destination index(${defaultIndexName}) must be different.`);
});

test.serial('Reindex success', async (t) => {
  const { esAlias } = t.context;
  const destIndex = randomString();

  const response = await request(app)
    .post('/elasticsearch/reindex')
    .send({
      aliasName: esAlias,
      destIndex,
      sourceIndex: esIndex,
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.body.message, `Reindexing to ${destIndex} from ${esIndex}. Check the reindex-status endpoint for status.`);

  // Check the reindex status endpoint to see if the operation has completed
  let statusResponse = await request(app)
    .get('/elasticsearch/reindex-status')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  /* eslint-disable no-await-in-loop */
  while (Object.keys(statusResponse.body.reindexStatus.nodes).length > 0) {
    statusResponse = await request(app)
      .get('/elasticsearch/reindex-status')
      .set('Authorization', `Bearer ${jwtAuthToken}`)
      .expect(200);
  }
  /* eslint-enable no-await-in-loop */

  const indexStatus = statusResponse.body.indexStatus.indices[destIndex];

  t.is(3, indexStatus.primaries.docs.count);

  // Validate destination index mappings are correct
  const fieldMappings = await esClient.indices.getMapping()
    .then((mappingsResponse) => mappingsResponse.body);

  const sourceMapping = get(fieldMappings, esIndex);
  const destMapping = get(fieldMappings, destIndex);

  t.deepEqual(sourceMapping.mappings, destMapping.mappings);

  await esClient.indices.delete({ index: destIndex });
});

test.serial('Reindex - destination index exists', async (t) => {
  const { esAlias } = t.context;
  const destIndex = randomString();
  const newAlias = randomString();

  await createIndex(destIndex, newAlias);

  const response = await request(app)
    .post('/elasticsearch/reindex')
    .send({
      aliasName: esAlias,
      destIndex: destIndex,
      sourceIndex: esIndex,
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.body.message, `Reindexing to ${destIndex} from ${esIndex}. Check the reindex-status endpoint for status.`);

  // Check the reindex status endpoint to see if the operation has completed
  let statusResponse = await request(app)
    .get('/elasticsearch/reindex-status')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  /* eslint-disable no-await-in-loop */
  while (Object.keys(statusResponse.body.reindexStatus.nodes).length > 0) {
    statusResponse = await request(app)
      .get('/elasticsearch/reindex-status')
      .set('Authorization', `Bearer ${jwtAuthToken}`)
      .expect(200);
  }
  /* eslint-enable no-await-in-loop */

  await esClient.indices.delete({ index: destIndex });
});

test.serial('Reindex status, no task running', async (t) => {
  const response = await request(app)
    .get('/elasticsearch/reindex-status')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.deepEqual(response.body.reindexStatus, { nodes: {} });
});

test.serial('Change index - no current', async (t) => {
  const { esAlias } = t.context;

  const response = await request(app)
    .post('/elasticsearch/change-index')
    .send({
      aliasName: esAlias,
      newIndex: 'dest-index',
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.body.message, 'Please explicity specify a current and new index.');
});

test.serial('Change index - no new', async (t) => {
  const { esAlias } = t.context;

  const response = await request(app)
    .post('/elasticsearch/change-index')
    .send({
      aliasName: esAlias,
      currentIndex: 'source-index',
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.body.message, 'Please explicity specify a current and new index.');
});

test.serial('Change index - current index does not exist', async (t) => {
  const { esAlias } = t.context;

  const currentIndex = 'source-index';

  const response = await request(app)
    .post('/elasticsearch/change-index')
    .send({
      aliasName: esAlias,
      currentIndex,
      newIndex: 'dest-index',
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.body.message, `Current index ${currentIndex} does not exist.`);
});

test.serial('Change index - new index does not exist', async (t) => {
  const { esAlias } = t.context;

  const newIndex = 'dest-index';

  const response = await request(app)
    .post('/elasticsearch/change-index')
    .send({
      aliasName: esAlias,
      currentIndex: esIndex,
      newIndex,
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.body.message, `Change index success - alias ${esAlias} now pointing to ${newIndex}`);

  await esClient.indices.delete({ index: newIndex });
});

test.serial('Change index - current index same as new index', async (t) => {
  const { esAlias } = t.context;

  const response = await request(app)
    .post('/elasticsearch/change-index')
    .send({
      aliasName: esAlias,
      currentIndex: 'source',
      newIndex: 'source',
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.body.message, 'The current index cannot be the same as the new index.');
});

test.serial('Change index', async (t) => {
  const sourceIndex = randomString();
  const aliasName = randomString();
  const destIndex = randomString();

  await createIndex(sourceIndex, aliasName);

  await request(app)
    .post('/elasticsearch/reindex')
    .send({
      aliasName,
      sourceIndex,
      destIndex,
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const response = await request(app)
    .post('/elasticsearch/change-index')
    .send({
      aliasName,
      currentIndex: sourceIndex,
      newIndex: destIndex,
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.body.message,
    `Change index success - alias ${aliasName} now pointing to ${destIndex}`);

  const alias = await esClient.indices.getAlias({ name: aliasName })
    .then((aliasResponse) => aliasResponse.body);

  // Test that the only index connected to the alias is the destination index
  t.deepEqual(Object.keys(alias), [destIndex]);

  t.is((await esClient.indices.exists({ index: sourceIndex })).body, true);

  await esClient.indices.delete({ index: destIndex });
});

test.serial('Change index and delete source index', async (t) => {
  const sourceIndex = randomString();
  const aliasName = randomString();
  const destIndex = randomString();

  await createIndex(sourceIndex, aliasName);

  await request(app)
    .post('/elasticsearch/reindex')
    .send({
      aliasName,
      sourceIndex,
      destIndex,
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const response = await request(app)
    .post('/elasticsearch/change-index')
    .send({
      aliasName,
      currentIndex: sourceIndex,
      newIndex: destIndex,
      deleteSource: true,
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.body.message,
    `Change index success - alias ${aliasName} now pointing to ${destIndex} and index ${sourceIndex} deleted`);
  t.is((await esClient.indices.exists({ index: sourceIndex })).body, false);

  await esClient.indices.delete({ index: destIndex });
});

test.serial('Reindex from database - create new index', async (t) => {
  const indexName = randomString();
  const id = randomString();

  const stub = sinon.stub(asyncOperations, 'startAsyncOperation').resolves({ id });

  try {
    const response = await request(app)
      .post('/elasticsearch/index-from-database')
      .send({
        indexName,
      })
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${jwtAuthToken}`)
      .expect(200);

    t.is(response.body.message,
      `Indexing database to ${indexName}. Operation id: ${id}`);

    const indexExists = await esClient.indices.exists({ index: indexName })
      .then((indexResponse) => indexResponse.body);

    t.true(indexExists);
  } finally {
    await esClient.indices.delete({ index: indexName });
    stub.restore();
  }
});

test.serial('Indices status', async (t) => {
  const indexName = `z-${randomString()}`;
  const otherIndexName = `a-${randomString()}`;

  await esClient.indices.create({
    index: indexName,
    body: { mappings },
  });

  await esClient.indices.create({
    index: otherIndexName,
    body: { mappings },
  });

  const response = await request(app)
    .get('/elasticsearch/indices-status')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.true(response.text.includes(indexName));
  t.true(response.text.includes(otherIndexName));

  await esClient.indices.delete({ index: indexName });
  await esClient.indices.delete({ index: otherIndexName });
});

test.serial('Current index - default alias', async (t) => {
  const indexName = randomString();
  await createIndex(indexName, defaultIndexAlias);
  t.teardown(() => esClient.indices.delete({ index: indexName }));

  const response = await request(app)
    .get('/elasticsearch/current-index')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.true(response.body.includes(indexName));
});

test.serial('Current index - custom alias', async (t) => {
  const indexName = randomString();
  const customAlias = randomString();
  await createIndex(indexName, customAlias);

  const response = await request(app)
    .get(`/elasticsearch/current-index/${customAlias}`)
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.deepEqual(response.body, [indexName]);

  await esClient.indices.delete({ index: indexName });
});

test.serial('request to /elasticsearch/index-from-database endpoint returns 500 if starting ECS task throws unexpected error', async (t) => {
  const asyncOperationStartStub = sinon.stub(asyncOperations, 'startAsyncOperation').throws(
    new Error('failed to start')
  );

  try {
    const response = await request(app)
      .post('/elasticsearch/index-from-database')
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${jwtAuthToken}`)
      .send({});
    t.is(response.status, 500);
  } finally {
    asyncOperationStartStub.restore();
  }
});

test.serial('request to /elasticsearch/index-from-database endpoint returns 503 if starting ECS task throws unexpected error', async (t) => {
  const asyncOperationStartStub = sinon.stub(asyncOperations, 'startAsyncOperation').throws(
    new EcsStartTaskError('failed to start')
  );

  try {
    const response = await request(app)
      .post('/elasticsearch/index-from-database')
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${jwtAuthToken}`)
      .send({});
    t.is(response.status, 503);
  } finally {
    asyncOperationStartStub.restore();
  }
});

test.serial('indexFromDatabase request completes successfully', async (t) => {
  const fakeRequest = {
    body: {
      indexName: t.context.esAlias,
    },
    testContext: {
      // mock starting the ECS task
      startEcsTaskFunc: () => Promise.resolve({}),
    },
  };
  const fakeResponse = {
    send: sinon.stub(),
  };

  await t.notThrowsAsync(indexFromDatabase(fakeRequest, fakeResponse));
  t.true(fakeResponse.send.called);
});
