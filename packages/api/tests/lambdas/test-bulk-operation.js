const test = require('ava');
const cryptoRandomString = require('crypto-random-string');
const proxyquire = require('proxyquire');
const sinon = require('sinon');

const awsServices = require('@cumulus/aws-client/services');
const { generateLocalTestDb, localStackConnectionEnv, GranulePgModel } = require('@cumulus/db');
const { randomId, randomString } = require('@cumulus/common/test-utils');
const { createBucket, deleteS3Buckets } = require('@cumulus/aws-client/S3');
const { fakeGranuleFactoryV2 } = require('../../lib/testUtils');
const { createGranuleAndFiles } = require('../helpers/create-test-data');
const Granule = require('../../models/granules');
const { migrationDir } = require('../../../../lambdas/db-migration');

const testDbName = `${cryptoRandomString({ length: 10 })}`;

const sandbox = sinon.createSandbox();
const FakeEsClient = sandbox.stub();
const esSearchStub = sandbox.stub();
const esScrollStub = sandbox.stub();
FakeEsClient.prototype.scroll = esScrollStub;
FakeEsClient.prototype.search = esSearchStub;
class FakeSearch {
  static es() {
    return new FakeEsClient();
  }
}
const bulkOperation = proxyquire('../../lambdas/bulk-operation', {
  '@cumulus/es-client/search': {
    Search: FakeSearch,
  },
});

let applyWorkflowStub;
let reingestStub;

const envVars = {
  asyncOperationId: randomId('asyncOperationId'),
  cmr_client_id: randomId('cmr_client'),
  CMR_ENVIRONMENT: randomId('env'),
  cmr_oauth_provider: randomId('cmr_oauth'),
  cmr_password_secret_name: randomId('cmr_secret'),
  cmr_provider: randomId('cmr_provider'),
  cmr_username: randomId('cmr_user'),
  invoke: randomId('invoke'),
  launchpad_api: randomId('api'),
  launchpad_certificate: randomId('certificate'),
  launchpad_passphrase_secret_name: randomId('launchpad_secret'),
  METRICS_ES_HOST: randomId('host'),
  METRICS_ES_USER: randomId('user'),
  METRICS_ES_PASS: randomId('pass'),
  stackName: randomId('stack'),
  system_bucket: randomId('bucket'),
};

test.before(async (t) => {
  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
    PG_DATABASE: testDbName,
    METRICS_ES_HOST: randomId('host'),
    METRICS_ES_USER: randomId('user'),
    METRICS_ES_PASS: randomId('pass'),
    GranulesTable: randomId('granule'),
    ...envVars,
  };

  // create a fake bucket
  await createBucket(envVars.system_bucket);

  await new Granule().createTable();

  applyWorkflowStub = sandbox.stub(Granule.prototype, 'applyWorkflow');
  reingestStub = sandbox.stub(Granule.prototype, 'reingest');
  sandbox.stub(Granule.prototype, '_removeGranuleFromCmr').resolves();

  const { knex, knexAdmin } = await generateLocalTestDb(testDbName, migrationDir);
  t.context.knex = knex;
  t.context.knexAdmin = knexAdmin;

  // Store the CMR password
  process.env.cmr_password_secret_name = randomString();
  await awsServices.secretsManager().createSecret({
    Name: envVars.cmr_password_secret_name,
    SecretString: randomString(),
  }).promise();

  // Store the launchpad passphrase
  process.env.launchpad_passphrase_secret_name = randomString();
  await awsServices.secretsManager().createSecret({
    Name: envVars.launchpad_passphrase_secret_name,
    SecretString: randomString(),
  }).promise();
});

test.afterEach.always(() => {
  sandbox.resetHistory();
});

test.after.always(async () => {
  await awsServices.secretsManager().deleteSecret({
    SecretId: envVars.cmr_password_secret_name,
    ForceDeleteWithoutRecovery: true,
  }).promise();
  await awsServices.secretsManager().deleteSecret({
    SecretId: envVars.launchpad_passphrase_secret_name,
    ForceDeleteWithoutRecovery: true,
  }).promise();

  sandbox.restore();
});

test('getGranuleIdsForPayload returns unique granule IDs from payload', async (t) => {
  const granuleId1 = randomId('granule');
  const granuleId2 = randomId('granule');
  const ids = [granuleId1, granuleId1, granuleId2];
  const returnedIds = await bulkOperation.getGranuleIdsForPayload({
    ids,
  });
  t.deepEqual(
    returnedIds.sort(),
    [granuleId1, granuleId2].sort()
  );
});

test.serial('getGranuleIdsForPayload returns unique granule IDs from query', async (t) => {
  const granuleId1 = randomId('granule');
  const granuleId2 = randomId('granule');
  esSearchStub.resolves({
    body: {
      hits: {
        hits: [{
          _source: {
            granuleId: granuleId1,
          },
        }, {
          _source: {
            granuleId: granuleId1,
          },
        }, {
          _source: {
            granuleId: granuleId2,
          },
        }],
        total: {
          value: 3,
        },
      },
    },
  });
  const returnedIds = await bulkOperation.getGranuleIdsForPayload({
    query: 'fake-query',
    index: 'fake-index',
  });
  t.deepEqual(
    returnedIds.sort(),
    [granuleId1, granuleId2].sort()
  );
});

test.serial('getGranuleIdsForPayload handles query paging', async (t) => {
  const granuleId1 = randomId('granule');
  const granuleId2 = randomId('granule');
  const granuleId3 = randomId('granule');
  esSearchStub.resolves({
    body: {
      hits: {
        hits: [{
          _source: {
            granuleId: granuleId1,
          },
        }, {
          _source: {
            granuleId: granuleId2,
          },
        }],
        total: {
          value: 3,
        },
      },
    },
  });
  esScrollStub.resolves({
    body: {
      hits: {
        hits: [{
          _source: {
            granuleId: granuleId3,
          },
        }],
        total: {
          value: 3,
        },
      },
    },
  });
  t.deepEqual(
    await bulkOperation.getGranuleIdsForPayload({
      query: 'fake-query',
      index: 'fake-index',
    }),
    [granuleId1, granuleId2, granuleId3]
  );
});

test('applyWorkflowToGranules passed on queueUrl to granule.applyWorkflow', async (t) => {
  const granuleIds = ['granule-1'];
  const workflowName = 'test-workflow';
  const queueUrl = `${cryptoRandomString({ length: 5 })}_queue`;

  const applyWorkflowSpy = sinon.spy();
  const fakeGranuleModel = {
    get: async () => {},
    applyWorkflow: applyWorkflowSpy,
  };

  await bulkOperation.applyWorkflowToGranules({
    granuleIds,
    workflowName,
    queueUrl,
    granuleModel: fakeGranuleModel,
  });
  t.is(applyWorkflowSpy.getCall(0).args[3], queueUrl);
});

test('bulk operation lambda throws error for unknown event type', async (t) => {
  await t.throwsAsync(bulkOperation.handler({
    type: randomId('type'),
  }));
});

// This test must run for the following tests to pass
test.serial('bulk operation lambda sets env vars provided in payload', async (t) => {
  const granuleModel = new Granule();
  const granule = await granuleModel.create(fakeGranuleFactoryV2());
  const workflowName = randomId('workflow');

  // delete existing ENVs
  Object.keys(envVars).forEach((envVarKey) => {
    delete process.env[envVarKey];
  });

  await bulkOperation.handler({
    type: 'BULK_GRANULE',
    envVars,
    payload: {
      ids: [granule.granuleId],
      workflowName,
    },
  });
  Object.keys(envVars).forEach((envVarKey) => {
    t.is(process.env[envVarKey], envVars[envVarKey]);
  });
});

test.serial('bulk operation BULK_GRANULE applies workflow to list of granule IDs', async (t) => {
  const granuleModel = new Granule();
  const granules = await Promise.all([
    granuleModel.create(fakeGranuleFactoryV2()),
    granuleModel.create(fakeGranuleFactoryV2()),
  ]);

  const workflowName = randomId('workflow');
  await bulkOperation.handler({
    type: 'BULK_GRANULE',
    envVars,
    payload: {
      ids: [
        granules[0].granuleId,
        granules[1].granuleId,
      ],
      workflowName,
    },
  });
  t.is(applyWorkflowStub.callCount, 2);
  // Can't guarantee processing order so test against granule matching by ID
  applyWorkflowStub.args.forEach((callArgs) => {
    const matchingGranule = granules.find((granule) => granule.granuleId === callArgs[0].granuleId);
    t.deepEqual(matchingGranule, callArgs[0]);
    t.is(callArgs[1], workflowName);
  });
});

test.serial('bulk operation BULK_GRANULE applies workflow to granule IDs returned by query', async (t) => {
  const granuleModel = new Granule();
  const granules = await Promise.all([
    granuleModel.create(fakeGranuleFactoryV2()),
    granuleModel.create(fakeGranuleFactoryV2()),
  ]);

  esSearchStub.resolves({
    body: {
      hits: {
        hits: [{
          _source: {
            granuleId: granules[0].granuleId,
          },
        }, {
          _source: {
            granuleId: granules[1].granuleId,
          },
        }],
        total: {
          value: 2,
        },
      },
    },
  });

  const workflowName = randomId('workflow');
  await bulkOperation.handler({
    type: 'BULK_GRANULE',
    envVars,
    payload: {
      query: 'fake-query',
      workflowName,
      index: randomId('index'),
    },
  });

  t.true(esSearchStub.called);
  t.is(applyWorkflowStub.callCount, 2);
  // Can't guarantee processing order so test against granule matching by ID
  applyWorkflowStub.args.forEach((callArgs) => {
    const matchingGranule = granules.find((granule) => granule.granuleId === callArgs[0].granuleId);
    t.deepEqual(matchingGranule, callArgs[0]);
    t.is(callArgs[1], workflowName);
  });
});

test.serial('bulk operation BULK_GRANULE_DELETE deletes listed granule IDs from Dynamo and Postgres', async (t) => {
  const granuleModel = new Granule();
  const granulePgModel = new GranulePgModel();

  const granules = await Promise.all([
    createGranuleAndFiles({
      dbClient: t.context.knex,
      published: false,
    }),
    createGranuleAndFiles({
      dbClient: t.context.knex,
      published: false,
    }),
  ]);

  const s3Buckets = granules[0].s3Buckets;
  const dynamoGranuleId1 = granules[0].newDynamoGranule.granuleId;
  const dynamoGranuleId2 = granules[1].newDynamoGranule.granuleId;

  const { deletedGranules } = await bulkOperation.handler({
    type: 'BULK_GRANULE_DELETE',
    envVars,
    payload: {
      ids: [
        dynamoGranuleId1,
        dynamoGranuleId2,
      ],
    },
  });

  t.deepEqual(
    deletedGranules.sort(),
    [
      dynamoGranuleId1,
      dynamoGranuleId2,
    ].sort()
  );

  // Granules should have been deleted from Dynamo
  t.false(await granuleModel.exists({ granuleId: dynamoGranuleId1 }));
  t.false(await granuleModel.exists({ granuleId: dynamoGranuleId2 }));

  // Granules should have been deleted from Postgres
  t.false(await granulePgModel.exists(t.context.knex, { granule_id: dynamoGranuleId1 }));
  t.false(await granulePgModel.exists(t.context.knex, { granule_id: dynamoGranuleId2 }));

  t.teardown(() => deleteS3Buckets([
    s3Buckets.protected.name,
    s3Buckets.public.name,
  ]));
});

test.serial('bulk operation BULK_GRANULE_DELETE processes all granules that do not error', async (t) => {
  const errorMessage = 'fail';
  let count = 0;

  const deleteStub = sinon.stub(Granule.prototype, 'delete')
    .callsFake(() => {
      count += 1;
      if (count > 3) {
        throw new Error(errorMessage);
      }
      return Promise.resolve();
    });
  t.teardown(() => {
    deleteStub.restore();
  });

  const granules = await Promise.all([
    createGranuleAndFiles({ dbClient: t.context.knex }),
    createGranuleAndFiles({ dbClient: t.context.knex }),
    createGranuleAndFiles({ dbClient: t.context.knex }),
    createGranuleAndFiles({ dbClient: t.context.knex }),
    createGranuleAndFiles({ dbClient: t.context.knex }),
    createGranuleAndFiles({ dbClient: t.context.knex }),
  ]);

  const aggregateError = await t.throwsAsync(bulkOperation.handler({
    type: 'BULK_GRANULE_DELETE',
    envVars,
    payload: {
      ids: [
        granules[0].newDynamoGranule.granuleId,
        granules[1].newDynamoGranule.granuleId,
        granules[2].newDynamoGranule.granuleId,
        granules[3].newDynamoGranule.granuleId,
        granules[4].newDynamoGranule.granuleId,
        granules[5].newDynamoGranule.granuleId,
      ],
    },
  }));

  // tried to delete 6 times, but failed 3 times
  t.is(deleteStub.callCount, 6);
  t.deepEqual(
    Array.from(aggregateError).map((error) => error.message),
    [
      errorMessage,
      errorMessage,
      errorMessage,
    ]
  );

  const s3Buckets = granules[0].s3Buckets;

  t.teardown(() => deleteS3Buckets([
    s3Buckets.protected.name,
    s3Buckets.public.name,
  ]));
});

test.serial('bulk operation BULK_GRANULE_DELETE deletes granule IDs returned by query', async (t) => {
  const granules = await Promise.all([
    createGranuleAndFiles({ dbClient: t.context.knex }),
    createGranuleAndFiles({ dbClient: t.context.knex }),
  ]);

  esSearchStub.resolves({
    body: {
      hits: {
        hits: [{
          _source: {
            granuleId: granules[0].newDynamoGranule.granuleId,
          },
        }, {
          _source: {
            granuleId: granules[1].newDynamoGranule.granuleId,
          },
        }],
        total: {
          value: 2,
        },
      },
    },
  });

  const { deletedGranules } = await bulkOperation.handler({
    type: 'BULK_GRANULE_DELETE',
    envVars,
    payload: {
      query: 'fake-query',
      index: randomId('index'),
    },
  });

  t.true(esSearchStub.called);
  t.deepEqual(
    deletedGranules.sort(),
    [
      granules[0].newDynamoGranule.granuleId,
      granules[1].newDynamoGranule.granuleId,
    ].sort()
  );

  const s3Buckets = granules[0].s3Buckets;
  t.teardown(() => deleteS3Buckets([
    s3Buckets.protected.name,
    s3Buckets.public.name,
  ]));
});

test.serial('bulk operation BULK_GRANULE_DELETE does not throw error for granules that were already removed', async (t) => {
  const { deletedGranules } = await bulkOperation.handler({
    type: 'BULK_GRANULE_DELETE',
    envVars,
    payload: {
      ids: [
        'deleted-granule-id',
      ],
    },
  });
  t.deepEqual(deletedGranules, []);
});

test.serial('bulk operation BULK_GRANULE_REINGEST reingests list of granule IDs', async (t) => {
  const granuleModel = new Granule();
  const granules = await Promise.all([
    granuleModel.create(fakeGranuleFactoryV2()),
    granuleModel.create(fakeGranuleFactoryV2()),
  ]);

  await bulkOperation.handler({
    type: 'BULK_GRANULE_REINGEST',
    envVars,
    payload: {
      ids: [
        granules[0].granuleId,
        granules[1].granuleId,
      ],
    },
  });

  t.is(reingestStub.callCount, 2);
  reingestStub.args.forEach((callArgs) => {
    const matchingGranule = granules.find((granule) => granule.granuleId === callArgs[0].granuleId);
    t.deepEqual(matchingGranule, callArgs[0]);
    t.is(callArgs[1], process.env.asyncOperationId);
  });
});

test.serial('bulk operation BULK_GRANULE_REINGEST reingests granule IDs returned by query', async (t) => {
  const granuleModel = new Granule();
  const granules = await Promise.all([
    granuleModel.create(fakeGranuleFactoryV2()),
    granuleModel.create(fakeGranuleFactoryV2()),
  ]);

  esSearchStub.resolves({
    body: {
      hits: {
        hits: [{
          _source: {
            granuleId: granules[0].granuleId,
          },
        }, {
          _source: {
            granuleId: granules[1].granuleId,
          },
        }],
        total: {
          value: 2,
        },
      },
    },
  });

  await bulkOperation.handler({
    type: 'BULK_GRANULE_REINGEST',
    envVars,
    payload: {
      query: 'fake-query',
      index: randomId('index'),
    },
  });

  t.true(esSearchStub.called);
  t.is(reingestStub.callCount, 2);
  reingestStub.args.forEach((callArgs) => {
    const matchingGranule = granules.find((granule) => granule.granuleId === callArgs[0].granuleId);
    t.deepEqual(matchingGranule, callArgs[0]);
    t.is(callArgs[1], process.env.asyncOperationId);
  });
});
