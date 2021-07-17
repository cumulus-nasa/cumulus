'use strict';

const cloneDeep = require('lodash/cloneDeep');
const pick = require('lodash/pick');
const sortBy = require('lodash/sortBy');
const isEqual = require('lodash/isEqual');
const intersection = require('lodash/intersection');
const union = require('lodash/union');
const omit = require('lodash/omit');
const moment = require('moment');
const pLimit = require('p-limit');
const Logger = require('@cumulus/logger');
const { constructCollectionId } = require('@cumulus/message/Collections');
const { s3 } = require('@cumulus/aws-client/services');
const { RecordDoesNotExist } = require('@cumulus/errors');
const { ESSearchQueue } = require('@cumulus/es-client/esSearchQueue');
const {
  CollectionPgModel,
  translatePostgresCollectionToApiCollection,
  getKnexClient,
} = require('@cumulus/db');

const { Granule } = require('../models');
const {
  convertToDBCollectionSearchObject,
  convertToESCollectionSearchParams,
  convertToESGranuleSearchParams,
  convertToDBGranuleSearchParams,
  filterDBCollections,
  initialReportHeader,
} = require('../lib/reconciliationReport');
const { DbGranuleSearchQueues } = require('../lib/reconciliationReport/DbGranuleSearchQueues');
const log = new Logger({ sender: '@api/lambdas/internal-reconciliation-report' });

/**
 * Compare the collection holdings in Elasticsearch with Database
 *
 * @param {Object} recReportParams - lambda's input filtering parameters to
 *                                   narrow limit of report.
 * @returns {Promise<Object>} an object with the okCount, onlyInEs, onlyInDb
 * and withConfilcts
 */
async function internalRecReportForCollections(recReportParams) {
  log.debug('internal-reconciliation-report internalRecReportForCollections');
  // compare collection holdings:
  //   Get collection list in ES ordered by granuleId
  //   Get collection list in DynamoDB ordered by granuleId
  //  Report collections only in ES
  //   Report collections only in DynamoDB
  //   Report collections with different contents

  const searchParams = convertToESCollectionSearchParams(recReportParams);
  const esCollectionsIterator = new ESSearchQueue(
    { ...searchParams, sort_key: ['name', 'version'] }, 'collection', process.env.ES_INDEX
  );

  const collectionPgModel = new CollectionPgModel();
  const knex = await getKnexClient();

  // get collections from database and sort them, since the scan result is not ordered
  const [updatedAtRangeParams, dbSearchParams] = convertToDBCollectionSearchObject(recReportParams);

  const dbCollectionsSearched = await collectionPgModel.searchWithUpdatedAtRange(
    knex,
    dbSearchParams,
    updatedAtRangeParams
  );

  const dbCollectionItems = sortBy(
    filterDBCollections(dbCollectionsSearched, recReportParams),
    ['name', 'version']
  );

  let okCount = 0;
  const withConflicts = [];
  let onlyInEs = [];
  let onlyInDb = [];

  const fieldsIgnored = ['timestamp', 'updatedAt'];
  let nextEsItem = await esCollectionsIterator.peek();
  let nextDbItem = (dbCollectionItems.length !== 0) ? dbCollectionItems[0] : undefined;

  while (nextEsItem && nextDbItem) {
    const esCollectionId = constructCollectionId(nextEsItem.name, nextEsItem.version);
    const dbCollectionId = constructCollectionId(nextDbItem.name, nextDbItem.version);

    if (esCollectionId < dbCollectionId) {
      // Found an item that is only in ES and not in DB
      onlyInEs.push(esCollectionId);
      await esCollectionsIterator.shift(); // eslint-disable-line no-await-in-loop
    } else if (esCollectionId > dbCollectionId) {
      // Found an item that is only in DB and not in ES
      onlyInDb.push(dbCollectionId);
      dbCollectionItems.shift();
    } else {
      // Found an item that is in both ES and DB
      if (
        isEqual(
          omit(nextEsItem, fieldsIgnored),
          omit(
            translatePostgresCollectionToApiCollection(nextDbItem),
            fieldsIgnored
          )
        )
      ) {
        okCount += 1;
      } else {
        withConflicts.push({ es: nextEsItem, db: nextDbItem });
      }
      esCollectionsIterator.shift();
      dbCollectionItems.shift();
    }

    nextEsItem = await esCollectionsIterator.peek(); // eslint-disable-line no-await-in-loop
    nextDbItem = (dbCollectionItems.length !== 0) ? dbCollectionItems[0] : undefined;
  }

  // Add any remaining ES items to the report
  onlyInEs = onlyInEs.concat(
    (await esCollectionsIterator.empty())
      .map((item) => constructCollectionId(item.name, item.version))
  );

  // Add any remaining DB items to the report
  onlyInDb = onlyInDb
    .concat(dbCollectionItems.map((item) => constructCollectionId(item.name, item.version)));

  return { okCount, withConflicts, onlyInEs, onlyInDb };
}

exports.internalRecReportForCollections = internalRecReportForCollections;

/**
 * Get all collectionIds from ES and database combined
 *
 * @returns {Promise<Array<string>>} list of collectionIds
 */
async function getAllCollections() {
  const collectionPgModel = new CollectionPgModel();
  const knex = await getKnexClient();

  const dbCollections = (await collectionPgModel.search(knex, {}))
    .map((collection) => constructCollectionId(collection.name, collection.version));

  const esCollectionsIterator = new ESSearchQueue(
    { sort_key: ['name', 'version'], fields: ['name', 'version'] }, 'collection', process.env.ES_INDEX
  );
  const esCollections = (await esCollectionsIterator.empty())
    .map((item) => constructCollectionId(item.name, item.version));

  return union(dbCollections, esCollections);
}

/**
 * Get list of collections for the given granuleIds
 *
 * @param {Array<string>} granuleIds - list of granuleIds
 * @returns {Promise<Array<string>>} list of collectionIds
 */
async function getCollectionsForGranules(granuleIds) {
  const limit = pLimit(process.env.CONCURRENCY || 3);

  const dbCollections = await Promise.all(
    granuleIds.map((granuleId) => limit(() =>
      new Granule().get({ granuleId })
        .then((granule) => (granule ? granule.collectionId : undefined))
        .catch((error) => {
          if (error instanceof RecordDoesNotExist) {
            return undefined;
          }
          throw error;
        })))
  );

  const esGranulesIterator = new ESSearchQueue(
    { granuleId__in: granuleIds.join(','), sort_key: ['collectionId'], fields: ['collectionId'] }, 'granule', process.env.ES_INDEX
  );
  const esCollections = (await esGranulesIterator.empty())
    .map((granule) => (granule ? granule.collectionId : undefined));

  return union(dbCollections, esCollections);
}

/**
 * Get list of collections for granule search based on input filtering parameters
 *
 * @param {Object} recReportParams - lambda's input filtering parameters
 * @returns {Promise<Array<string>>} list of collectionIds
 */
async function getCollectionsForGranuleSearch(recReportParams) {
  const { collectionIds, granuleIds } = recReportParams;
  // get collections list in ES and dynamoDB combined
  let collections = [];
  if (granuleIds) {
    const collectionIdsForGranules = await getCollectionsForGranules(granuleIds);
    collections = (collectionIds)
      ? intersection(collectionIds, collectionIdsForGranules)
      : collectionIdsForGranules;
  } else {
    collections = collectionIds || await getAllCollections();
  }
  return collections;
}

/**
 * Compare the granule holdings for a given collection
 *
 * @param {string} collectionId - collection id
 * @param {Object} recReportParams - lambda's input filtering parameters
 * @returns {Promise<Object>} an object with the okCount, onlyInEs, onlyInDb
 * and withConfilcts
 */
async function reportForGranulesByCollectionId(collectionId, recReportParams) {
  //   For each collection,
  //     Get granule list in ES ordered by granuleId
  //     Get granule list in DynamoDB ordered by granuleId
  //   Report granules only in ES
  //   Report granules only in DynamoDB
  //   Report granules with different contents

  const esSearchParams = convertToESGranuleSearchParams(recReportParams);
  const searchParams = convertToDBGranuleSearchParams(recReportParams);
  const esGranulesIterator = new ESSearchQueue(
    { ...esSearchParams, collectionId, sort_key: ['granuleId'] }, 'granule', process.env.ES_INDEX
  );

  const dbGranulesIterator = new DbGranuleSearchQueues(collectionId, searchParams);

  let okCount = 0;
  const withConflicts = [];
  const onlyInEs = [];
  const onlyInDb = [];
  const fieldsIgnored = ['timestamp', 'updatedAt'];

  const granuleFields = ['granuleId', 'collectionId', 'provider', 'createdAt', 'updatedAt'];
  let [nextEsItem, nextDbItem] = await Promise.all([esGranulesIterator.peek(), dbGranulesIterator.peek()]); // eslint-disable-line max-len

  /* eslint-disable no-await-in-loop */
  while (nextEsItem && nextDbItem) {
    if (nextEsItem.granuleId < nextDbItem.granuleId) {
      // Found an item that is only in ES and not in DB
      onlyInEs.push(pick(nextEsItem, granuleFields));
      await esGranulesIterator.shift();
    } else if (nextEsItem.granuleId > nextDbItem.granuleId) {
      // Found an item that is only in DB and not in ES
      onlyInDb.push(pick(nextDbItem, granuleFields));
      await dbGranulesIterator.shift();
    } else {
      // Found an item that is in both ES and DB
      if (isEqual(omit(nextEsItem, fieldsIgnored), omit(nextDbItem, fieldsIgnored))) {
        okCount += 1;
      } else {
        withConflicts.push({ es: nextEsItem, db: nextDbItem });
      }
      await Promise.all([esGranulesIterator.shift(), dbGranulesIterator.shift()]);
    }

    [nextEsItem, nextDbItem] = await Promise.all([esGranulesIterator.peek(), dbGranulesIterator.peek()]); // eslint-disable-line max-len
  }

  // Add any remaining ES items to the report
  while (await esGranulesIterator.peek()) {
    const item = await esGranulesIterator.shift();
    onlyInEs.push(pick(item, granuleFields));
  }

  // Add any remaining DB items to the report
  while (await dbGranulesIterator.peek()) {
    const item = await dbGranulesIterator.shift();
    onlyInDb.push(pick(item, granuleFields));
  }
  /* eslint-enable no-await-in-loop */

  return { okCount, withConflicts, onlyInEs, onlyInDb };
}

/**
 * Compare the granule holdings in Elasticsearch with Database
 *
 * @param {Object} recReportParams - lambda's input filtering parameters to
 *                                   narrow limit of report.
 * @returns {Promise<Object>} an object with the okCount, onlyInEs, onlyInDb
 * and withConfilcts
 */
async function internalRecReportForGranules(recReportParams) {
  log.debug('internal-reconciliation-report internalRecReportForGranules');
  // To avoid 'scan' granules table, we query a Global Secondary Index(GSI) in granules
  // table with collectionId.
  // compare granule holdings:
  //   Get collections list from db and es based on request parameters or use the collectionId
  //     from the request
  //   For each collection,
  //     compare granule holdings and get report
  //   Report granules only in ES
  //   Report granules only in DynamoDB
  //   Report granules with different contents

  const collections = await getCollectionsForGranuleSearch(recReportParams);

  const concurrencyLimit = process.env.CONCURRENCY || 3;
  const limit = pLimit(concurrencyLimit);
  const searchParams = omit(recReportParams, ['collectionIds']);

  const reports = await Promise.all(collections.map((collId) => limit(() =>
    reportForGranulesByCollectionId(collId, searchParams))));

  const report = {};
  report.okCount = reports
    .reduce((accumulator, currentValue) => accumulator + currentValue.okCount, 0);
  report.withConflicts = reports
    .reduce((accumulator, currentValue) => accumulator.concat(currentValue.withConflicts), []);
  report.onlyInEs = reports
    .reduce((accumulator, currentValue) => accumulator.concat(currentValue.onlyInEs), []);
  report.onlyInDb = reports
    .reduce((accumulator, currentValue) => accumulator.concat(currentValue.onlyInDb), []);

  return report;
}

exports.internalRecReportForGranules = internalRecReportForGranules;

/**
 * Create a Internal Reconciliation report and save it to S3
 *
 * @param {Object} recReportParams - params
 * @param {Object} params.collectionIds - array of collectionIds
 * @param {Object} recReportParams.reportType - the report type
 * @param {moment} recReportParams.createStartTime - when the report creation was begun
 * @param {moment} recReportParams.endTimestamp - ending report datetime ISO Timestamp
 * @param {string} recReportParams.reportKey - the s3 report key
 * @param {string} recReportParams.stackName - the name of the CUMULUS stack
 * @param {moment} recReportParams.startTimestamp - beginning report datetime ISO timestamp
 * @param {string} recReportParams.systemBucket - the name of the CUMULUS system bucket
 * @returns {Promise<null>} a Promise that resolves when the report has been
 *   uploaded to S3
 */
async function createInternalReconciliationReport(recReportParams) {
  log.debug(`createInternalReconciliationReport parameters ${JSON.stringify(recReportParams)}`);
  const {
    reportKey,
    systemBucket,
  } = recReportParams;

  // Write an initial report to S3
  const initialReportFormat = {
    okCount: 0,
    withConflicts: [],
    onlyInEs: [],
    onlyInDb: [],
  };

  let report = {
    ...initialReportHeader(recReportParams),
    collections: cloneDeep(initialReportFormat),
    granules: cloneDeep(initialReportFormat),
  };

  await s3().putObject({
    Bucket: systemBucket,
    Key: reportKey,
    Body: JSON.stringify(report),
  }).promise();

  const [collectionsReport, granulesReport] = await Promise.all([
    internalRecReportForCollections(recReportParams),
    internalRecReportForGranules(recReportParams),
  ]);
  report = Object.assign(report, { collections: collectionsReport, granules: granulesReport });

  // Create the full report
  report.createEndTime = moment.utc().toISOString();
  report.status = 'SUCCESS';

  // Write the full report to S3
  return s3().putObject({
    Bucket: systemBucket,
    Key: reportKey,
    Body: JSON.stringify(report),
  }).promise();
}

exports.createInternalReconciliationReport = createInternalReconciliationReport;
