'use strict';

const pRetry = require('p-retry');
const {
  PdrPgModel,
} = require('@cumulus/db');
const {
  indexPdr,
} = require('@cumulus/es-client/indexer');
const {
  Search,
} = require('@cumulus/es-client/search');
const {
  getMessagePdrName,
  messageHasPdr,
  getMessagePdrStats,
  getMessagePdrPANSent,
  getMessagePdrPANMessage,
  getPdrPercentCompletion,
  generatePdrApiRecordFromMessage,
} = require('@cumulus/message/PDRs');
const {
  getMetaStatus,
  getMessageWorkflowStartTime,
  getWorkflowDuration,
} = require('@cumulus/message/workflows');
const Logger = require('@cumulus/logger');

const Pdr = require('../../models/pdrs');

const logger = new Logger({ sender: '@cumulus/sfEventSqsToDbRecords/write-pdr' });

const generatePdrRecord = ({
  cumulusMessage,
  collectionCumulusId,
  providerCumulusId,
  executionCumulusId,
  now = Date.now(),
  updatedAt = Date.now(),
}) => {
  const stats = getMessagePdrStats(cumulusMessage);
  const progress = getPdrPercentCompletion(stats);
  const timestamp = now;
  const workflowStartTime = getMessageWorkflowStartTime(cumulusMessage);

  return {
    name: getMessagePdrName(cumulusMessage),
    status: getMetaStatus(cumulusMessage),
    pan_sent: getMessagePdrPANSent(cumulusMessage),
    pan_message: getMessagePdrPANMessage(cumulusMessage),
    stats,
    progress,
    execution_cumulus_id: executionCumulusId,
    collection_cumulus_id: collectionCumulusId,
    provider_cumulus_id: providerCumulusId,
    created_at: new Date(workflowStartTime),
    updated_at: new Date(updatedAt),
    timestamp: new Date(timestamp),
    duration: getWorkflowDuration(workflowStartTime, timestamp),
  };
};

/**
 * Get the cumulus ID from a query result or look it up in the database.
 *
 * For certain cases, such as an upsert query that matched no rows, an empty
 * database result is returned, so no cumulus ID will be returned. In those
 * cases, this function will lookup the PDR cumulus ID from the record.
 *
 * @param {Object} params
 * @param {Object} params.trx - A Knex transaction
 * @param {Object} params.queryResult - Query result
 * @param {Object} params.pdrRecord - A PDR record
 * @returns {Promise<number|undefined>} - Cumulus ID for the PDR record
 */
const getPdrCumulusIdFromQueryResultOrLookup = async ({
  queryResult = [],
  pdrRecord,
  trx,
  pdrPgModel = new PdrPgModel(),
}) => {
  let pdrCumulusId = queryResult[0];
  if (!pdrCumulusId) {
    pdrCumulusId = await pdrPgModel.getRecordCumulusId(
      trx,
      { name: pdrRecord.name }
    );
  }
  return pdrCumulusId;
};

const writePdrViaTransaction = async ({
  cumulusMessage,
  trx,
  collectionCumulusId,
  providerCumulusId,
  executionCumulusId,
  pdrPgModel = new PdrPgModel(),
  updatedAt,
}) => {
  const pdrRecord = generatePdrRecord({
    cumulusMessage,
    collectionCumulusId,
    providerCumulusId,
    executionCumulusId,
    updatedAt,
  });

  logger.info(`About to write PDR ${pdrRecord.name} to PostgreSQL`);

  const queryResult = await pdrPgModel.upsert(trx, pdrRecord);

  // If the WHERE clause of the upsert query is not met, then the
  // result from the query is empty so no cumulus_id will be returned.
  // But this function always needs to return a cumulus_id for the PDR
  // since it is used for writing granules
  const pdrCumulusId = await getPdrCumulusIdFromQueryResultOrLookup({
    trx,
    queryResult,
    pdrRecord,
  });

  logger.info(`Successfully upserted PDR ${pdrRecord.name} to PostgreSQL with cumulus_id ${pdrCumulusId}`);
  return [pdrCumulusId];
};

const writePdrToDynamoAndEs = async (params) => {
  const {
    cumulusMessage,
    pdrModel,
    updatedAt = Date.now(),
    esClient = await Search.es(),
  } = params;
  const pdrApiRecord = generatePdrApiRecordFromMessage(cumulusMessage, updatedAt);
  try {
    const dynamoResponse = await pdrModel.storePdr(pdrApiRecord, cumulusMessage);
    if (dynamoResponse) {
      await indexPdr(esClient, pdrApiRecord, process.env.ES_INDEX);
    }
  } catch (error) {
    // On error, delete the Dynamo record to ensure that all systems
    // stay in sync
    await pRetry(
      pdrModel.delete({ pdrName: pdrApiRecord.pdrName }),
      {
        retries: 3,
      }
    );
    throw error;
  }
};

const writePdr = async ({
  cumulusMessage,
  collectionCumulusId,
  providerCumulusId,
  executionCumulusId,
  knex,
  pdrModel = new Pdr(),
  updatedAt = Date.now(),
  esClient,
}) => {
  // If there is no PDR in the message, then there's nothing to do here, which is fine
  if (!messageHasPdr(cumulusMessage)) {
    return undefined;
  }
  if (!collectionCumulusId) {
    throw new Error('Collection reference is required for a PDR');
  }
  if (!providerCumulusId) {
    throw new Error('Provider reference is required for a PDR');
  }
  return await knex.transaction(async (trx) => {
    // eslint-disable-next-line camelcase
    const [cumulus_id] = await writePdrViaTransaction({
      cumulusMessage,
      collectionCumulusId,
      providerCumulusId,
      trx,
      executionCumulusId,
      updatedAt,
    });
    await writePdrToDynamoAndEs({
      cumulusMessage,
      pdrModel,
      updatedAt,
      esClient,
    });
    // eslint-disable-next-line camelcase
    return cumulus_id;
  });
};

module.exports = {
  generatePdrRecord,
  getPdrCumulusIdFromQueryResultOrLookup,
  writePdrViaTransaction,
  writePdr,
  writePdrToDynamoAndEs,
};
