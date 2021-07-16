'use strict';

const AggregateError = require('aggregate-error');
const isEmpty = require('lodash/isEmpty');
const pMap = require('p-map');

const { s3 } = require('@cumulus/aws-client/services');
const CmrUtils = require('@cumulus/cmrjs/cmr-utils');
const { buildURL } = require('@cumulus/common/URLUtils');
const {
  translateApiFiletoPostgresFile,
  FilePgModel,
  GranulePgModel,
  upsertGranuleWithExecutionJoinRecord,
} = require('@cumulus/db');
const {
  indexGranule,
} = require('@cumulus/es-client/indexer');
const {
  Search,
} = require('@cumulus/es-client/search');
const Logger = require('@cumulus/logger');
const { getCollectionIdFromMessage } = require('@cumulus/message/Collections');
const {
  getMessageExecutionArn,
  getExecutionUrlFromArn,
} = require('@cumulus/message/Executions');
const {
  generateGranuleApiRecord,
  getGranuleProductVolume,
  getGranuleQueryFields,
  getGranuleStatus,
  getGranuleTimeToArchive,
  getGranuleTimeToPreprocess,
  getMessageGranules,
  messageHasGranules,
} = require('@cumulus/message/Granules');
const {
  getMessagePdrName,
} = require('@cumulus/message/PDRs');
const {
  getMessageProvider,
} = require('@cumulus/message/Providers');
const {
  getMessageWorkflowStartTime,
  getMetaStatus,
  getWorkflowDuration,
} = require('@cumulus/message/workflows');
const { parseException } = require('@cumulus/message/utils');

const FileUtils = require('../../lib/FileUtils');
const {
  getExecutionProcessingTimeInfo,
} = require('../../lib/granules');
const Granule = require('../../models/granules');

const logger = new Logger({ sender: '@cumulus/sfEventSqsToDbRecords/write-granules' });

/**
 * Generate a Granule record to save to the core database from a Cumulus message
 * and other contextual information
 *
 * @param {Object} params
 * @param {string} params.collectionId - Collection ID for the workflow
 * @param {Object} params.granule - Granule object from workflow message
 * @param {Array<Object>} params.files - Granule file objects
 * @param {Object} params.queryFields - Arbitrary query fields for the granule
 * @param {number} params.collectionCumulusId
 *   Cumulus ID of collection referenced in workflow message
 * @param {number} params.providerCumulusId
 *   Cumulus ID of provider referenced in workflow message
 * @param {number} params.pdrCumulusId
 *   Cumulus ID of PDR referenced in workflow message
 * @param {Object} [params.processingTimeInfo={}]
 *   Info describing the processing time for the granule
 * @param {Object} [params.cmrUtils=CmrUtils]
 *   Utilities for interacting with CMR
 * @param {number} [params.timestamp] - Timestamp for granule record. Defaults to now.
 * @param {number} [params.updatedAt] - Updated timestamp for granule record. Defaults to now.
 * @returns {Promise<Object>} - a granule record
 */
const generateGranuleRecord = async ({
  error,
  granule,
  files,
  workflowStartTime,
  workflowStatus,
  queryFields,
  collectionCumulusId,
  providerCumulusId,
  pdrCumulusId,
  processingTimeInfo = {},
  cmrUtils = CmrUtils,
  timestamp = Date.now(),
  updatedAt = Date.now(),
}) => {
  const {
    granuleId,
    cmrLink,
    published = false,
  } = granule;

  const temporalInfo = await cmrUtils.getGranuleTemporalInfo(granule);

  return {
    granule_id: granuleId,
    status: getGranuleStatus(workflowStatus, granule),
    cmr_link: cmrLink,
    error,
    published,
    created_at: new Date(workflowStartTime),
    updated_at: new Date(updatedAt),
    timestamp: new Date(timestamp),
    duration: getWorkflowDuration(workflowStartTime, timestamp),
    product_volume: getGranuleProductVolume(files),
    time_to_process: getGranuleTimeToPreprocess(granule),
    time_to_archive: getGranuleTimeToArchive(granule),
    collection_cumulus_id: collectionCumulusId,
    provider_cumulus_id: providerCumulusId,
    pdr_cumulus_id: pdrCumulusId,
    // Temporal info from CMR
    beginning_date_time: temporalInfo.beginningDateTime,
    ending_date_time: temporalInfo.endingDateTime,
    production_date_time: temporalInfo.productionDateTime,
    last_update_date_time: temporalInfo.lastUpdateDateTime,
    // Processing info from execution
    processing_start_date_time: processingTimeInfo.processingStartDateTime,
    processing_end_date_time: processingTimeInfo.processingEndDateTime,
    query_fields: queryFields,
  };
};

/**
 * Generate a file record to save to the core database.
 *
 * @param {Object} params
 * @param {Object} params.file - File object
 * @param {number} params.granuleCumulusId
 *   Cumulus ID of the granule for this file
 * @returns {Object} - a file record
 */
const generateFilePgRecord = ({ file, granuleCumulusId }) => ({
  ...translateApiFiletoPostgresFile(file),
  granule_cumulus_id: granuleCumulusId,
});

/**
 * Generate file records to save to the core database.
 *
 * @param {Object} params
 * @param {Object} params.files - File objects
 * @param {number} params.granuleCumulusId
 *   Cumulus ID of the granule for this file
 * @returns {Array<Object>} - file records
 */
const _generateFilePgRecords = ({
  files,
  granuleCumulusId,
}) => files.map((file) => generateFilePgRecord({ file, granuleCumulusId }));

/**
 * Write an array of file records to the database
 *
 * @param {Object} params
 * @param {Object} params.fileRecords - File objects
 * @param {Knex} params.knex - Client to interact with PostgreSQL database
 * @param {Object} params.filePgModel - Optional File model override
 * @returns {Promise} - Promise resolved once all file upserts resolve
 */
const _writeFiles = async ({
  fileRecords,
  knex,
  filePgModel = new FilePgModel(),
}) => await pMap(
  fileRecords,
  async (fileRecord) => {
    logger.info('About to write file record to PostgreSQL: %j', fileRecord);
    await filePgModel.upsert(knex, fileRecord);
    logger.info('Successfully wrote file record to PostgreSQL: %j', fileRecord);
  },
  { stopOnError: false }
);

/**
 * Get the cumulus ID from a query result or look it up in the database.
 *
 * For certain cases, such as an upsert query that matched no rows, an empty
 * database result is returned, so no cumulus ID will be returned. In those
 * cases, this function will lookup the granule cumulus ID from the record.
 *
 * @param {Object} params
 * @param {Object} params.trx - A Knex transaction
 * @param {Object} params.queryResult - Query result
 * @param {Object} params.granuleRecord - A granule record
 * @param {Object} params.granulePgModel - Database model for granule data
 * @returns {Promise<number|undefined>} - Cumulus ID for the granule record
 */
const getGranuleCumulusIdFromQueryResultOrLookup = async ({
  queryResult = [],
  granuleRecord,
  trx,
  granulePgModel = new GranulePgModel(),
}) => {
  let [granuleCumulusId] = queryResult;
  if (!granuleCumulusId) {
    granuleCumulusId = await granulePgModel.getRecordCumulusId(
      trx,
      { granule_id: granuleRecord.granule_id }
    );
  }
  return granuleCumulusId;
};

/**
 * Write a granule to DynamoDB and PostgreSQL
 *
 * @param {Object} params
 * @param {Object} params.granule - An API granule object
 * @param {Object} params.processingTimeInfo
 *   Processing time information for the granule, if any
 * @param {Object} params.error - Workflow error, if any
 * @param {string} params.workflowStartTime - Workflow start time
 * @param {string} params.workflowStatus - Workflow status
 * @param {Object} params.queryFields - Arbitrary query fields for the granule
 * @param {string} params.collectionCumulusId
 *   Cumulus ID for collection referenced in workflow message, if any
 * @param {string} params.providerCumulusId
 *   Cumulus ID for provider referenced in workflow message, if any
 * @param {string} params.executionCumulusId
 *   Cumulus ID for execution referenced in workflow message, if any
 * @param {string} params.pdrCumulusId
 *   Cumulus ID for PDR referenced in workflow message, if any
 * @param {Knex.transaction} params.trx - Transaction to interact with PostgreSQL database
 * @param {string} params.updatedAt - Update timestamp
 * @param {Array} params.files - List of files to add to Dynamo Granule
 *
 * @returns {Promise<number>} - Cumulus ID from PostgreSQL
 * @throws
 */
const _writeGranuleViaTransaction = async ({
  granule,
  processingTimeInfo,
  error,
  workflowStartTime,
  workflowStatus,
  queryFields,
  collectionCumulusId,
  providerCumulusId,
  executionCumulusId,
  pdrCumulusId,
  trx,
  updatedAt,
  files,
}) => {
  const granuleRecord = await generateGranuleRecord({
    error,
    granule,
    files,
    workflowStartTime,
    workflowStatus,
    queryFields,
    collectionCumulusId,
    providerCumulusId,
    pdrCumulusId,
    processingTimeInfo,
    updatedAt,
  });

  logger.info(`About to write granule with granuleId ${granuleRecord.granule_id}, collection_cumulus_id ${collectionCumulusId} to PostgreSQL`);

  const upsertQueryResult = await upsertGranuleWithExecutionJoinRecord(
    trx,
    granuleRecord,
    executionCumulusId
  );
  // Ensure that we get a granule ID for the files even if the
  // upsert query returned an empty result
  const granuleCumulusId = await getGranuleCumulusIdFromQueryResultOrLookup({
    trx,
    queryResult: upsertQueryResult,
    granuleRecord,
  });

  logger.info(`
    Successfully wrote granule with granuleId ${granuleRecord.granule_id}, collection_cumulus_id ${collectionCumulusId}
    to granule record with cumulus_id ${granuleCumulusId} in PostgreSQL
  `);
  return granuleCumulusId;
};

/**
 * Generate file records based on workflow status, write files to
 * the database, and update granule status if file writes fail
 *
 * @param {Object} params
 * @param {Object} params.files - File objects
 * @param {number} params.granuleCumulusId - Cumulus ID of the granule for this file
 * @param {string} params.granule - Granule from the payload
 * @param {Object} params.workflowError - Error from the workflow
 * @param {string} params.workflowStatus - Workflow status
 * @param {Knex} params.knex - Client to interact with PostgreSQL database
 * @param {Object} [params.granuleModel] - Optional Granule DDB model override
 * @param {Object} [params.granulePgModel] - Optional Granule PG model override
 * @returns {undefined}
 */
const _writeGranuleFiles = async ({
  files,
  granuleCumulusId,
  granule,
  workflowError,
  workflowStatus,
  knex,
  granuleModel = new Granule(),
  granulePgModel = new GranulePgModel(),
}) => {
  let fileRecords = [];

  if (workflowStatus !== 'running') {
    fileRecords = _generateFilePgRecords({
      files: files,
      granuleCumulusId,
    });
  }

  try {
    await _writeFiles({
      fileRecords,
      knex,
    });
  } catch (error) {
    if (!isEmpty(workflowError)) {
      logger.error(`Logging existing error encountered by granule ${granule.granuleId} before overwrite`, workflowError);
    }
    logger.error('Failed writing files to PostgreSQL, updating granule with error', error);
    const errorObject = {
      Error: 'Failed writing files to PostgreSQL.',
      Cause: error.toString(),
    };
    await knex.transaction(async (trx) => {
      await granulePgModel.update(
        trx,
        { cumulus_id: granuleCumulusId },
        {
          status: 'failed',
          error: errorObject,
        }
      ).catch((updateError) => {
        logger.fatal('Failed to update PostgreSQL granule status on file write failure!', updateError);
        throw updateError;
      });

      await granuleModel.update(
        { granuleId: granule.granuleId },
        {
          status: 'failed',
          error: errorObject,
        }
      ).catch((updateError) => {
        logger.fatal('Failed to update DynamoDb granule status on file write failure!', updateError);
        throw updateError;
      });
    });
  }
};

/**
 * Transform granule files to latest file API structure
 *
 * @param {Object} params
 * @param {Object} params.granule - An API granule object
 * @param {Object} params.provider - An API provider object
 *
* @returns {Promise<Array>} - A list of file objects once resolved
 */
const _generateFilesFromGranule = async ({
  granule,
  provider,
}) => {
  const { files = [] } = granule;
  // This is necessary to set properties like
  // `key`, which is required for the PostgreSQL schema. And
  // `size` which is used to calculate the granule product
  // volume
  return await FileUtils.buildDatabaseFiles({
    s3: s3(),
    providerURL: buildURL(provider),
    files,
  });
};

const writeGranuleToDynamoAndEs = async (params) => {
  const {
    granule,
    executionUrl,
    collectionId,
    provider,
    workflowStartTime,
    error,
    pdrName,
    workflowStatus,
    processingTimeInfo,
    queryFields,
    granuleModel,
    cmrUtils = CmrUtils,
    updatedAt = Date.now(),
    esClient = await Search.es(),
  } = params;
  const granuleApiRecord = await generateGranuleApiRecord({
    granule,
    executionUrl,
    collectionId,
    provider,
    workflowStartTime,
    error,
    pdrName,
    workflowStatus,
    processingTimeInfo,
    queryFields,
    updatedAt,
    cmrUtils,
  });
  try {
    await granuleModel.storeGranuleFromCumulusMessage(granuleApiRecord);
    await indexGranule(esClient, granuleApiRecord, process.env.ES_INDEX);
  } catch (writeError) {
    // On error, delete the Dynamo record to ensure that all systems
    // stay in sync
    await granuleModel.delete({
      granuleId: granuleApiRecord.granuleId,
      collectionId: granuleApiRecord.collectionId,
    });
    throw writeError;
  }
};

/**
 * Write a granule to DynamoDB and PostgreSQL
 *
 * @param {Object} params
 * @param {string} params.collectionId - Collection ID for the workflow
 * @param {Object} params.granule - An API granule object
 * @param {Object} params.provider - Provider object
 * @param {string} params.workflowStatus - Workflow status
 * @param {string} params.collectionCumulusId
 *   Cumulus ID for collection referenced in workflow message, if any
 * @param {string} params.executionCumulusId
 *   Cumulus ID for execution referenced in workflow message, if any
 * @param {Knex} params.knex - Client to interact with PostgreSQL database
 * @param {Object} [params.error] - Workflow error, if any
 * @param {string} [params.executionUrl]
 *   Step Function execution URL for the workflow, if any
 * @param {Object} [params.processingTimeInfo]
 *   Processing time information for the granule, if any
 * @param {string} [params.providerCumulusId]
 *   Cumulus ID for provider referenced in workflow message, if any
 * @param {string} [params.pdrCumulusId]
 *   Cumulus ID for PDR referenced in workflow message, if any
 * @param {Object} [params.granuleModel]
 *   Optional override for the granule model writing to DynamoDB
 *
 * @returns {Promise}
 * @throws
 */
const _writeGranule = async ({
  collectionId,
  granule,
  pdrName,
  provider,
  workflowStartTime,
  workflowStatus,
  queryFields,
  collectionCumulusId,
  executionCumulusId,
  knex,
  error,
  executionUrl,
  processingTimeInfo,
  providerCumulusId,
  pdrCumulusId,
  granuleModel,
  updatedAt = Date.now(),
  esClient,
}) => {
  let granuleCumulusId;
  const files = await _generateFilesFromGranule({ granule, provider });

  await knex.transaction(async (trx) => {
    granuleCumulusId = await _writeGranuleViaTransaction({
      granule,
      processingTimeInfo,
      error,
      provider,
      workflowStartTime,
      workflowStatus,
      queryFields,
      collectionCumulusId,
      providerCumulusId,
      executionCumulusId,
      pdrCumulusId,
      trx,
      updatedAt,
      files,
    });

    return writeGranuleToDynamoAndEs({
      granule,
      executionUrl,
      collectionId,
      provider,
      workflowStartTime,
      error,
      pdrName,
      workflowStatus,
      processingTimeInfo,
      queryFields,
      granuleModel,
      esClient,
      updatedAt,
    });
  });

  await _writeGranuleFiles({
    files,
    granuleCumulusId,
    granule,
    workflowError: error,
    workflowStatus,
    knex,
    granuleModel,
  });
};

/**
 * Write granules to DynamoDB and PostgreSQL
 *
 * @param {Object} params
 * @param {Object} params.cumulusMessage - A workflow message
 * @param {string} params.collectionCumulusId
 *   Cumulus ID for collection referenced in workflow message, if any
 * @param {string} params.executionCumulusId
 *   Cumulus ID for execution referenced in workflow message, if any
 * @param {Knex} params.knex - Client to interact with PostgreSQL database
 * @param {string} [params.providerCumulusId]
 *   Cumulus ID for provider referenced in workflow message, if any
 * @param {string} [params.pdrCumulusId]
 *   Cumulus ID for PDR referenced in workflow message, if any
 * @param {Object} [params.granuleModel]
 *   Optional override for the granule model writing to DynamoDB
 *
 * @returns {Promise<Object[]>}
 *  true if there are no granules on the message, otherwise
 *  results from Promise.allSettled for all granules
 * @throws {Error}
 */
const writeGranules = async ({
  cumulusMessage,
  collectionCumulusId,
  executionCumulusId,
  knex,
  providerCumulusId,
  pdrCumulusId,
  granuleModel = new Granule(),
  esClient,
}) => {
  if (!messageHasGranules(cumulusMessage)) {
    logger.info('No granules to write, skipping writeGranules');
    return undefined;
  }
  if (!collectionCumulusId) {
    throw new Error('Collection reference is required for granules');
  }

  const granules = getMessageGranules(cumulusMessage);
  const granuleIds = granules.map((granule) => granule.granuleId);
  logger.info(`process granule IDs ${granuleIds.join(',')}`);

  const executionArn = getMessageExecutionArn(cumulusMessage);
  const executionUrl = getExecutionUrlFromArn(executionArn);
  const executionDescription = await granuleModel.describeGranuleExecution(executionArn);
  const processingTimeInfo = getExecutionProcessingTimeInfo(executionDescription);
  const provider = getMessageProvider(cumulusMessage);
  const workflowStartTime = getMessageWorkflowStartTime(cumulusMessage);
  const error = parseException(cumulusMessage.exception);
  const workflowStatus = getMetaStatus(cumulusMessage);
  const collectionId = getCollectionIdFromMessage(cumulusMessage);
  const pdrName = getMessagePdrName(cumulusMessage);
  const queryFields = getGranuleQueryFields(cumulusMessage);

  // Process each granule in a separate transaction via Promise.allSettled
  // so that they can succeed/fail independently
  const results = await Promise.allSettled(granules.map(
    (granule) => _writeGranule({
      collectionId,
      granule,
      processingTimeInfo,
      error,
      executionUrl,
      pdrName,
      provider,
      workflowStartTime,
      workflowStatus,
      queryFields,
      collectionCumulusId,
      providerCumulusId,
      executionCumulusId,
      pdrCumulusId,
      knex,
      granuleModel,
      esClient,
    })
  ));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    const allFailures = failures.map((failure) => failure.reason);
    const aggregateError = new AggregateError(allFailures);
    logger.error('Failed writing some granules to Dynamo', aggregateError);
    throw aggregateError;
  }
  return results;
};

module.exports = {
  generateFilePgRecord,
  generateGranuleRecord,
  getGranuleCumulusIdFromQueryResultOrLookup,
  writeGranules,
};
