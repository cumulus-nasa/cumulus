'use strict';

const get = require('lodash/get');

const AggregateError = require('aggregate-error');

const { parseSQSMessageBody, sendSQSMessage } = require('@cumulus/aws-client/SQS');

const log = require('@cumulus/common/log');
const {
  getKnexClient,
} = require('@cumulus/db');
const {
  getMessageAsyncOperationId,
} = require('@cumulus/message/AsyncOperations');
const {
  getCollectionNameAndVersionFromMessage,
} = require('@cumulus/message/Collections');
const {
  getMessageExecutionParentArn,
} = require('@cumulus/message/Executions');
const Execution = require('../../models/executions');
const Granule = require('../../models/granules');
const Pdr = require('../../models/pdrs');
const { getCumulusMessageFromExecutionEvent } = require('../../lib/cwSfExecutionEventUtils');

const {
  getCollectionCumulusId,
  getMessageProviderCumulusId,
  isPostRDSDeploymentExecution,
  getAsyncOperationCumulusId,
  getParentExecutionCumulusId,
} = require('./utils');

const {
  shouldWriteExecutionToPostgres,
  writeExecution,
  writeExecutionToDynamoAndES,
} = require('./write-execution');

const {
  writePdr,
  writePdrToDynamoAndEs,
} = require('./write-pdr');

const {
  writeGranules,
} = require('./write-granules');

const writeRecordsToDynamoDb = async ({
  cumulusMessage,
  granuleModel = new Granule(),
  executionModel = new Execution(),
  pdrModel = new Pdr(),
}) => {
  const results = await Promise.allSettled([
    writePdrToDynamoAndEs({
      cumulusMessage,
      pdrModel,
    }),
    writeExecutionToDynamoAndES({
      cumulusMessage,
      executionModel,
    }),
    granuleModel.storeGranulesFromCumulusMessage(cumulusMessage),
  ]);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    const allFailures = failures.map((failure) => failure.reason);
    const aggregateError = new AggregateError(allFailures);
    log.error('Failed writing some records to Dynamo', aggregateError);
    throw aggregateError;
  }
  return results;
};

/**
 * Write records to data stores. Use conditional logic to write either to
 * DynamoDB only or to DynamoDB and RDS.
 *
 * @param {Object} params
 * @param {Object} params.cumulusMessage - Cumulus workflow message
 * @param {Knex} params.knex - Knex client
 * @param {Object} [params.granuleModel]
 *   Optional instance of granules model used for writing to DynamoDB
 * @param {Object} [params.executionModel]
 *   Optional instance of execution model used for writing to DynamoDB
 * @param {Object} [params.pdrModel]
 *   Optional instance of PDR model used for writing to DynamoDB
 */
const writeRecords = async ({
  cumulusMessage,
  knex,
  granuleModel,
  executionModel,
  pdrModel,
}) => {
  if (!isPostRDSDeploymentExecution(cumulusMessage)) {
    log.info('Message is not for a post-RDS deployment execution. Writes will only be performed to DynamoDB/Elasticsearch and not RDS');
    return writeRecordsToDynamoDb({
      cumulusMessage,
      granuleModel,
      executionModel,
      pdrModel,
    });
  }

  const messageCollectionNameVersion = getCollectionNameAndVersionFromMessage(cumulusMessage);
  const messageAsyncOperationId = getMessageAsyncOperationId(cumulusMessage);
  const messageParentExecutionArn = getMessageExecutionParentArn(cumulusMessage);
  const [
    collectionCumulusId,
    asyncOperationCumulusId,
    parentExecutionCumulusId,
  ] = await Promise.all([
    getCollectionCumulusId(
      messageCollectionNameVersion,
      knex
    ),
    getAsyncOperationCumulusId(
      messageAsyncOperationId,
      knex
    ),
    getParentExecutionCumulusId(
      messageParentExecutionArn,
      knex
    ),
  ]);

  if (!shouldWriteExecutionToPostgres({
    messageCollectionNameVersion,
    collectionCumulusId,
    messageAsyncOperationId,
    asyncOperationCumulusId,
    messageParentExecutionArn,
    parentExecutionCumulusId,
  })) {
    log.info('Could not satisfy requirements for execution RDS write. All writes will only be performed to DynamoDB and not RDS');
    // If any requirements for writing executions to Postgres were not met,
    // then PDR/granules should not be written to Postgres either since they
    // reference executions, so bail out to writing execution/PDR/granule
    // records to Dynamo.
    return writeRecordsToDynamoDb({
      cumulusMessage,
      granuleModel,
      executionModel,
      pdrModel,
    });
  }

  const executionCumulusId = await writeExecution({
    cumulusMessage,
    collectionCumulusId,
    asyncOperationCumulusId,
    parentExecutionCumulusId,
    knex,
    executionModel,
  });

  const providerCumulusId = await getMessageProviderCumulusId(cumulusMessage, knex);

  const pdrCumulusId = await writePdr({
    cumulusMessage,
    collectionCumulusId,
    providerCumulusId,
    knex,
    executionCumulusId,
    pdrModel,
  });

  return writeGranules({
    cumulusMessage,
    collectionCumulusId,
    providerCumulusId,
    executionCumulusId,
    pdrCumulusId,
    knex,
    granuleModel,
  });
};

const handler = async (event) => {
  const knex = await getKnexClient({
    env: {
      ...process.env,
      ...event.env,
    },
  });

  const sqsMessages = get(event, 'Records', []);

  return await Promise.all(sqsMessages.map(async (message) => {
    const executionEvent = parseSQSMessageBody(message);
    const cumulusMessage = await getCumulusMessageFromExecutionEvent(executionEvent);

    try {
      return await writeRecords({ ...event, cumulusMessage, knex });
    } catch (error) {
      log.fatal(`Writing message failed with error: ${error.name} ---- ${error.message}`);
      log.fatal(`Writing message failed: ${JSON.stringify(message)}`);
      return sendSQSMessage(process.env.DeadLetterQueue, message);
    }
  }));
};

module.exports = {
  handler,
  writeRecords,
};
