'use strict';

const request = require('supertest');
const sinon = require('sinon');
const test = require('ava');

const { s3 } = require('@cumulus/aws-client/services');
const {
  recursivelyDeleteS3Bucket,
} = require('@cumulus/aws-client/S3');
const { randomString } = require('@cumulus/common/test-utils');

const {
  localStackConnectionEnv,
  generateLocalTestDb,
  destroyLocalTestDb,
  CollectionPgModel,
  fakeCollectionRecordFactory,
} = require('@cumulus/db');

const { migrationDir } = require('../../../../../lambdas/db-migration');
const { createFakeJwtAuthToken, setAuthorizedOAuthUsers } = require('../../../lib/testUtils');
const models = require('../../../models');
const { app } = require('../../../app');

process.env.AccessTokensTable = randomString();
process.env.backgroundQueueUrl = randomString();
process.env.GranulesTable = randomString();
process.env.TOKEN_SECRET = randomString();

const fakeCollectionId = 'FakeCollection___006';
let accessTokenModel;
let jwtAuthToken;

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
  const collectionPgModel = new CollectionPgModel();

  await collectionPgModel.create(t.context.knex, fakeCollectionRecordFactory({ name: 'FakeCollection', version: '006' }));

  process.env.system_bucket = randomString();
  await s3().createBucket({ Bucket: process.env.system_bucket }).promise();

  const username = randomString();
  await setAuthorizedOAuthUsers([username]);

  accessTokenModel = new models.AccessToken();
  await accessTokenModel.createTable();

  jwtAuthToken = await createFakeJwtAuthToken({ accessTokenModel, username });
});

test.after.always(async (t) => {
  await recursivelyDeleteS3Bucket(process.env.system_bucket);
  await accessTokenModel.deleteTable();

  await destroyLocalTestDb({
    knex: t.context.knex,
    knexAdmin: t.context.knexAdmin,
    testDbName,
  });
});

test('put request with reingest action calls the granuleModel.reingest function with expected parameters', async (t) => {
  const granuleGetStub = sinon.stub(models.Granule.prototype, 'get').returns(
    new Promise((resolve) => resolve({ collectionId: fakeCollectionId }))
  );
  const granuleReingestStub = sinon.stub(models.Granule.prototype, 'reingest').returns(
    new Promise((resolve) => resolve({ response: 'fakeResponse' }))
  );

  const body = {
    action: 'reingest',
  };

  await request(app)
    .put('/granules/asdf')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(200);

  t.is(granuleReingestStub.calledOnce, true);

  const reingestArgs = granuleReingestStub.args[0];
  const { queueUrl } = reingestArgs[0];
  t.is(queueUrl, process.env.backgroundQueueUrl);

  granuleGetStub.restore();
  granuleReingestStub.restore();
});
