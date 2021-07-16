/* functions for transforming and indexing Cumulus Payloads
 * in Elasticsearch. These functions are specifically designed
 * to transform data for use in cumulus api
 *
 * The module accepts the following kinds of workflows (state machines):
 * - ParsePdrs
 * - IngestGranules
 * - StateMachine (if a payload doesn't belong to previous ones)
 */

'use strict';

const cloneDeep = require('lodash/cloneDeep');

const Logger = require('@cumulus/logger');
const { inTestMode } = require('@cumulus/common/test-utils');
const { IndexExistsError } = require('@cumulus/errors');
const { constructCollectionId } = require('@cumulus/message/Collections');

const { Search, defaultIndexAlias } = require('./search');
const mappings = require('./config/mappings.json');

const logger = new Logger({ sender: '@cumulus/es-client/indexer' });

async function createIndex(esClient, indexName) {
  const indexExists = await esClient.indices.exists({ index: indexName })
    .then((response) => response.body);

  if (indexExists) {
    throw new IndexExistsError(`Index ${indexName} exists and cannot be created.`);
  }

  await esClient.indices.create({
    index: indexName,
    body: {
      mappings,
      settings: {
        index: {
          number_of_shards: process.env.ES_INDEX_SHARDS || 1,
        },
      },
    },
  });

  logger.info(`Created esIndex ${indexName}`);
}

/**
 * Indexes a given record to the specified Elasticsearch index and type
 *
 * @param  {Object} esClient - Elasticsearch Connection object
 * @param  {string} id       - the record id
 * @param  {Object} doc      - the record
 * @param  {string} index    - Elasticsearch index alias
 * @param  {string} type     - Elasticsearch type
 * @param  {string} parent   - the optional parent id
 * @returns {Promise} Elasticsearch response
 */
async function genericRecordUpdate(esClient, id, doc, index, type, parent) {
  if (!doc) throw new Error('Nothing to update. Make sure doc argument has a value');

  const body = cloneDeep(doc);
  body.timestamp = Date.now();

  const params = {
    body,
    id,
    index,
    type,
    refresh: inTestMode(),
  };

  if (parent) params.parent = parent;

  // adding or replacing record to ES
  const actualEsClient = esClient || (await Search.es());
  let indexResponse;
  try {
    indexResponse = await actualEsClient.index(params);
  } catch (error) {
    logger.error(`Error thrown on index ${JSON.stringify(error)}`);
    throw error;
  }
  return indexResponse.body;
}

/**
 * Updates a given record for the Elasticsearch index and type
 *
 * @param  {Object} esClient - Elasticsearch Connection object
 * @param  {string} id       - the record id
 * @param  {Object} doc      - the record
 * @param  {string} index    - Elasticsearch index alias
 * @param  {string} type     - Elasticsearch type
 * @returns {Promise} Elasticsearch response
 */
async function updateExistingRecord(esClient, id, doc, index, type) {
  return await esClient.update({
    index,
    type,
    id,
    body: {
      doc: {
        ...doc,
        timestamp: Date.now(),
      },
    },
    refresh: inTestMode(),
  });
}

/**
 * Updates an asyncOperation record in Elasticsearch
 *
 * @param  {Object} esClient - Elasticsearch Connection object
 * @param  {Object} id - Record ID
 * @param  {Object} updates - Document of updates to apply
 * @param  {string} index - Elasticsearch index alias (default defined in search.js)
 * @param  {string} type - Elasticsearch type (default: asyncOperation)
 * @returns {Promise} elasticsearch update response
 */
function updateAsyncOperation(esClient, id, updates, index = defaultIndexAlias, type = 'asyncOperation') {
  return updateExistingRecord(esClient, id, updates, index, type);
}

/**
 * Indexes a step function message to Elastic Search. The message must
 * comply with the cumulus message protocol
 *
 * @param  {Object} esClient - Elasticsearch Connection object
 * @param  {Object} payload  - Cumulus Step Function message
 * @param  {string} index    - Elasticsearch index alias (default defined in search.js)
 * @param  {string} type     - Elasticsearch type (default: execution)
 * @returns {Promise} elasticsearch update response
 */
function indexExecution(esClient, payload, index = defaultIndexAlias, type = 'execution') {
  return genericRecordUpdate(esClient, payload.arn, payload, index, type);
}

/**
 * Indexes the asyncOperation type on Elasticsearch
 *
 * @param  {Object} esClient - Elasticsearch Connection object
 * @param  {Object} payload  - Cumulus Step Function message
 * @param  {string} index    - Elasticsearch index alias (default defined in search.js)
 * @param  {string} type     - Elasticsearch type (default: asyncOperation)
 * @returns {Promise} elasticsearch update response
 */
function indexAsyncOperation(esClient, payload, index = defaultIndexAlias, type = 'asyncOperation') {
  return genericRecordUpdate(esClient, payload.id, payload, index, type);
}

/**
 * Indexes the collection on Elasticsearch
 *
 * @param  {Object} esClient - Elasticsearch Connection object
 * @param  {Object} collection - the collection record
 * @param  {string} index - Elasticsearch index alias (default defined in search.js)
 * @param  {string} type - Elasticsearch type (default: collection)
 * @returns {Promise} Elasticsearch response
 */
function indexCollection(esClient, collection, index = defaultIndexAlias, type = 'collection') {
  const collectionId = constructCollectionId(collection.name, collection.version);
  return genericRecordUpdate(esClient, collectionId, collection, index, type);
}

/**
 * Indexes the provider type on Elasticsearch
 *
 * @param  {Object} esClient - Elasticsearch Connection object
 * @param  {Object} payload  - the provider record
 * @param  {string} index    - Elasticsearch index alias (default defined in search.js)
 * @param  {string} type     - Elasticsearch type (default: provider)
 * @returns {Promise} Elasticsearch response
 */
function indexProvider(esClient, payload, index = defaultIndexAlias, type = 'provider') {
  return genericRecordUpdate(esClient, payload.id, payload, index, type);
}

/**
 * Indexes the reconciliationReport type on Elasticsearch
 *
 * @param  {Object} esClient - Elasticsearch Connection object
 * @param  {Object} payload  - the ReconciliationReport record
 * @param  {string} index    - Elasticsearch index alias (default defined in search.js)
 * @param  {string} type     - Elasticsearch type (default: reconciliationReport)
 * @returns {Promise} Elasticsearch response
 */
function indexReconciliationReport(esClient, payload, index = defaultIndexAlias, type = 'reconciliationReport') {
  return genericRecordUpdate(esClient, payload.name, payload, index, type);
}

/**
 * Indexes the rule type on Elasticsearch
 *
 * @param  {Object} esClient - Elasticsearch Connection object
 * @param  {Object} payload  - the Rule record
 * @param  {string} index    - Elasticsearch index alias (default defined in search.js)
 * @param  {string} type     - Elasticsearch type (default: rule)
 * @returns {Promise} Elasticsearch response
 */

function indexRule(esClient, payload, index = defaultIndexAlias, type = 'rule') {
  return genericRecordUpdate(esClient, payload.name, payload, index, type);
}

/**
 * Indexes the granule type on Elasticsearch
 *
 * @param  {Object} esClient - Elasticsearch Connection object
 * @param  {Object} payload  - Cumulus Step Function message
 * @param  {string} index    - Elasticsearch index alias (default defined in search.js)
 * @param  {string} type     - Elasticsearch type (default: granule)
 * @returns {Promise} Elasticsearch response
 */
async function indexGranule(esClient, payload, index = defaultIndexAlias, type = 'granule') {
  // If the granule exists in 'deletedgranule', delete it first before inserting the granule
  // into ES.  Ignore 404 error, so the deletion still succeeds if the record doesn't exist.
  const delGranParams = {
    index,
    type: 'deletedgranule',
    id: payload.granuleId,
    parent: payload.collectionId,
    refresh: inTestMode(),
  };
  await esClient.delete(delGranParams, { ignore: [404] });

  return genericRecordUpdate(
    esClient,
    payload.granuleId,
    payload,
    index,
    type,
    payload.collectionId
  );
}

/**
 * Indexes the pdr type on Elasticsearch
 *
 * @param  {Object} esClient - Elasticsearch Connection object
 * @param  {Object} payload  - Cumulus Step Function message
 * @param  {string} index    - Elasticsearch index alias (default defined in search.js)
 * @param  {string} type     - Elasticsearch type (default: pdr)
 * @returns {Promise} Elasticsearch response
 */
async function indexPdr(esClient, payload, index = defaultIndexAlias, type = 'pdr') {
  return await genericRecordUpdate(
    esClient,
    payload.pdrName,
    payload,
    index,
    type
  );
}

/**
 * delete a record from Elasticsearch
 *
 * @param  {Object} params
 * @param  {Object} params.esClient - Elasticsearch Connection object
 * @param  {string} params.id       - id of the Elasticsearch record
 * @param  {string} params.type     - Elasticsearch type (default: execution)
 * @param  {strint} params.parent   - id of the parent (optional)
 * @param  {string} params.index    - Elasticsearch index (default: cumulus)
 * @param  {Array}  params.ignore   - Response codes to ignore (optional)
 * @returns {Promise} elasticsearch delete response
 */
async function deleteRecord({
  esClient,
  id,
  type,
  parent,
  index = defaultIndexAlias,
  ignore,
}) {
  const params = {
    index,
    type,
    id,
    refresh: inTestMode(),
  };

  let options = {};

  if (parent) params.parent = parent;
  if (ignore) options = { ignore };

  const actualEsClient = esClient || (await Search.es());
  const deleteResponse = await actualEsClient.delete(params, options);
  return deleteResponse.body;
}

/**
 * Deletes the collection in Elasticsearch
 *
 * @param  {Object} params
 * @param  {Object} params.esClient - Elasticsearch Connection object
 * @param  {string} params.collectionId - the collection ID
 * @param  {string[]} [params.ignore] - Array of response codes to ignore
 * @param  {string} params.index - Elasticsearch index alias (default defined in search.js)
 * @param  {string} params.type - Elasticsearch type (default: collection)
 * @returns {Promise} Elasticsearch response
 */
function deleteCollection({
  esClient,
  collectionId,
  ignore,
  index = defaultIndexAlias,
  type = 'collection',
}) {
  return deleteRecord({
    esClient,
    id: collectionId,
    index,
    type,
    ignore,
  });
}

/**
 * Deletes the provider in Elasticsearch
 *
 * @param  {Object} params
 * @param  {Object} params.esClient - Elasticsearch Connection object
 * @param  {string} params.id - the provider ID
 * @param  {string[]} [params.ignore] - Array of response codes to ignore
 * @param  {string} params.index - Elasticsearch index alias (default defined in search.js)
 * @param  {string} params.type - Elasticsearch type (default: provider)
 * @returns {Promise} Elasticsearch response
 */
function deleteProvider({
  esClient,
  id,
  ignore,
  index = defaultIndexAlias,
  type = 'provider',
}) {
  return deleteRecord({
    esClient,
    id,
    index,
    type,
    ignore,
  });
}

/**
 * Deletes the rule in Elasticsearch
 *
 * @param  {Object} params
 * @param  {Object} params.esClient - Elasticsearch Connection object
 * @param  {string} params.name - the rule name
 * @param  {string[]} [params.ignore] - Array of response codes to ignore
 * @param  {string} params.index - Elasticsearch index alias (default defined in search.js)
 * @param  {string} params.type - Elasticsearch type (default: rule)
 * @returns {Promise} Elasticsearch response
 */
function deleteRule({
  esClient,
  name,
  ignore,
  index = defaultIndexAlias,
  type = 'rule',
}) {
  return deleteRecord({
    esClient,
    id: name,
    index,
    type,
    ignore,
  });
}

/**
 * Deletes the PDR in Elasticsearch
 *
 * @param  {Object} params
 * @param  {Object} params.esClient - Elasticsearch Connection object
 * @param  {string} params.name - the PDR name
 * @param  {string[]} [params.ignore] - Array of response codes to ignore
 * @param  {string} params.index - Elasticsearch index alias (default defined in search.js)
 * @param  {string} params.type - Elasticsearch type (default: PDR)
 * @returns {Promise} Elasticsearch response
 */
function deletePdr({
  esClient,
  name,
  ignore,
  index = defaultIndexAlias,
  type = 'pdr',
}) {
  return deleteRecord({
    esClient,
    id: name,
    index,
    type,
    ignore,
  });
}

/**
 * Deletes the execution in Elasticsearch
 *
 * @param  {Object} params
 * @param  {Object} params.esClient - Elasticsearch Connection object
 * @param  {string} params.arn - execution ARN
 * @param  {string[]} [params.ignore] - Array of response codes to ignore
 * @param  {string} params.index - Elasticsearch index alias (default defined in search.js)
 * @param  {string} params.type - Elasticsearch type (default: execution)
 * @returns {Promise} Elasticsearch response
 */
function deleteExecution({
  esClient,
  arn,
  ignore,
  index = defaultIndexAlias,
  type = 'execution',
}) {
  return deleteRecord({
    esClient,
    id: arn,
    index,
    type,
    ignore,
  });
}

/**
 * Deletes the async operation in Elasticsearch
 *
 * @param {Object} params
 * @param {Object} params.esClient - Elasticsearch Connection object
 * @param {string} params.id - the async operation ID
 * @param {string[]} [params.ignore] - Array of response codes to ignore
 * @param {string} params.index - Elasticsearch index alias (default defined in search.js)
 * @param {string} params.type - Elasticsearch type (default: asyncOperation)
 * @returns {Promise} Elasticsearch response
*/
function deleteAsyncOperation({
  esClient,
  id,
  ignore,
  index = defaultIndexAlias,
  type = 'asyncOperation',
}) {
  return deleteRecord({
    esClient,
    id,
    index,
    type,
    ignore,
  });
}

/**
 * Deletes the reconciliation report from Elasticsearch
 *
 * @param  {Object} params
 * @param  {Object} params.esClient - Elasticsearch Connection object
 * @param  {string} params.name - reconciliation report name
 * @param  {string[]} [params.ignore] - Array of response codes to ignore
 * @param  {string} params.index - Elasticsearch index alias (default defined in search.js)
 * @param  {string} params.type - Elasticsearch type (default: reconciliationReport)
 * @returns {Promise} Elasticsearch response
 */
function deleteReconciliationReport({
  esClient,
  name,
  ignore,
  index = defaultIndexAlias,
  type = 'reconciliationReport',
}) {
  return deleteRecord({
    esClient,
    id: name,
    index,
    type,
    ignore,
  });
}

/**
 * Deletes the granule in Elasticsearch
 *
 * @param  {Object} params
 * @param  {Object} params.esClient - Elasticsearch Connection object
 * @param  {string} params.granuleId - the granule ID
 * @param  {string} params.collectionId - the collection ID
 * @param  {string[]} [params.ignore] - Array of response codes to ignore
 * @param  {string} params.index - Elasticsearch index alias (default defined in search.js)
 * @param  {string} params.type - Elasticsearch type (default: granule)
 * @returns {Promise} Elasticsearch response
 */
async function deleteGranule({
  esClient,
  granuleId,
  collectionId,
  ignore,
  index = defaultIndexAlias,
  type = 'granule',
}) {
  const esGranulesClient = new Search(
    {},
    type,
    index
  );
  const granuleEsRecord = await esGranulesClient.get(granuleId, collectionId);

  // When a 'granule' record is deleted, the record is added to 'deletedgranule' type
  const deletedGranuleDoc = granuleEsRecord;
  delete deletedGranuleDoc._id;
  deletedGranuleDoc.timestamp = Date.now();
  deletedGranuleDoc.deletedAt = Date.now();
  await genericRecordUpdate(
    esClient,
    granuleId,
    deletedGranuleDoc,
    index,
    'deletedgranule',
    collectionId
  );

  return await deleteRecord({
    esClient,
    id: granuleId,
    parent: collectionId,
    index,
    type,
    ignore,
  });
}

/**
 * Index a record to local Elasticsearch. Used when running API locally.
 *
 * @param {Object} record - Record object
 * @param {function} doIndex - Function to do indexing operation
 * @returns {Promise} - Promise of indexing operation
 */
async function addToLocalES(record, doIndex) {
  const esClient = await Search.es(process.env.ES_HOST);
  return doIndex(esClient, record, process.env.ES_INDEX);
}

module.exports = {
  addToLocalES,
  createIndex,
  indexCollection,
  indexProvider,
  indexReconciliationReport,
  indexRule,
  indexGranule,
  indexPdr,
  indexExecution,
  indexAsyncOperation,
  deleteRecord,
  deleteAsyncOperation,
  updateAsyncOperation,
  deleteCollection,
  deleteProvider,
  deleteRule,
  deletePdr,
  deleteGranule,
  deleteExecution,
  deleteReconciliationReport,
};
