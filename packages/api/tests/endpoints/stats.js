'use strict';

const test = require('ava');
const request = require('supertest');
const rewire = require('rewire');
const sinon = require('sinon');

const awsServices = require('@cumulus/aws-client/services');
const s3 = require('@cumulus/aws-client/S3');
const { randomId } = require('@cumulus/common/test-utils');
const { bootstrapElasticSearch } = require('@cumulus/es-client/bootstrap');
const indexer = rewire('@cumulus/es-client/indexer');
const { Search } = require('@cumulus/es-client/search');

const models = require('../../models');
const {
  fakeGranuleFactoryV2,
  fakeCollectionFactory,
  createFakeJwtAuthToken,
  setAuthorizedOAuthUsers,
} = require('../../lib/testUtils');

const assertions = require('../../lib/assertions');

const stats = rewire('../../endpoints/stats');
const getType = stats.__get__('getType');

process.env.GranulesTable = randomId('granulesTable');
process.env.AccessTokensTable = randomId('accessTokenTable');

process.env.system_bucket = randomId('systemBucket');
process.env.stackName = randomId('stackName');

const esIndex = randomId('esindex');
const esAlias = randomId('esAlias');

process.env.ES_INDEX = esAlias;
process.env.TOKEN_SECRET = randomId('tokensecret');

// import the express app after setting the env variables
const { app } = require('../../app');

let esClient;
let granuleModel;
let accessTokenModel;
let jwtAuthToken;

test.before(async () => {
  // create the tables

  granuleModel = new models.Granule();
  await granuleModel.createTable();

  // create buckets
  await awsServices.s3().createBucket({ Bucket: process.env.system_bucket }).promise();

  const username = randomId();
  await setAuthorizedOAuthUsers([username]);

  accessTokenModel = new models.AccessToken();
  await accessTokenModel.createTable();

  jwtAuthToken = await createFakeJwtAuthToken({ accessTokenModel, username });

  // create the elasticsearch index and add mapping
  await bootstrapElasticSearch('fakehost', esIndex, esAlias);
  esClient = await Search.es();

  // Index test data - 2 collections, 3 granules
  await Promise.all([
    indexer.indexCollection(esClient, fakeCollectionFactory(), esAlias),
    indexer.indexCollection(esClient, fakeCollectionFactory(), esAlias),
    indexer.indexGranule(esClient, fakeGranuleFactoryV2({ collectionId: 'coll1' }), esAlias),
    indexer.indexGranule(esClient, fakeGranuleFactoryV2({ collectionId: 'coll1' }), esAlias),
    indexer.indexGranule(esClient, fakeGranuleFactoryV2({ status: 'failed', duration: 3 }), esAlias),
  ]);

  // Indexing using Date.now() to generate the timestamp
  const stub = sinon.stub(Date, 'now').returns((new Date(2020, 0, 29)).getTime());

  await Promise.all([
    indexer.indexCollection(esClient, fakeCollectionFactory({
      updatedAt: new Date(2020, 0, 29),
    }), esAlias),
    indexer.indexGranule(esClient, fakeGranuleFactoryV2({
      status: 'failed',
      updatedAt: new Date(2020, 0, 29),
      duration: 4,
    }), esAlias),
    indexer.indexGranule(esClient, fakeGranuleFactoryV2({
      updatedAt: new Date(2020, 0, 29),
      duration: 4,
    }), esAlias),
  ]);

  stub.restore();
});

test.after.always(async () => {
  await Promise.all([
    esClient.indices.delete({ index: esIndex }),
    granuleModel.deleteTable(),
    await accessTokenModel.deleteTable(),
    s3.recursivelyDeleteS3Bucket(process.env.system_bucket),
  ]);
});

test('GET without pathParameters and without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .get('/stats')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test('GET /stats/aggregate without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .get('/stats/aggregate')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test('GET without pathParameters and with an invalid access token returns an unauthorized response', async (t) => {
  const response = await request(app)
    .get('/stats/')
    .set('Accept', 'application/json')
    .set('Authorization', 'Bearer ThisIsAnInvalidAuthorizationToken')
    .expect(401);

  assertions.isInvalidAccessTokenResponse(t, response);
});

test.todo('GET without pathParameters and with an unauthorized user returns an unauthorized response');

test('GET /stats/aggregate with an invalid access token returns an unauthorized response', async (t) => {
  const response = await request(app)
    .get('/stats/aggregate')
    .set('Accept', 'application/json')
    .set('Authorization', 'Bearer ThisIsAnInvalidAuthorizationToken')
    .expect(401);

  assertions.isInvalidAccessTokenResponse(t, response);
});

test('getType gets correct type for granules', (t) => {
  const type = getType({ params: { type: 'granules' } });

  t.is(type, 'granule');
});

test('getType gets correct type for collections', (t) => {
  const type = getType({ params: { type: 'collections' } });

  t.is(type, 'collection');
});

test('getType gets correct type for pdrs', (t) => {
  const type = getType({ params: { type: 'pdrs' } });

  t.is(type, 'pdr');
});

test('getType gets correct type for executions', (t) => {
  const type = getType({ params: { type: 'executions' } });

  t.is(type, 'execution');
});

test('getType gets correct type for logs', (t) => {
  const type = getType({ params: { type: 'logs' } });

  t.is(type, 'logs');
});

test('getType gets correct type for providers', (t) => {
  const type = getType({ params: { type: 'providers' } });

  t.is(type, 'provider');
});

test('getType returns undefined if type is not supported', (t) => {
  const type = getType({ params: { type: 'provide' } });

  t.falsy(type);
});

test('getType returns correct type from query params', (t) => {
  const type = getType({ query: { type: 'providers' } });

  t.is(type, 'provider');
});

test('GET /stats returns correct response, defaulted to all', async (t) => {
  const response = await request(app)
    .get('/stats')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.body.errors.value, 2);
  t.is(response.body.collections.value, 2);
  t.is(response.body.processingTime.value, 2.2);
  t.is(response.body.granules.value, 5);
});

test('GET /stats returns correct response with date params filters values correctly', async (t) => {
  const response = await request(app)
    .get(`/stats?timestamp__from=${(new Date(2020, 0, 28)).getTime()}&timestamp__to=${(new Date(2020, 0, 30)).getTime()}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.body.errors.value, 1);
  t.is(response.body.collections.value, 1);
  t.is(response.body.processingTime.value, 4);
  t.is(response.body.granules.value, 2);
});

test('GET /stats/aggregate returns correct response', async (t) => {
  const response = await request(app)
    .get('/stats/aggregate?type=granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.body.meta.count, 5);
  t.deepEqual(response.body.count, [
    { key: 'completed', count: 3 }, { key: 'failed', count: 2 },
  ]);
});

test('GET /stats/aggregate filters correctly by date', async (t) => {
  const response = await request(app)
    .get(`/stats/aggregate?type=granules&timestamp__from=${(new Date(2020, 0, 28)).getTime()}&timestamp__to=${(new Date(2020, 0, 30)).getTime()}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.body.meta.count, 2);
  t.deepEqual(response.body.count, [
    { key: 'completed', count: 1 }, { key: 'failed', count: 1 },
  ]);
});
