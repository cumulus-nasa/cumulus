'use strict';

const get = require('lodash.get');
const pMap = require('p-map');
const { AttributeValue } = require('dynamodb-data-types');
const { constructCollectionId } = require('@cumulus/common/collection-config-store');
const log = require('@cumulus/common/log');
const FileClass = require('../models/files');
const indexer = require('../es/indexer');
const { Search } = require('../es/search');
const unwrap = AttributeValue.unwrap;

const mapTableNameToIndexType = (tableName) => {
  const indexTypesByTableName = {
    [process.env.CollectionsTable]: 'collection',
    [process.env.ExecutionsTable]: 'execution',
    [process.env.GranulesTable]: 'granule',
    [process.env.PdrsTable]: 'pdr',
    [process.env.ProvidersTable]: 'provider',
    [process.env.RulesTable]: 'rule'
  };
  return indexTypesByTableName[tableName];
};

const mapTableNameToIndexFunction = (tableName) => {
  const indexFunctionsByTableName = {
    [process.env.CollectionsTable]: 'indexCollection',
    [process.env.ExecutionsTable]: 'indexExecution',
    [process.env.GranulesTable]: 'indexGranule',
    [process.env.PdrsTable]: 'indexPdr',
    [process.env.ProvidersTable]: 'indexProvider',
    [process.env.RulesTable]: 'indexRule'
  };
  return indexFunctionsByTableName[tableName];
};

/**
 * Delete files associated with a given granule if the record belongs
 * to the granules table
 *
 * @param {string} table - dynamoDB table name
 * @param {Object} record - the dynamoDB record
 * @returns {Promise<undefined>} undefined
 */
async function performFilesDelete(table, record) {
  const granuleTable = `${process.env.stackName}-GranulesTable`;
  // make sure this is the granules table
  if (table === granuleTable) {
    const model = new FileClass();
    await model.deleteFilesOfGranule(record);
  }
}

/**
 * Add files of a given granule if the record is coming from
 * a granule table
 *
 * @param {string} table - dynamoDB table name
 * @param {Object} data - the new dynamoDB record
 * @param {Object} oldData - the old dynamoDB record
 * @returns {Promise<undefined>} undefined
 */
async function performFilesAddition(table, data, oldData) {
  const granuleTable = `${process.env.stackName}-GranulesTable`;
  if (table === granuleTable) {
    const model = new FileClass();

    // create files
    await model.createFilesFromGranule(data);

    // remove files that are no longer in the granule
    await model.deleteFilesAfterCompare(data, oldData);
  }
}

/**
 * return the full of name of the dynamoDB table associated with incoming
 * record. The function returns empty response if the table name included
 * in the incoming message is not supported
 *
 * @param {string} sourceArn - the source arn included in the incoming message
 * @returns {string} name of the DynamoDB table
 */
function getTableName(sourceArn) {
  const tableName = sourceArn.match(/table\/(.[^\/]*)/);
  const acceptedTableNames = [
    process.env.CollectionsTable,
    process.env.ExecutionsTable,
    process.env.GranulesTable,
    process.env.PdrsTable,
    process.env.ProvidersTable,
    process.env.RulesTable
  ];
  if (!tableName || (!acceptedTableNames.includes(tableName[1]))) {
    return undefined;
  }
  return tableName[1];
}

/**
 * Perform the record indexing
 *
 * @param {string} indexFnName - Function name to index the record to Elasticsearch
 * @param {Object} esClient - ElasticSearch connection client
 * @param {Object} data - the record to be indexed
 * @returns {Promise<Object>} elasticsearch response
 */
function performIndex(indexFnName, esClient, data) {
  return indexer[indexFnName](esClient, data, process.env.ES_INDEX);
}

/**
 * Perform the delete operation for the given record
 *
 * @param {Object} esClient - ElasticSearch connection client
 * @param {string} type - type of record to index
 * @param {Object} fields - a hash of table keys and hashes
 * @param {Object} body - the body of the record
 * @returns {Promise<Object>} elasticsearch response
 */
function performDelete(esClient, type, fields, body) {
  let id;
  let parent;
  const idKeys = Object.keys(fields);
  if (idKeys.length > 1) {
    id = constructCollectionId(...Object.values(fields));
  } else {
    id = fields[idKeys[0]];
  }

  if (type === 'granule') {
    parent = body.collectionId;
  }

  return indexer
    .deleteRecord({
      esClient,
      id,
      type,
      parent,
      index: process.env.ES_INDEX
    });
}

/**
 * Index a given record. The function will determine whether the records
 * has to be added, updated or deleted. It will also determine which index
 * to use
 *
 * @param {Object} esClient - ElasticSearch connection client
 * @param {Object} record - the record to be indexed
 * @returns {Promise<Object>} the record indexed
 */
async function indexRecord(esClient, record) {
  // only process if the source is dynamoDB
  if (record.eventSource !== 'aws:dynamodb') return {};

  const tableName = getTableName(record.eventSourceARN);
  if (!tableName) return {};

  const indexFnName = mapTableNameToIndexFunction(tableName);
  const indexType = mapTableNameToIndexType(tableName);

  // get the hash and range (if any) and use them as id key for ES
  const fields = unwrap(get(record, 'dynamodb.Keys'));
  const body = unwrap(get(record, 'dynamodb.NewImage'));
  const data = Object.assign({}, fields, body);

  const oldBody = unwrap(get(record, 'dynamodb.OldImage'));
  const oldData = Object.assign({}, fields, oldBody);

  if (record.eventName === 'REMOVE') {
    // delete from files associated with a granule
    await performFilesDelete(tableName, oldBody);
    return performDelete(esClient, indexType, fields, oldBody);
  }

  // add files associated with a granule
  await performFilesAddition(tableName, data, oldData);

  return performIndex(indexFnName, esClient, data);
}

/**
 * Index incoming dynamoDB stream records
 *
 * @param {Array} records - aws DynamoDB records
 * @returns {Promise<Array>} array of records indexed
 */
async function indexRecords(records) {
  const esClient = await Search.es();

  return pMap(
    records,
    (record) => indexRecord(esClient, record).catch(log.error),
    { concurrency: process.env.CONCURRENCY || 3 }
  );
}

/**
 * The main handler for the lambda function
 *
 * @param {Object} event - aws lambda event object.
 */
const handler = async ({ Records }) =>
  (Records ? indexRecords(Records) : 'No records found in event');

module.exports = { handler };
