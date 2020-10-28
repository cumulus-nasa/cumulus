'use strict';

const get = require('lodash/get');
const semver = require('semver');

const { parseSQSMessageBody, sendSQSMessage } = require('@cumulus/aws-client/SQS');
const log = require('@cumulus/common/log');
const {
  getKnexClient,
  tableNames,
  doesRecordExist,
} = require('@cumulus/db');
const {
  getMessageAsyncOperationId,
} = require('@cumulus/message/AsyncOperations');
const {
  getCollectionNameAndVersionFromMessage,
} = require('@cumulus/message/Collections');
const {
  getMessageExecutionArn,
  getMessageExecutionParentArn,
  getMessageCumulusVersion,
} = require('@cumulus/message/Executions');
const {
  getMessageProviderId
} = require('@cumulus/message/Providers');
const Execution = require('../models/executions');
const Granule = require('../models/granules');
const Pdr = require('../models/pdrs');
const { getCumulusMessageFromExecutionEvent } = require('../lib/cwSfExecutionEventUtils');

const isPostRDSDeploymentExecution = (cumulusMessage) => {
  const minimumSupportedRDSVersion = process.env.RDS_DEPLOYMENT_CUMULUS_VERSION;
  if (!minimumSupportedRDSVersion) {
    throw new Error('RDS_DEPLOYMENT_CUMULUS_VERSION environment variable must be set');
  }
  const cumulusVersion = getMessageCumulusVersion(cumulusMessage);
  return cumulusVersion
    ? semver.gte(cumulusVersion, minimumSupportedRDSVersion)
    : false;
};

const hasNoParentExecutionOrExists = async (cumulusMessage, knex) => {
  const parentArn = getMessageExecutionParentArn(cumulusMessage);
  if (!parentArn) {
    return true;
  }
  return doesRecordExist({
    arn: parentArn,
  }, knex, tableNames.executions);
};

const hasNoAsyncOpOrExists = async (cumulusMessage, knex) => {
  const asyncOperationId = getMessageAsyncOperationId(cumulusMessage);
  if (!asyncOperationId) {
    return true;
  }
  return doesRecordExist({
    id: asyncOperationId,
  }, knex, tableNames.asyncOperations);
};

const hasNoCollectionOrExists = async (cumulusMessage, knex) => {
  const collectionInfo = getCollectionNameAndVersionFromMessage(cumulusMessage);
  if (!collectionInfo) {
    return true;
  }
  return doesRecordExist(collectionInfo, knex, tableNames.collections);
};

const hasNoProviderOrExists = async (cumulusMessage, knex) => {
  const providerId = getMessageProviderId(cumulusMessage);
  if (!providerId) {
    return true;
  }
  return doesRecordExist({
    name: providerId,
  }, knex, tableNames.providers);
};

const shouldWriteExecutionToRDS = async (cumulusMessage, knex) => {
  try {
    const executionIsPostDeployment = isPostRDSDeploymentExecution(cumulusMessage);
    if (!executionIsPostDeployment) return executionIsPostDeployment;

    const results = await Promise.all([
      hasNoParentExecutionOrExists(cumulusMessage, knex),
      hasNoAsyncOpOrExists(cumulusMessage, knex),
      hasNoCollectionOrExists(cumulusMessage, knex),
    ]);
    return results.every((result) => result === true);
  } catch (error) {
    log.error(error);
    return false;
  }
};

const saveExecution = async (cumulusMessage, knex) => {
  const executionModel = new Execution();
  const executionArn = getMessageExecutionArn(cumulusMessage);

  const isRDSWriteEnabled = await shouldWriteExecutionToRDS(cumulusMessage, knex);

  if (!isRDSWriteEnabled) {
    return executionModel.storeExecutionFromCumulusMessage(cumulusMessage);
  }

  try {
    return await knex.transaction(async (trx) => {
      await trx(tableNames.executions)
        .insert({
          arn: executionArn,
          cumulus_version: getMessageCumulusVersion(cumulusMessage),
        });
      return executionModel.storeExecutionFromCumulusMessage(cumulusMessage);
    });
  } catch (error) {
    log.error(`Failed to write execution records for ${executionArn}`, error);
    throw error;
  }
};

const shouldWritePdrToRDS = async (cumulusMessage, knex) => {
  try {
    const executionIsPostDeployment = isPostRDSDeploymentExecution(cumulusMessage);
    if (!executionIsPostDeployment) return executionIsPostDeployment;

    const results = await Promise.all([
      hasNoCollectionOrExists(cumulusMessage, knex),
      hasNoProviderOrExists(cumulusMessage, knex),
    ]);
    return results.every((result) => result === true);
  } catch (error) {
    log.error(error);
    return false;
  }
};

const savePdr = async (cumulusMessage, knex) => {
  const pdrModel = new Pdr();
  const executionArn = getMessageExecutionArn(cumulusMessage);

  const isRDSWriteEnabled = await shouldWritePdrToRDS(cumulusMessage, knex);

  if (!isRDSWriteEnabled) {
    return pdrModel.storePdrFromCumulusMessage(cumulusMessage);
  }

  try {
    return await knex.transaction(async (trx) => {
      await trx(tableNames.pdrs)
        .insert({
          arn: executionArn,
          cumulus_version: getMessageCumulusVersion(cumulusMessage),
        });
      return pdrModel.storePdrFromCumulusMessage(cumulusMessage);
    });
  } catch (error) {
    log.error(`Failed to write PDR records for ${executionArn}`, error);
    throw error;
  }
};

// const savePdrToDb = async (cumulusMessage) => {
//   const pdrModel = new Pdr();
//   try {
//     await pdrModel.storePdrFromCumulusMessage(cumulusMessage);
//   } catch (error) {
//     const executionArn = getMessageExecutionArn(cumulusMessage);
//     log.fatal(`Failed to create/update PDR database record for execution ${executionArn}: ${error.message}`);
//     throw error;
//   }
// };

const saveGranulesToDb = async (cumulusMessage) => {
  const granuleModel = new Granule();

  try {
    await granuleModel.storeGranulesFromCumulusMessage(cumulusMessage);
  } catch (error) {
    const executionArn = getMessageExecutionArn(cumulusMessage);
    log.fatal(`Failed to create/update granule records for execution ${executionArn}: ${error.message}`);
    throw error;
  }
};

const handler = async (event) => {
  const knex = await getKnexClient({
    env: {
      ...process.env,
      ...event.env,
    },
  });

  const sqsMessages = get(event, 'Records', []);

  return Promise.all(sqsMessages.map(async (message) => {
    const executionEvent = parseSQSMessageBody(message);
    const cumulusMessage = await getCumulusMessageFromExecutionEvent(executionEvent);
    const results = await Promise.allSettled([
      saveExecution(cumulusMessage, knex),
      saveGranulesToDb(cumulusMessage),
      savePdr(cumulusMessage, knex),
    ]);
    if (results.some((result) => result.status === 'rejected')) {
      log.fatal(`Writing message failed: ${JSON.stringify(message)}`);
      return sendSQSMessage(process.env.DeadLetterQueue, message);
    }
    return results;
  }));
};

module.exports = {
  handler,
  isPostRDSDeploymentExecution,
  hasNoParentExecutionOrExists,
  hasNoAsyncOpOrExists,
  hasNoCollectionOrExists,
  hasNoProviderOrExists,
  shouldWriteExecutionToRDS,
  saveExecution,
  saveGranulesToDb,
  savePdr,
};
