const test = require('ava');
const cryptoRandomString = require('crypto-random-string');

const {
  generateLocalTestDb,
  localStackConnectionEnv,
  GranulePgModel,
  destroyLocalTestDb,
} = require('@cumulus/db');
const { createBucket, deleteS3Buckets } = require('@cumulus/aws-client/S3');
const { randomId } = require('@cumulus/common/test-utils');
const { Search } = require('@cumulus/es-client/search');
const {
  createTestIndex,
  cleanupTestIndex,
} = require('@cumulus/es-client/testUtils');

const { bulkGranuleDelete } = require('../../lambdas/bulk-operation');
const Granule = require('../../models/granules');
const { createGranuleAndFiles } = require('../../lib/create-test-data');
const models = require('../../models');
const { migrationDir } = require('../../../../lambdas/db-migration');

const testDbName = `${cryptoRandomString({ length: 10 })}`;

const getGranuleCumulusId = (dynamoGranule, granules) => {
  const matchingGranule = granules.find(
    (granule) => granule.newDynamoGranule.granuleId === dynamoGranule.granuleId
  );
  return matchingGranule.newPgGranule;
};

test.before(async (t) => {
  process.env.GranulesTable = randomId('granule');
  process.env.CollectionsTable = randomId('collection');
  process.env.system_bucket = randomId('bucket');
  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
    PG_DATABASE: testDbName,
  };

  // create a fake bucket
  await createBucket(process.env.system_bucket);

  await new models.Collection().createTable();
  await new Granule().createTable();

  const { knex, knexAdmin } = await generateLocalTestDb(testDbName, migrationDir);
  t.context.knex = knex;
  t.context.knexAdmin = knexAdmin;

  const { esIndex, esClient } = await createTestIndex();
  t.context.esIndex = esIndex;
  t.context.esClient = esClient;
  t.context.esGranulesClient = new Search({}, 'granule', t.context.esIndex);
});

test.after.always(async (t) => {
  await destroyLocalTestDb({
    knex: t.context.knex,
    knexAdmin: t.context.knexAdmin,
    testDbName,
  });
  await cleanupTestIndex(t.context);
});

test('bulkGranuleDelete does not fail on published granules if payload.forceRemoveFromCmr is true', async (t) => {
  const granuleModel = new Granule();
  const granulePgModel = new GranulePgModel();

  const granules = await Promise.all([
    createGranuleAndFiles({
      dbClient: t.context.knex,
      published: true,
      esClient: t.context.esClient,
    }),
    createGranuleAndFiles({
      dbClient: t.context.knex,
      published: true,
      esClient: t.context.esClient,
    }),
  ]);

  const dynamoGranule1 = granules[0].newDynamoGranule;
  const dynamoGranule2 = granules[1].newDynamoGranule;
  const dynamoGranuleId1 = dynamoGranule1.granuleId;
  const dynamoGranuleId2 = dynamoGranule2.granuleId;

  const { deletedGranules } = await bulkGranuleDelete(
    {
      ids: [
        dynamoGranuleId1,
        dynamoGranuleId2,
      ],
      forceRemoveFromCmr: true,
    },
    (_, dynamoGranule) => ({
      dynamoGranule: { ...dynamoGranule, published: false },
      pgGranule: {
        ...getGranuleCumulusId(dynamoGranule, granules),
        published: false,
      },
    })
  );

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

  t.false(
    await t.context.esGranulesClient.exists(
      dynamoGranule1.granuleId,
      dynamoGranule1.collectionId
    )
  );
  t.false(
    await t.context.esGranulesClient.exists(
      dynamoGranule2.granuleId,
      dynamoGranule2.collectionId
    )
  );

  const s3Buckets = granules[0].s3Buckets;
  t.teardown(() => deleteS3Buckets([
    s3Buckets.protected.name,
    s3Buckets.public.name,
  ]));
});
