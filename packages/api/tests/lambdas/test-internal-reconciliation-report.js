'use strict';

const test = require('ava');
const moment = require('moment');
const flatten = require('lodash/flatten');
const range = require('lodash/range');
const cryptoRandomString = require('crypto-random-string');

const {
  recursivelyDeleteS3Bucket,
} = require('@cumulus/aws-client/S3');
const awsServices = require('@cumulus/aws-client/services');
const { randomId } = require('@cumulus/common/test-utils');
const { constructCollectionId } = require('@cumulus/message/Collections');
const { bootstrapElasticSearch } = require('@cumulus/es-client/bootstrap');
const indexer = require('@cumulus/es-client/indexer');
const { Search } = require('@cumulus/es-client/search');

const {
  CollectionPgModel,
  destroyLocalTestDb,
  generateLocalTestDb,
  localStackConnectionEnv,
  translateApiCollectionToPostgresCollection,
} = require('@cumulus/db');

const { fakeCollectionFactory, fakeGranuleFactoryV2 } = require('../../lib/testUtils');
const {
  internalRecReportForCollections,
  internalRecReportForGranules,
} = require('../../lambdas/internal-reconciliation-report');
const { normalizeEvent } = require('../../lib/reconciliationReport/normalizeEvent');
const models = require('../../models');
const { deconstructCollectionId } = require('../../lib/utils');
const { migrationDir } = require('../../../../lambdas/db-migration');

let esAlias;
let esIndex;
let esClient;

test.beforeEach(async (t) => {
  process.env.GranulesTable = randomId('granulesTable');
  process.env.ReconciliationReportsTable = randomId('reconciliationTable');

  t.context.bucketsToCleanup = [];
  t.context.stackName = randomId('stack');
  t.context.systemBucket = randomId('systembucket');
  process.env.system_bucket = t.context.systemBucket;

  await awsServices.s3().createBucket({ Bucket: t.context.systemBucket }).promise()
    .then(() => t.context.bucketsToCleanup.push(t.context.systemBucket));

  await new models.Granule().createTable();
  await new models.ReconciliationReport().createTable();

  esAlias = randomId('esalias');
  esIndex = randomId('esindex');
  process.env.ES_INDEX = esAlias;
  await bootstrapElasticSearch('fakehost', esIndex, esAlias);
  esClient = await Search.es();

  t.context.testDbName = `test_internal_recon_${cryptoRandomString({ length: 10 })}`;
  const { knex, knexAdmin } = await generateLocalTestDb(t.context.testDbName, migrationDir);
  t.context.knex = knex;
  t.context.knexAdmin = knexAdmin;
  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
    PG_DATABASE: t.context.testDbName,
  };
  t.context.collectionPgModel = new CollectionPgModel();
});

test.afterEach.always(async (t) => {
  await destroyLocalTestDb({
    knex: t.context.knex,
    knexAdmin: t.context.knexAdmin,
    testDbName: t.context.testDbName,
  });
  await Promise.all(
    flatten([
      t.context.bucketsToCleanup.map(recursivelyDeleteS3Bucket),
      new models.Granule().deleteTable(),
      new models.ReconciliationReport().deleteTable(),
    ])
  );
  await esClient.indices.delete({ index: esIndex });
});

test.serial('internalRecReportForCollections reports discrepancy of collection holdings in ES and DB', async (t) => {
  const { knex, collectionPgModel } = t.context;

  const matchingColls = range(10).map(() => fakeCollectionFactory());
  const extraDbColls = range(2).map(() => fakeCollectionFactory());
  const extraEsColls = range(2).map(() => fakeCollectionFactory());

  const conflictCollInDb = fakeCollectionFactory({ meta: { flag: 'db' } });
  const conflictCollInEs = { ...conflictCollInDb, meta: { flag: 'es' } };

  const esCollections = matchingColls.concat(extraEsColls, conflictCollInEs);
  const dbCollections = matchingColls.concat(extraDbColls, conflictCollInDb);

  await Promise.all(
    esCollections.map((collection) => indexer.indexCollection(esClient, collection, esAlias))
  );

  await Promise.all(
    dbCollections.map((collection) =>
      collectionPgModel.create(
        knex,
        translateApiCollectionToPostgresCollection(collection)
      ))
  );

  let report = await internalRecReportForCollections({});

  t.is(report.okCount, 10);
  t.is(report.onlyInEs.length, 2);
  t.deepEqual(report.onlyInEs.sort(),
    extraEsColls.map((coll) => constructCollectionId(coll.name, coll.version)).sort());
  t.is(report.onlyInDb.length, 2);
  t.deepEqual(report.onlyInDb.sort(),
    extraDbColls.map((coll) => constructCollectionId(coll.name, coll.version)).sort());
  t.is(report.withConflicts.length, 1);
  t.deepEqual(report.withConflicts[0].es.collectionId, conflictCollInEs.collectionId);
  t.deepEqual(report.withConflicts[0].db.collectionId, conflictCollInDb.collectionId);

  // start/end time include all the collections
  const searchParams = {
    startTimestamp: moment.utc().subtract(1, 'hour').format(),
    endTimestamp: moment.utc().add(1, 'hour').format(),
  };
  report = await internalRecReportForCollections(normalizeEvent(searchParams));
  t.is(report.okCount, 10);
  t.is(report.onlyInEs.length, 2);
  t.is(report.onlyInDb.length, 2);
  t.is(report.withConflicts.length, 1);

  // start/end time has no matching collections
  const paramsTimeOutOfRange = {
    startTimestamp: moment.utc().add(1, 'hour').format(),
    endTimestamp: moment.utc().add(2, 'hour').format(),
  };

  report = await internalRecReportForCollections(normalizeEvent(paramsTimeOutOfRange));
  t.is(report.okCount, 0);
  t.is(report.onlyInEs.length, 0);
  t.is(report.onlyInDb.length, 0);
  t.is(report.withConflicts.length, 0);

  // collectionId matches the collection with conflicts
  const collectionId = constructCollectionId(conflictCollInDb.name, conflictCollInDb.version);
  const paramsCollectionId = { ...searchParams, collectionId: [collectionId, randomId('c')] };

  report = await internalRecReportForCollections(normalizeEvent(paramsCollectionId));
  t.is(report.okCount, 0);
  t.is(report.onlyInEs.length, 0);
  t.is(report.onlyInDb.length, 0);
  t.is(report.withConflicts.length, 1);
});

test.serial('internalRecReportForGranules reports discrepancy of granule holdings in ES and DB', async (t) => {
  const { knex, collectionPgModel } = t.context;
  const collectionId = constructCollectionId(randomId('name'), randomId('version'));
  const provider = randomId('provider');

  const matchingGrans = range(10).map(() => fakeGranuleFactoryV2({ collectionId, provider }));
  const additionalMatchingGrans = range(10).map(() => fakeGranuleFactoryV2({ provider }));
  const extraDbGrans = range(2).map(() => fakeGranuleFactoryV2({ collectionId, provider }));
  const additionalExtraDbGrans = range(2).map(() => fakeGranuleFactoryV2());
  const extraEsGrans = range(2).map(() => fakeGranuleFactoryV2({ provider }));
  const additionalExtraEsGrans = range(2)
    .map(() => fakeGranuleFactoryV2({ collectionId, provider }));
  const conflictGranInDb = fakeGranuleFactoryV2({ collectionId, status: 'completed' });
  const conflictGranInEs = { ...conflictGranInDb, status: 'failed' };

  const esGranules = matchingGrans
    .concat(additionalMatchingGrans, extraEsGrans, additionalExtraEsGrans, conflictGranInEs);
  const dbGranules = matchingGrans
    .concat(additionalMatchingGrans, extraDbGrans, additionalExtraDbGrans, conflictGranInDb);

  // add granules and related collections to es and db
  await Promise.all(
    esGranules.map(async (gran) => {
      await indexer.indexGranule(esClient, gran, esAlias);
      const collection = fakeCollectionFactory({ ...deconstructCollectionId(gran.collectionId) });
      await indexer.indexCollection(esClient, collection, esAlias);
      await collectionPgModel.upsert(
        knex,
        translateApiCollectionToPostgresCollection(collection)
      );
    })
  );

  await new models.Granule().create(dbGranules);

  let report = await internalRecReportForGranules({});
  t.is(report.okCount, 20);
  t.is(report.onlyInEs.length, 4);
  t.deepEqual(report.onlyInEs.map((gran) => gran.granuleId).sort(),
    extraEsGrans.concat(additionalExtraEsGrans).map((gran) => gran.granuleId).sort());
  t.is(report.onlyInDb.length, 4);
  t.deepEqual(report.onlyInDb.map((gran) => gran.granuleId).sort(),
    extraDbGrans.concat(additionalExtraDbGrans).map((gran) => gran.granuleId).sort());
  t.is(report.withConflicts.length, 1);
  t.deepEqual(report.withConflicts[0].es.granuleId, conflictGranInEs.granuleId);
  t.deepEqual(report.withConflicts[0].db.granuleId, conflictGranInDb.granuleId);

  // start/end time include all the collections and granules
  const searchParams = {
    reportType: 'Internal',
    startTimestamp: moment.utc().subtract(1, 'hour').format(),
    endTimestamp: moment.utc().add(1, 'hour').format(),
  };
  report = await internalRecReportForGranules(normalizeEvent(searchParams));
  t.is(report.okCount, 20);
  t.is(report.onlyInEs.length, 4);
  t.is(report.onlyInDb.length, 4);
  t.is(report.withConflicts.length, 1);

  // start/end time has no matching collections and granules
  const outOfRangeParams = {
    startTimestamp: moment.utc().add(1, 'hour').format(),
    endTimestamp: moment.utc().add(2, 'hour').format(),
  };

  report = await internalRecReportForGranules(normalizeEvent(outOfRangeParams));
  t.is(report.okCount, 0);
  t.is(report.onlyInEs.length, 0);
  t.is(report.onlyInDb.length, 0);
  t.is(report.withConflicts.length, 0);

  // collectionId, provider parameters
  const collectionProviderParams = { ...searchParams, collectionId, provider };
  report = await internalRecReportForGranules(normalizeEvent(collectionProviderParams));
  t.is(report.okCount, 10);
  t.is(report.onlyInEs.length, 2);
  t.deepEqual(report.onlyInEs.map((gran) => gran.granuleId).sort(),
    additionalExtraEsGrans.map((gran) => gran.granuleId).sort());
  t.is(report.onlyInDb.length, 2);
  t.deepEqual(report.onlyInDb.map((gran) => gran.granuleId).sort(),
    extraDbGrans.map((gran) => gran.granuleId).sort());
  t.is(report.withConflicts.length, 0);

  // provider parameter
  const providerParams = { ...searchParams, provider: [randomId('p'), provider] };
  report = await internalRecReportForGranules(normalizeEvent(providerParams));
  t.is(report.okCount, 20);
  t.is(report.onlyInEs.length, 4);
  t.deepEqual(report.onlyInEs.map((gran) => gran.granuleId).sort(),
    extraEsGrans.concat(additionalExtraEsGrans).map((gran) => gran.granuleId).sort());
  t.is(report.onlyInDb.length, 2);
  t.deepEqual(report.onlyInDb.map((gran) => gran.granuleId).sort(),
    extraDbGrans.map((gran) => gran.granuleId).sort());
  t.is(report.withConflicts.length, 0);

  // collectionId, granuleId parameters
  const granuleId = conflictGranInDb.granuleId;
  const granuleIdParams = {
    ...searchParams,
    granuleId: [granuleId, extraEsGrans[0].granuleId, randomId('g')],
    collectionId: [collectionId, extraEsGrans[0].collectionId, extraEsGrans[1].collectionId],
  };
  report = await internalRecReportForGranules(normalizeEvent(granuleIdParams));
  t.is(report.okCount, 0);
  t.is(report.onlyInEs.length, 1);
  t.is(report.onlyInEs[0].granuleId, extraEsGrans[0].granuleId);
  t.is(report.onlyInDb.length, 0);
  t.is(report.withConflicts.length, 1);
});
