'use strict';

const test = require('ava');
const request = require('supertest');
const noop = require('lodash/noop');
const omit = require('lodash/omit');
const sinon = require('sinon');

const { s3 } = require('@cumulus/aws-client/services');
const { recursivelyDeleteS3Bucket } = require('@cumulus/aws-client/S3');
const { randomId, randomString } = require('@cumulus/common/test-utils');
const { Search } = require('@cumulus/es-client/search');
const {
  createTestIndex,
  cleanupTestIndex,
} = require('@cumulus/es-client/testUtils');
const {
  localStackConnectionEnv,
  generateLocalTestDb,
  destroyLocalTestDb,
  AsyncOperationPgModel,
  translateApiAsyncOperationToPostgresAsyncOperation,
} = require('@cumulus/db');
const { RecordDoesNotExist } = require('@cumulus/errors');

const assertions = require('../../../lib/assertions');
const { migrationDir } = require('../../../../../lambdas/db-migration');
const { fakeAsyncOperationFactory } = require('../../../lib/testUtils');
const { buildFakeExpressResponse } = require('../utils');
const { post } = require('../../../endpoints/async-operations');
const {
  createFakeJwtAuthToken,
  setAuthorizedOAuthUsers,
} = require('../../../lib/testUtils');
const {
  AccessToken,
  AsyncOperation: AsyncOperationModel,
} = require('../../../models');

process.env.stackName = randomString();
process.env.system_bucket = randomString();
process.env.AsyncOperationsTable = randomString();
process.env.AccessTokensTable = randomString();
process.env.TOKEN_SECRET = randomString();

// import the express app after setting the env variables
const { app } = require('../../../app');

const testDbName = randomId('async_operations_test');

test.before(async (t) => {
  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
    PG_DATABASE: testDbName,
  };

  const { knex, knexAdmin } = await generateLocalTestDb(testDbName, migrationDir);
  t.context.testKnex = knex;
  t.context.testKnexAdmin = knexAdmin;
  t.context.asyncOperationPgModel = new AsyncOperationPgModel();

  const { esIndex, esClient } = await createTestIndex();
  t.context.esIndex = esIndex;
  t.context.esClient = esClient;
  t.context.esAsyncOperationsClient = new Search(
    {},
    'asyncOperation',
    t.context.esIndex
  );

  await s3().createBucket({ Bucket: process.env.system_bucket }).promise();

  // Create AsyncOperations table
  t.context.asyncOperationModel = new AsyncOperationModel({
    stackName: process.env.stackName,
    systemBucket: process.env.system_bucket,
    tableName: process.env.AsyncOperationsTable,
  });
  await t.context.asyncOperationModel.createTable();

  const username = randomString();
  await setAuthorizedOAuthUsers([username]);

  t.context.accessTokenModel = new AccessToken();
  await t.context.accessTokenModel.createTable();

  t.context.jwtAuthToken = await createFakeJwtAuthToken({
    accessTokenModel: t.context.accessTokenModel,
    username,
  });
});

test.after.always(async (t) => {
  await t.context.asyncOperationModel.deleteTable().catch(noop);
  await t.context.accessTokenModel.deleteTable().catch(noop);
  await cleanupTestIndex(t.context);
  await recursivelyDeleteS3Bucket(process.env.system_bucket);
  await destroyLocalTestDb({
    knex: t.context.testKnex,
    knexAdmin: t.context.testKnexAdmin,
    testDbName,
  });
});

test('POST without an Authorization header returns an Authorization Missing response', async (t) => {
  const asyncOperation1 = fakeAsyncOperationFactory();

  const response = await request(app)
    .post('/asyncOperations')
    .send(asyncOperation1)
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
  await t.throwsAsync(
    () => t.context.asyncOperationModel.get({ id: asyncOperation1.id }),
    { instanceOf: RecordDoesNotExist }
  );
});

test('POST with an invalid access token returns an unauthorized response', async (t) => {
  const asyncOperation = fakeAsyncOperationFactory();

  const response = await request(app)
    .post('/asyncOperations')
    .send(asyncOperation)
    .set('Accept', 'application/json')
    .set('Authorization', 'Bearer ThisIsAnInvalidAuthorizationToken')
    .expect(401);

  assertions.isInvalidAccessTokenResponse(t, response);
  await t.throwsAsync(
    () => t.context.asyncOperationModel.get({ id: asyncOperation.id }),
    { instanceOf: RecordDoesNotExist }
  );
});

test('POST creates a new async operation in all data stores', async (t) => {
  const { asyncOperationPgModel, jwtAuthToken } = t.context;
  const asyncOperation = fakeAsyncOperationFactory({
    output: JSON.stringify({ age: 59 }),
  });

  const pgAsyncOperation = await translateApiAsyncOperationToPostgresAsyncOperation(asyncOperation);

  const omitList = ['created_at', 'updated_at', 'cumulus_id', 'output'];

  const response = await request(app)
    .post('/asyncOperations')
    .send(asyncOperation)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const { message, record } = response.body;
  const pgRecord = await asyncOperationPgModel.search(
    t.context.testKnex,
    { id: asyncOperation.id }
  );

  t.is(message, 'Record saved');
  t.is(record.id, asyncOperation.id);
  t.is(pgRecord.length, 1);

  const [asyncOperationPgRecord] = pgRecord;

  t.deepEqual(
    omit(asyncOperationPgRecord, omitList),
    omit(pgAsyncOperation, omitList)
  );
  t.deepEqual(asyncOperationPgRecord.output, pgAsyncOperation.output);

  const esRecord = await t.context.esAsyncOperationsClient.get(
    asyncOperation.id
  );
  t.like(esRecord, record);
});

test('POST creates a new async operation in DynamoDB and PG with correct timestamps', async (t) => {
  const { asyncOperationModel, asyncOperationPgModel, jwtAuthToken } = t.context;
  const asyncOperation = fakeAsyncOperationFactory({
    output: JSON.stringify({ age: 59 }),
  });

  const response = await request(app)
    .post('/asyncOperations')
    .send(asyncOperation)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);
  const { record } = response.body;

  const fetchedRecord = await asyncOperationModel.get({
    id: asyncOperation.id,
  });

  const pgRecord = await asyncOperationPgModel.search(
    t.context.testKnex,
    { id: asyncOperation.id }
  );

  const [asyncOperationPgRecord] = pgRecord;

  t.true(fetchedRecord.createdAt > asyncOperation.createdAt);
  t.true(fetchedRecord.updatedAt > asyncOperation.updatedAt);

  const esRecord = await t.context.esAsyncOperationsClient.get(asyncOperation.id);

  t.is(asyncOperationPgRecord.created_at.getTime(), record.createdAt);
  t.is(asyncOperationPgRecord.updated_at.getTime(), record.updatedAt);
  t.is(asyncOperationPgRecord.created_at.getTime(), esRecord.createdAt);
  t.is(asyncOperationPgRecord.updated_at.getTime(), esRecord.updatedAt);
});

test('POST returns a 409 error if the async operation already exists in DynamoDB', async (t) => {
  const { asyncOperationModel, jwtAuthToken } = t.context;
  const asyncOperation = fakeAsyncOperationFactory();

  await asyncOperationModel.create(asyncOperation);

  const response = await request(app)
    .post('/asyncOperations')
    .send(asyncOperation)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(409);
  const { message } = response.body;
  t.is(message, (`A DynamoDb record already exists for async operation ID ${asyncOperation.id}`));
});

test.serial('POST returns a 500 response if record creation throws unexpected error', async (t) => {
  const { jwtAuthToken } = t.context;
  const stub = sinon.stub(AsyncOperationModel.prototype, 'create')
    .callsFake(() => {
      throw new Error('unexpected error');
    });

  const asyncOperation = fakeAsyncOperationFactory();

  const response = await request(app)
    .post('/asyncOperations')
    .send(asyncOperation)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(500);

  t.is(response.status, 500);
  t.teardown(() => {
    stub.restore();
  });
});

test('POST returns a 400 response if invalid record is provided', async (t) => {
  const { jwtAuthToken } = t.context;
  const asyncOperation = { invalid: 'value' };

  const response = await request(app)
    .post('/asyncOperations')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(asyncOperation)
    .expect(400);
  t.is(response.status, 400);
});

test('POST returns a 404 if the requested path does not exist', async (t) => {
  const { jwtAuthToken } = t.context;

  const response = await request(app)
    .post(`/asyncOperations/${randomString()}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.statusCode, 404);
});

test('POST returns a 400 response if invalid JSON provided', async (t) => {
  const { jwtAuthToken } = t.context;
  const response = await request(app)
    .post('/asyncOperations')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send('asdf');

  const error = JSON.parse(response.error.text);

  t.is(response.statusCode, 400);
  t.is(error.error, 'Bad Request');
  t.is(error.message, 'Async Operations require an ID');
});

test('post() does not write to PostgreSQL/Elasticsearch if writing to DynamoDB fails', async (t) => {
  const { testKnex } = t.context;
  const asyncOperation = fakeAsyncOperationFactory({
    output: JSON.stringify({ age: 59 }),
  });

  const fakeAsyncOperationModel = {
    create: () => {
      throw new Error('something bad');
    },
    exists: () => Promise.resolve(false),
    delete: () => Promise.resolve(true),
  };

  const expressRequest = {
    body: asyncOperation,
    testContext: {
      knex: testKnex,
      asyncOperationModel: fakeAsyncOperationModel,
    },
  };

  const response = buildFakeExpressResponse();

  await post(expressRequest, response);

  t.true(response.boom.badImplementation.calledWithMatch('something bad'));

  t.false(await t.context.esAsyncOperationsClient.exists(
    asyncOperation.id
  ));
  t.false(
    await t.context.asyncOperationPgModel.exists(t.context.testKnex, {
      id: asyncOperation.id,
    })
  );
});

test('post() does not write to DynamoDB/Elasticsearch if writing to PostgreSQL fails', async (t) => {
  const asyncOperation = fakeAsyncOperationFactory({
    output: JSON.stringify({ age: 59 }),
  });

  const fakeAsyncOperationPgModel = {
    create: () => Promise.reject(new Error('something bad')),
  };

  const expressRequest = {
    body: asyncOperation,
    testContext: {
      asyncOperationPgModel: fakeAsyncOperationPgModel,
    },
  };

  const response = buildFakeExpressResponse();

  await post(expressRequest, response);

  t.true(response.boom.badImplementation.calledWithMatch('something bad'));

  t.false(await t.context.esAsyncOperationsClient.exists(
    asyncOperation.id
  ));
  t.false(await t.context.asyncOperationModel.exists({ id: asyncOperation.id }));
});

test('post() does not write to DynamoDB/PostgreSQL if writing to Elasticsearch fails', async (t) => {
  const asyncOperation = fakeAsyncOperationFactory({
    output: JSON.stringify({ age: 59 }),
  });

  const fakeEsClient = {
    index: () => Promise.reject(new Error('something bad')),
  };

  const expressRequest = {
    body: asyncOperation,
    testContext: {
      esClient: fakeEsClient,
    },
  };

  const response = buildFakeExpressResponse();

  await post(expressRequest, response);

  t.true(response.boom.badImplementation.calledWithMatch('something bad'));

  t.false(await t.context.asyncOperationModel.exists({ id: asyncOperation.id }));
  t.false(
    await t.context.asyncOperationPgModel.exists(t.context.testKnex, {
      id: asyncOperation.id,
    })
  );
});
