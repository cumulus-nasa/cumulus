const semver = require('semver');
const { envUtils } = require('@cumulus/common');
const {
  tableNames,
  isRecordDefined,
} = require('@cumulus/db');
const {
  MissingRequiredEnvVarError,
  RecordDoesNotExist,
} = require('@cumulus/errors');
const Logger = require('@cumulus/logger');
const {
  getMessageCumulusVersion,
} = require('@cumulus/message/Executions');
const {
  getMessageProviderId,
} = require('@cumulus/message/Providers');

const logger = new Logger({ sender: '@cumulus/api/sfEventSqsToDbRecords/utils' });

const isPostRDSDeploymentExecution = (cumulusMessage) => {
  try {
    const minimumSupportedRDSVersion = envUtils.getRequiredEnvVar('RDS_DEPLOYMENT_CUMULUS_VERSION');
    const cumulusVersion = getMessageCumulusVersion(cumulusMessage);
    return cumulusVersion
      ? semver.gte(cumulusVersion, minimumSupportedRDSVersion)
      : false;
  } catch (error) {
    // Throw error to fail lambda if required env var is missing
    if (error instanceof MissingRequiredEnvVarError) {
      throw error;
    }
    // Treat other errors as false
    return false;
  }
};

const getAsyncOperationCumulusId = async (asyncOperationId, knex) => {
  try {
    if (!asyncOperationId) {
      throw new Error(`Async operation ID is required for lookup, received ${asyncOperationId}`);
    }
    const asyncOperation = await knex(tableNames.asyncOperations).where({
      id: asyncOperationId,
    }).first();
    if (!isRecordDefined(asyncOperation)) {
      throw new RecordDoesNotExist(`Could not find async operation with id ${asyncOperationId}`);
    }
    return asyncOperation.cumulus_id;
  } catch (error) {
    if (error instanceof RecordDoesNotExist) {
      logger.info(error);
    }
    return undefined;
  }
};

const getParentExecutionCumulusId = async (parentExecutionArn, knex) => {
  try {
    if (!parentExecutionArn) {
      throw new Error(`Parent execution ARN is required for lookup, received ${parentExecutionArn}`);
    }
    const parentExecution = await knex(tableNames.executions).where({
      arn: parentExecutionArn,
    }).first();
    if (!isRecordDefined(parentExecution)) {
      throw new RecordDoesNotExist(`Could not find execution with arn ${parentExecutionArn}`);
    }
    return parentExecution.cumulus_id;
  } catch (error) {
    if (error instanceof RecordDoesNotExist) {
      logger.info(error);
    }
    return undefined;
  }
};

const getCollectionCumulusId = async (collectionNameVersion, knex) => {
  try {
    if (!collectionNameVersion) {
      throw new Error(`Collection name/version is required for lookup, received ${collectionNameVersion}`);
    }
    const collection = await knex(tableNames.collections).where(
      collectionNameVersion
    ).first();
    if (!isRecordDefined(collection)) {
      throw new RecordDoesNotExist(`Could not find collection with params ${JSON.stringify(collectionNameVersion)}`);
    }
    return collection.cumulus_id;
  } catch (error) {
    if (error instanceof RecordDoesNotExist) {
      logger.info(error);
    }
    return undefined;
  }
};

const getMessageProviderCumulusId = async (cumulusMessage, knex) => {
  try {
    const providerId = getMessageProviderId(cumulusMessage);
    if (!providerId) {
      throw new Error('Could not find provider ID in message');
    }
    const searchParams = {
      name: getMessageProviderId(cumulusMessage),
    };
    const provider = await knex(tableNames.providers).where(searchParams).first();
    if (!isRecordDefined(provider)) {
      throw new Error(`Could not find provider with params ${JSON.stringify(searchParams)}`);
    }
    return provider.cumulus_id;
  } catch (error) {
    logger.error(error);
    return undefined;
  }
};

module.exports = {
  isPostRDSDeploymentExecution,
  getAsyncOperationCumulusId,
  getParentExecutionCumulusId,
  getCollectionCumulusId,
  getMessageProviderCumulusId,
};
