'use strict';

const test = require('ava');
const omit = require('lodash/omit');
const request = require('supertest');
const {
  createBucket,
  recursivelyDeleteS3Bucket,
  s3PutObject,
} = require('@cumulus/aws-client/S3');
const { randomId } = require('@cumulus/common/test-utils');
const {
  CollectionPgModel,
  destroyLocalTestDb,
  ExecutionPgModel,
  fakeCollectionRecordFactory,
  fakeGranuleRecordFactory,
  generateLocalTestDb,
  GranulePgModel,
  localStackConnectionEnv,
  translateApiExecutionToPostgresExecution,
  translatePostgresExecutionToApiExecution,
  upsertGranuleWithExecutionJoinRecord,
} = require('@cumulus/db');
const { bootstrapElasticSearch } = require('@cumulus/es-client/bootstrap');
const indexer = require('@cumulus/es-client/indexer');
const { Search } = require('@cumulus/es-client/search');
const { constructCollectionId } = require('@cumulus/message/Collections');
const { migrationDir } = require('../../../../lambdas/db-migration');
const { AccessToken, Collection, Execution, Granule } = require('../../models');
// Dynamo mock data factories
const {
  createFakeJwtAuthToken,
  fakeCollectionFactory,
  fakeGranuleFactoryV2,
  fakeExecutionFactoryV2,
  setAuthorizedOAuthUsers,
} = require('../../lib/testUtils');
const assertions = require('../../lib/assertions');

// create all the variables needed across this test
let accessTokenModel;
let collectionModel;
let collectionPgModel;
let esClient;
let esIndex;
let executionModel;
let executionPgModel;
let granuleModel;
let granulePgModel;
let jwtAuthToken;
const fakeExecutions = [];
process.env.AccessTokensTable = randomId('token');
process.env.CollectionsTable = randomId('collection');
process.env.ExecutionsTable = randomId('executions');
process.env.GranulesTable = randomId('granules');
process.env.stackName = randomId('stackname');
process.env.system_bucket = randomId('systembucket');
process.env.TOKEN_SECRET = randomId('secret');

const testDbName = randomId('execution_test');

// import the express app after setting the env variables
const { app } = require('../../app');

test.before(async (t) => {
  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
    PG_DATABASE: testDbName,
    METRICS_ES_HOST: 'fakehost',
    METRICS_ES_USER: randomId('metricsUser'),
    METRICS_ES_PASS: randomId('metricsPass'),
  };

  esIndex = randomId('esindex');
  t.context.esAlias = randomId('esAlias');
  process.env.ES_INDEX = t.context.esAlias;

  // create esClient
  esClient = await Search.es();

  // add fake elasticsearch index
  await bootstrapElasticSearch('fakehost', esIndex, t.context.esAlias);

  // create a fake bucket
  await createBucket(process.env.system_bucket);

  // create a workflow template file
  const tKey = `${process.env.stackName}/workflow_template.json`;
  await s3PutObject({
    Bucket: process.env.system_bucket,
    Key: tKey,
    Body: '{}',
  });

  // Generate a local test postGres database

  const { knex, knexAdmin } = await generateLocalTestDb(
    testDbName,
    migrationDir
  );
  t.context.knex = knex;
  t.context.knexAdmin = knexAdmin;

  // create fake Collections table
  collectionModel = new Collection();
  await collectionModel.createTable();

  // create fake Granules table
  granuleModel = new Granule();
  await granuleModel.createTable();

  // create fake execution table
  executionModel = new Execution();
  await executionModel.createTable();

  // create fake execution records
  fakeExecutions.push(
    fakeExecutionFactoryV2({
      status: 'completed',
      asyncOperationId: '0fe6317a-233c-4f19-a551-f0f76071402f',
      arn: 'arn2',
      type: 'fakeWorkflow',
    })
  );
  fakeExecutions.push(
    fakeExecutionFactoryV2({ status: 'failed', type: 'workflow2' })
  );
  fakeExecutions.push(
    fakeExecutionFactoryV2({ type: 'fakeWorkflow' })
  );
  await Promise.all(
    fakeExecutions.map((i) =>
      executionModel
        .create(i)
        .then((record) =>
          indexer.indexExecution(esClient, record, t.context.esAlias)))
  );

  executionPgModel = new ExecutionPgModel();
  collectionPgModel = new CollectionPgModel();
  granulePgModel = new GranulePgModel();

  const username = randomId('username');
  await setAuthorizedOAuthUsers([username]);

  accessTokenModel = new AccessToken();
  await accessTokenModel.createTable();

  jwtAuthToken = await createFakeJwtAuthToken({ accessTokenModel, username });

  // Create collections in Dynamo and Postgres
  // we need this because a granule has a foreign key referring to collections
  const collectionName = 'fakeCollection';
  const collectionVersion = 'v1';

  t.context.testCollection = fakeCollectionFactory({
    name: collectionName,
    version: collectionVersion,
    duplicateHandling: 'error',
  });
  const dynamoCollection = await collectionModel.create(
    t.context.testCollection
  );
  t.context.collectionId = constructCollectionId(
    dynamoCollection.name,
    dynamoCollection.version
  );

  const testPgCollection = fakeCollectionRecordFactory({
    name: collectionName,
    version: collectionVersion,
  });

  [t.context.collectionCumulusId] = await collectionPgModel.create(
    knex,
    testPgCollection
  );

  const executionCumulusIds = [];

  t.context.fakePGExecutions = await Promise.all(fakeExecutions.map(async (execution) => {
    const omitExecution = omit(execution, ['asyncOperationId']);
    await executionModel.create(omitExecution);
    const executionPgRecord = await translateApiExecutionToPostgresExecution(
      omitExecution,
      knex
    );
    executionCumulusIds.push(await executionPgModel.create(knex, executionPgRecord));
    return executionPgRecord;
  }));

  console.log(t.context.fakePGExecutions);

  t.context.executionCumulusIds = executionCumulusIds.flat();

  await esClient.indices.refresh();
});

test.beforeEach(async (t) => {
  const { esAlias, knex } = t.context;

  const granuleId1 = randomId('granuleId1');
  const granuleId2 = randomId('granuleId2');

  // create fake Dynamo granule records
  t.context.fakeGranules = [
    fakeGranuleFactoryV2({ granuleId: granuleId1, status: 'completed', collectionId: t.context.collectionId }),
    fakeGranuleFactoryV2({ granuleId: granuleId2, status: 'failed', collectionId: t.context.collectionId }),
  ];

  await Promise.all(
    t.context.fakeGranules.map((granule) =>
      granuleModel
        .create(granule)
        .then((record) => indexer.indexGranule(esClient, record, esAlias)))
  );

  // create fake Postgres granule records
  t.context.fakePGGranules = [
    fakeGranuleRecordFactory({
      granule_id: granuleId1,
      status: 'completed',
      collection_cumulus_id: t.context.collectionCumulusId,
    }),
    fakeGranuleRecordFactory({
      granule_id: granuleId2,
      status: 'failed',
      collection_cumulus_id: t.context.collectionCumulusId,
    }),
  ];

  [t.context.granuleCumulusId] = await Promise.all(
    t.context.fakePGGranules.map((granule) =>
      granulePgModel.create(knex, granule))
  );

  await upsertGranuleWithExecutionJoinRecord(
    knex, t.context.fakePGGranules[0], t.context.executionCumulusIds[0]
  );
  await upsertGranuleWithExecutionJoinRecord(
    knex, t.context.fakePGGranules[0], t.context.executionCumulusIds[1]
  );
  await upsertGranuleWithExecutionJoinRecord(
    knex, t.context.fakePGGranules[1], t.context.executionCumulusIds[2]
  );
});

test.after.always(async (t) => {
  await accessTokenModel.deleteTable();
  await collectionModel.deleteTable();
  await executionModel.deleteTable();
  await granuleModel.deleteTable();
  await esClient.indices.delete({ index: esIndex });
  await recursivelyDeleteS3Bucket(process.env.system_bucket);

  await destroyLocalTestDb({
    knex: t.context.knex,
    knexAdmin: t.context.knexAdmin,
    testDbName,
  });
});

test('CUMULUS-911 GET without pathParameters and without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .get('/executions')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test('CUMULUS-911 GET with pathParameters and without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .get('/executions/asdf')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test('CUMULUS-912 GET without pathParameters and with an unauthorized user returns an unauthorized response', async (t) => {
  const response = await request(app)
    .get('/executions')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test('CUMULUS-912 GET with pathParameters and with an unauthorized user returns an unauthorized response', async (t) => {
  const response = await request(app)
    .get('/executions/asdf')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test('default returns list of executions', async (t) => {
  const response = await request(app)
    .get('/executions')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const { meta, results } = response.body;
  t.is(results.length, 3);
  t.is(meta.stack, process.env.stackName);
  t.is(meta.table, 'execution');
  t.is(meta.count, 3);
  const arns = fakeExecutions.map((i) => i.arn);
  results.forEach((r) => {
    t.true(arns.includes(r.arn));
  });
});

test('executions can be filtered by workflow', async (t) => {
  const response = await request(app)
    .get('/executions')
    .query({ type: 'workflow2' })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const { meta, results } = response.body;
  t.is(results.length, 1);
  t.is(meta.stack, process.env.stackName);
  t.is(meta.table, 'execution');
  t.is(meta.count, 1);
  t.is(fakeExecutions[1].arn, results[0].arn);
});

test('GET executions with asyncOperationId filter returns the correct executions', async (t) => {
  const response = await request(app)
    .get('/executions?asyncOperationId=0fe6317a-233c-4f19-a551-f0f76071402f')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.body.meta.count, 1);
  t.is(response.body.results[0].arn, 'arn2');
});

test('GET returns an existing execution', async (t) => {
  const response = await request(app)
    .get(`/executions/${fakeExecutions[0].arn}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const executionResult = response.body;
  t.is(executionResult.arn, fakeExecutions[0].arn);
  t.is(executionResult.name, fakeExecutions[0].name);
  t.truthy(executionResult.duration);
  t.is(executionResult.status, 'completed');
});

test('GET fails if execution is not found', async (t) => {
  const response = await request(app)
    .get('/executions/unknown')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(404);

  t.is(response.status, 404);
  t.true(response.body.message.includes('No record found for'));
});

test('DELETE removes only specified execution from all data stores', async (t) => {
  const { knex } = t.context;

  const newExecution = fakeExecutionFactoryV2({
    arn: 'arn3',
    status: 'completed',
    name: 'test_execution',
  });

  await executionModel.create(newExecution);
  const executionPgRecord = await translateApiExecutionToPostgresExecution(
    newExecution,
    knex
  );
  await executionPgModel.create(knex, executionPgRecord);

  t.true(await executionModel.exists({ arn: newExecution.arn }));
  t.true(await executionPgModel.exists(knex, { arn: newExecution.arn }));

  await request(app)
    .delete(`/executions/${newExecution.arn}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  // Correct Dynamo and PG execution was deleted
  t.false(await executionModel.exists({ arn: newExecution.arn }));

  const dbRecords = await executionPgModel.search(t.context.knex, {
    arn: newExecution.arn,
  });

  t.is(dbRecords.length, 0);

  // Previously created executions still exist
  t.true(await executionModel.exists({ arn: fakeExecutions[0].arn }));
  t.true(await executionModel.exists({ arn: fakeExecutions[1].arn }));

  const originalExecution1 = await executionPgModel.search(t.context.knex, {
    arn: fakeExecutions[0].arn,
  });

  t.is(originalExecution1.length, 1);

  const originalExecution2 = await executionPgModel.search(t.context.knex, {
    arn: fakeExecutions[1].arn,
  });

  t.is(originalExecution2.length, 1);
});

test('DELETE returns a 404 if Dynamo execution cannot be found', async (t) => {
  const nonExistantExecution = {
    arn: 'arn9',
    status: 'completed',
    name: 'test_execution',
  };

  const response = await request(app)
    .delete(`/executions/${nonExistantExecution.arn}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(404);

  t.is(response.body.message, 'No record found');
});

test('POST /executions/search-by-granules returns 1 record by default', async (t) => {
  const { fakeGranules, fakePGExecutions } = t.context;

  const response = await request(app)
    .post('/executions/search-by-granules')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId: t.context.collectionId },
      { granuleId: fakeGranules[1].granuleId, collectionId: t.context.collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.body.length, 1);

  response.body.forEach(async (execution) => t.deepEqual(
    execution,
    await translatePostgresExecutionToApiExecution(fakePGExecutions
      .find((fakePGExecution) => fakePGExecution.arn === execution.arn))
  ));
});

test('POST /executions/search-by-granules supports paging', async (t) => {
  const { fakeGranules, fakePGExecutions } = t.context;

  const page1 = await request(app)
    .post('/executions/search-by-granules?limit=2&page=1')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId: t.context.collectionId },
      { granuleId: fakeGranules[1].granuleId, collectionId: t.context.collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  const page2 = await request(app)
    .post('/executions/search-by-granules?limit=2&page=2')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId: t.context.collectionId },
      { granuleId: fakeGranules[1].granuleId, collectionId: t.context.collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(page1.body.length, 2);
  t.is(page2.body.length, 1);

  const response = page1.body.concat(page2.body);

  response.forEach(async (execution) => t.deepEqual(
    execution,
    await translatePostgresExecutionToApiExecution(fakePGExecutions
      .find((fakePGExecution) => fakePGExecution.arn === execution.arn))
  ));
});

test('POST /executions/search-by-granules returns correct executions when granules array is passed', async (t) => {
  const { fakeGranules, fakePGExecutions } = t.context;

  const response = await request(app)
    .post('/executions/search-by-granules?limit=10')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId: t.context.collectionId },
      { granuleId: fakeGranules[1].granuleId, collectionId: t.context.collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.body.length, 3);

  response.body.forEach(async (execution) => t.deepEqual(
    execution,
    await translatePostgresExecutionToApiExecution(fakePGExecutions
      .find((fakePGExecution) => fakePGExecution.arn === execution.arn))
  ));
});

test('POST /executions/workflows-by-granules returns correct executions when granules array is passed', async (t) => {
  const { fakeGranules, fakePGExecutions } = t.context;

  const response = await request(app)
    .post('/executions/workflows-by-granules?limit=10')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId: t.context.collectionId },
      { granuleId: fakeGranules[1].granuleId, collectionId: t.context.collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.body.length, 1);

  response.body.forEach((workflow) => t.deepEqual(
    workflow,
    fakePGExecutions
      .map((fakePGExecution) => fakePGExecution.workflow_name)
      .find((workflowName) => workflowName === workflow)
  ));
});

test.serial('POST /executions/search-by-granules returns correct executions when query is passed', async (t) => {
  const { fakeGranules, fakePGExecutions } = t.context;

  const expectedQuery = {
    size: 2,
    query: {
      bool: {
        filter: [
          {
            bool: {
              should: [{ match: { granuleId: fakeGranules[0].granuleId } }],
              minimum_should_match: 1,
            },
          },
          {
            bool: {
              should: [{ match: { collectionId: fakeGranules[0].collectionId } }],
              minimum_should_match: 1,
            },
          },
        ],
      },
    },
  };

  const body = {
    index: esIndex,
    query: expectedQuery,
  };

  const response = await request(app)
    .post('/executions/search-by-granules?limit=10')
    .send(body)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.body.length, 2);

  response.body.forEach(async (execution) => t.deepEqual(
    execution,
    await translatePostgresExecutionToApiExecution(fakePGExecutions
      .find((fakePGExecution) => fakePGExecution.arn === execution.arn))
  ));
});

test.serial('POST /executions/search-by-granules returns 400 when a query is provided with no index', async (t) => {
  const expectedQuery = { query: 'fake-query' };

  const body = {
    query: expectedQuery,
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, /Index is required if query is sent/);
});

test.serial('POST /executions/search-by-granules returns 400 when no granules or query is provided', async (t) => {
  const expectedIndex = 'my-index';

  const body = {
    index: expectedIndex,
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400, /One of granules or query is required/);

  t.regex(response.body.message, /One of granules or query is required/);
});

test.serial('POST /executions/search-by-granules returns 400 when granules is not an array', async (t) => {
  const expectedIndex = 'my-index';

  const body = {
    index: expectedIndex,
    granules: 'bad-value',
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, /granules should be an array of values/);
});

test.serial('POST /executions/search-by-granules returns 400 when granules is an empty array', async (t) => {
  const expectedIndex = 'my-index';

  const body = {
    index: expectedIndex,
    granules: [],
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, /no values provided for granules/);
});

test.serial('POST /executions/search-by-granules returns 400 when granules do not have collectionId', async (t) => {
  const expectedIndex = 'my-index';
  const granule = { granuleId: randomId('granuleId') };

  const body = {
    index: expectedIndex,
    granules: [granule],
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, new RegExp(`no collectionId provided for ${JSON.stringify(granule)}`));
});

test.serial('POST /executions/search-by-granules returns 400 when granules do not have granuleId', async (t) => {
  const expectedIndex = 'my-index';
  const granule = { collectionId: randomId('granuleId') };

  const body = {
    index: expectedIndex,
    granules: [granule],
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, new RegExp(`no granuleId provided for ${JSON.stringify(granule)}`));
});

test.serial('POST /executions/search-by-granules returns 400 when the Metrics ELK stack is not configured', async (t) => {
  const expectedIndex = 'my-index';
  const expectedQuery = { query: 'fake-query' };

  const body = {
    index: expectedIndex,
    query: expectedQuery,
  };

  const metricsUser = process.env.METRICS_ES_USER;
  delete process.env.METRICS_ES_USER;
  t.teardown(() => {
    process.env.METRICS_ES_USER = metricsUser;
  });

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, /ELK Metrics stack not configured/);
});
