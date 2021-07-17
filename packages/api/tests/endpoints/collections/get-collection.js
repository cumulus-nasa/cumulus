'use strict';

const test = require('ava');
const request = require('supertest');

const awsServices = require('@cumulus/aws-client/services');
const {
  recursivelyDeleteS3Bucket,
} = require('@cumulus/aws-client/S3');
const { randomString } = require('@cumulus/common/test-utils');
const { bootstrapElasticSearch } = require('@cumulus/es-client/bootstrap');
const { Search } = require('@cumulus/es-client/search');
const {
  localStackConnectionEnv,
  generateLocalTestDb,
  destroyLocalTestDb,
  CollectionPgModel,
  fakeCollectionRecordFactory,
} = require('@cumulus/db');

const { migrationDir } = require('../../../../../lambdas/db-migration');
const models = require('../../../models');
const {
  createFakeJwtAuthToken,
  setAuthorizedOAuthUsers,
} = require('../../../lib/testUtils');
const assertions = require('../../../lib/assertions');

process.env.AccessTokensTable = randomString();
process.env.CollectionsTable = randomString();
process.env.stackName = randomString();
process.env.system_bucket = randomString();
process.env.TOKEN_SECRET = randomString();

// import the express app after setting the env variables
const { app } = require('../../../app');

const esIndex = randomString();
let esClient;

let jwtAuthToken;
let accessTokenModel;
let collectionModel;

const testDbName = randomString(12);

test.before(async (t) => {
  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
    PG_DATABASE: testDbName,
  };
  const { knex, knexAdmin } = await generateLocalTestDb(testDbName, migrationDir);
  t.context.knex = knex;
  t.context.knexAdmin = knexAdmin;
  t.context.collectionPgModel = new CollectionPgModel();

  const esAlias = randomString();
  process.env.ES_INDEX = esAlias;
  await bootstrapElasticSearch('fakehost', esIndex, esAlias);

  await awsServices.s3().createBucket({ Bucket: process.env.system_bucket }).promise();

  collectionModel = new models.Collection({ tableName: process.env.CollectionsTable });
  await collectionModel.createTable();

  const username = randomString();
  await setAuthorizedOAuthUsers([username]);

  accessTokenModel = new models.AccessToken();
  await accessTokenModel.createTable();

  jwtAuthToken = await createFakeJwtAuthToken({ accessTokenModel, username });

  esClient = await Search.es('fakehost');
});

test.beforeEach(async (t) => {
  t.context.testCollection = fakeCollectionRecordFactory();
  await t.context.collectionPgModel.create(
    t.context.knex,
    t.context.testCollection
  );
});

test.after.always(async (t) => {
  await accessTokenModel.deleteTable();
  await collectionModel.deleteTable();
  await recursivelyDeleteS3Bucket(process.env.system_bucket);
  await esClient.indices.delete({ index: esIndex });
  await destroyLocalTestDb({
    knex: t.context.knex,
    knexAdmin: t.context.knexAdmin,
    testDbName,
  });
});

test('GET with pathParameters and without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .get('/collections/asdf/asdf')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test('GET with pathParameters and with an invalid access token returns an unauthorized response', async (t) => {
  const response = await request(app)
    .get('/collections/asdf/asdf')
    .set('Accept', 'application/json')
    .set('Authorization', 'Bearer ThisIsAnInvalidAuthorizationToken')
    .expect(401);

  assertions.isInvalidAccessTokenResponse(t, response);
});

test('GET returns an existing collection', async (t) => {
  const { testCollection } = t.context;
  const response = await request(app)
    .get(`/collections/${t.context.testCollection.name}/${t.context.testCollection.version}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const expected = {
    granuleId: testCollection.granule_id_validation_regex,
    granuleIdExtraction: testCollection.granule_id_extraction_regex,
    sampleFileName: testCollection.sample_file_name,
    files: JSON.parse(testCollection.files),
    name: testCollection.name,
    version: testCollection.version,
    createdAt: response.body.createdAt,
    updatedAt: response.body.updatedAt,
    meta: testCollection.meta,
  };
  t.deepEqual(response.body, expected);
});

test('CUMULUS-176 GET without a version returns a 404', async (t) => {
  const response = await request(app)
    .get(`/collections/${t.context.testCollection.name}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.statusCode, 404);
});
