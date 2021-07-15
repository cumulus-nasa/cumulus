'use strict';

const request = require('supertest');
const sinon = require('sinon');
const test = require('ava');

const asyncOperations = require('@cumulus/async-operations');
const { s3 } = require('@cumulus/aws-client/services');
const {
  recursivelyDeleteS3Bucket,
} = require('@cumulus/aws-client/S3');
const { randomId } = require('@cumulus/common/test-utils');

const { createFakeJwtAuthToken, setAuthorizedOAuthUsers } = require('../../lib/testUtils');

const models = require('../../models');

const { app } = require('../../app');

process.env = {
  ...process.env,
  AccessTokensTable: randomId('AccessTokensTable'),
  AsyncOperationsTable: randomId('asyncOperationsTable'),
  system_bucket: randomId('systemBucket'),
  stackName: randomId('stackName'),
  TOKEN_SECRET: randomId('tokenSecret'),
  ReplayArchivedS3MessagesLambda: randomId('ReplayArchivedS3MessagesLambda'),
};

let accessTokenModel;
let jwtAuthToken;

test.before(async (t) => {
  await s3().createBucket({ Bucket: process.env.system_bucket }).promise();

  const username = randomId('username');
  await setAuthorizedOAuthUsers([username]);

  accessTokenModel = new models.AccessToken();
  await accessTokenModel.createTable();

  jwtAuthToken = await createFakeJwtAuthToken({ accessTokenModel, username });
  const asyncOperationId = randomId('asyncOperationId');
  t.context.asyncOperationStartStub = sinon.stub(asyncOperations, 'startAsyncOperation').returns(
    new Promise((resolve) => resolve({ id: asyncOperationId }))
  );
});

test.beforeEach((t) => {
  t.context.asyncOperationStartStub.resetHistory();
});

test.after.always(async (t) => {
  t.context.asyncOperationStartStub.restore();
  await Promise.all([
    recursivelyDeleteS3Bucket(process.env.system_bucket),
    accessTokenModel.deleteTable()]);
});

test.serial('POST /replayArchivedS3Messages starts an async-operation with specified payload', async (t) => {
  const { asyncOperationStartStub } = t.context;
  const queueName = 'archived-sqs-messages';

  const body = {
    type: 'sqs',
    queueName: queueName,
  };

  const response = await request(app)
    .post('/replayArchivedS3Messages')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(202);

  // expect a returned async operation ID
  t.truthy(response.body.asyncOperationId);
  const {
    lambdaName,
    cluster,
    description,
    payload,
  } = asyncOperationStartStub.args[0][0];
  t.true(asyncOperationStartStub.calledOnce);
  t.is(cluster, process.env.EcsCluster);
  t.is(description, 'Archived Messages Replay');
  t.is(lambdaName, process.env.ReplayArchivedS3MessagesLambda);
  t.deepEqual(payload, body);
});

test.serial('POST /replayArchivedS3Messages does not start an async-operation without queueName', async (t) => {
  const { asyncOperationStartStub } = t.context;
  await request(app)
    .post('/replayArchivedS3Messages')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send({ type: 'sqs' })
    .expect(400);
  t.false(asyncOperationStartStub.called);
});

test.serial('POST /replayArchivedS3Messages does not start an async-operation without type', async (t) => {
  const { asyncOperationStartStub } = t.context;
  await request(app)
    .post('/replayArchivedS3Messages')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send({ queueName: 'some-queue' })
    .expect(400);
  t.false(asyncOperationStartStub.called);
});
