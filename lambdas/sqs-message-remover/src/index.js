'use strict';

const get = require('lodash/get');

const { sqs } = require('@cumulus/aws-client/services');
const { deleteSQSMessage } = require('@cumulus/aws-client/SQS');
const { deleteArchivedMessageFromS3 } = require('@cumulus/ingest/sqs');
const {
  getSfEventMessageObject,
  getSfEventStatus,
  isFailedSfStatus,
  isSfExecutionEvent,
  isTerminalSfStatus,
} = require('@cumulus/common/cloudwatch-event');

const Logger = require('@cumulus/logger');

const logger = new Logger({ sender: '@cumulus/sqs-message-remover' });

/**
 * Determine if the SQS queue update is needed for the event
 *
 * Return false if:
 *   - Event has no workflow status
 *   - Workflow is not in a terminal state
 *   - Event message has no 'meta.eventSource' property or eventSource type is not 'sqs'
 *   - Event message property meta.eventSource.deleteCompletedMessage is not true
 *   - Event message property meta.eventSource.workflow_name is not the same as meta.workflow_name
 *
 * @param {Object} event - A workflow execution event
 * @returns {boolean} True if SQS queue update is needed
 */
function isSqsQueueUpdateNeeded(event) {
  const eventStatus = getSfEventStatus(event);
  const eventMessage = getSfEventMessageObject(event, 'input', '{}');

  if (!isSfExecutionEvent(event)
    || !isTerminalSfStatus(eventStatus)
    || get(eventMessage, 'meta.eventSource.type') !== 'sqs'
    || get(eventMessage, 'meta.eventSource.deleteCompletedMessage', false) !== true
    || get(eventMessage, 'meta.eventSource.workflow_name') === null
    || get(eventMessage, 'meta.eventSource.workflow_name') !== get(eventMessage, 'meta.workflow_name')) {
    return false;
  }

  return true;
}

/**
 * Update SQS queue when workflow of the message is completed
 *
 * @param {Object} event - Cloudwatch event
 * @returns {Promise} A promise indicating function completion
 */
async function updateSqsQueue(event) {
  if (!isSqsQueueUpdateNeeded(event)) return Promise.resolve('Not a valid event for updating SQS queue');

  const eventStatus = getSfEventStatus(event);
  const eventMessage = getSfEventMessageObject(event, 'input', '{}');

  const {
    messageId,
    queueUrl,
    receiptHandle,
  } = eventMessage.meta.eventSource;

  if (isFailedSfStatus(eventStatus)) {
    // update visibilityTimeout to 5s so the message can be retried
    logger.debug(`update message ${receiptHandle} queue ${queueUrl} visibilityTimeout to 5s`);

    const params = {
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: 5,
    };
    await sqs().changeMessageVisibility(params).promise();
  } else {
    // delete SQS message from the source queue when the workflow succeeded
    logger.debug(`remove message ${receiptHandle} from queue ${queueUrl}`);
    await Promise.all([
      deleteSQSMessage(queueUrl, receiptHandle),
      deleteArchivedMessageFromS3(messageId, queueUrl),
    ]);
  }

  return Promise.resolve();
}

/**
 * Lambda handler for sqsMessageRemover Lambda
 *
 * This Lambda is triggered via a [Cloudwatch rule for any Step Function execution status
 * changes] (https://docs.aws.amazon.com/step-functions/latest/dg/cw-events.html).
 * It works together with sqsMessageConsumer. sqsMessageConsumer lambda
 * consumes message from SQS queue, and sqsMessageRemover deletes the message from the SQS
 * queue when the workflow triggered by the message is executed successfully.
 *
 * @param {Object} event - Cloudwatch event
 * @returns {Promise}
 */
function handler(event) {
  return updateSqsQueue(event);
}

module.exports = {
  updateSqsQueue,
  handler,
};
