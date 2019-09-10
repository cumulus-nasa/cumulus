'use strict';

const merge = require('lodash.merge');

const aws = require('@cumulus/common/aws');
const { getExecutionUrl } = require('@cumulus/ingest/aws');
const {
  getSfEventMessageObject,
  getSfEventStatus,
  isFailedSfStatus,
  isTerminalSfStatus
} = require('@cumulus/common/cloudwatch-event');
const log = require('@cumulus/common/log');
const {
  getMessageExecutionArn,
  getMessageGranules,
  getMessagePdr
} = require('@cumulus/common/message');
const StepFunctions = require('@cumulus/common/StepFunctions');

const Execution = require('../models/executions');
const Granule = require('../models/granules');
const Pdr = require('../models/pdrs');

/**
 * Publish a message to an SNS topic.
 *
 * Catch any thrown errors and log them.
 *
 * @param {string} snsTopicArn - SNS topic ARN
 * @param {Object} message - Message object
 * @returns {Promise}
 */
async function publishSnsMessage(
  snsTopicArn,
  message
) {
  try {
    if (!snsTopicArn) {
      throw new Error('Missing SNS topic ARN');
    }

    await aws.sns().publish({
      TopicArn: snsTopicArn,
      Message: JSON.stringify(message)
    }).promise();
  } catch (err) {
    log.error(`Failed to post message to SNS topic: ${snsTopicArn}`, err);
    log.info('Undelivered message', message);
  }
}

/**
 * Publish SNS message for execution reporting.
 *
 * @param {Object} executionRecord - An execution record
 * @param {string} [executionSnsTopicArn]
 *  SNS topic ARN for reporting executions. Defaults to `process.env.execution_sns_topic_arn`.
 * @returns {Promise}
 */
async function publishExecutionSnsMessage(
  executionRecord,
  executionSnsTopicArn = process.env.execution_sns_topic_arn
) {
  return publishSnsMessage(executionSnsTopicArn, executionRecord);
}

/**
 * Publish SNS message for granule reporting.
 *
 * @param {Object} granuleRecord - A granule record
 * @param {string} [granuleSnsTopicArn]
 *   SNS topic ARN for reporting granules. Defaults to `process.env.granule_sns_topic_arn`.
 * @returns {Promise}
 */
async function publishGranuleSnsMessage(
  granuleRecord,
  granuleSnsTopicArn = process.env.granule_sns_topic_arn
) {
  return publishSnsMessage(granuleSnsTopicArn, granuleRecord);
}

/**
 * Publish SNS message for PDR reporting.
 *
 * @param {Object} pdrRecord - A PDR record.
 * @param {string} [pdrSnsTopicArn]
 *   SNS topic ARN for reporting PDRs. Defaults to `process.env.pdr_sns_topic_arn`.
 * @returns {Promise}
 */
async function publishPdrSnsMessage(
  pdrRecord,
  pdrSnsTopicArn = process.env.pdr_sns_topic_arn
) {
  return publishSnsMessage(pdrSnsTopicArn, pdrRecord);
}

/**
 * Publish execution record to SNS topic.
 *
 * @param {Object} eventMessage - Workflow execution message
 * @returns {Promise}
 */
async function handleExecutionMessage(eventMessage) {
  const executionRecord = Execution.generateExecutionRecord(eventMessage);
  return publishExecutionSnsMessage(executionRecord);
}

/**
 * Publish individual granule messages to SNS topic.
 *
 * @param {Object} eventMessage - Workflow execution message
 * @returns {Promise}
 */
async function handleGranuleMessages(eventMessage) {
  const granules = getMessageGranules(eventMessage);
  if (!granules) {
    log.info('No granules to process on the message');
    return Promise.resolve();
  }

  const executionArn = getMessageExecutionArn(eventMessage);
  const executionUrl = getExecutionUrl(executionArn);

  let executionDescription;
  try {
    executionDescription = await StepFunctions.describeExecution({ executionArn });
  } catch (err) {
    log.error(`Could not describe execution ${executionArn}`, err);
  }

  return Promise.all(
    granules
      .filter((granule) => granule.granuleId)
      .map((granule) => Granule.generateGranuleRecord(
        granule,
        eventMessage,
        executionUrl,
        executionDescription
      ))
      .map((granuleRecord) => publishGranuleSnsMessage(granuleRecord))
  );
}

/**
 * Publish PDR record to SNS topic.
 *
 * @param {Object} eventMessage - Workflow execution message
 * @returns {Promise}
 */
async function handlePdrMessage(eventMessage) {
  const pdr = getMessagePdr(eventMessage);
  if (!pdr) {
    log.info('No PDRs to process on the message');
    return Promise.resolve();
  }

  if (!pdr.name) {
    log.info('Could not find name on PDR object', pdr);
    return Promise.resolve();
  }

  const pdrRecord = Pdr.generatePdrRecord(pdr);

  return publishPdrSnsMessage(pdrRecord);
}

/**
 * Publish messages to SNS report topics.
 *
 * @param {Object} eventMessage - Workflow execution message
 * @param {boolean} isTerminalStatus - true if workflow is in a terminal state
 * @param {boolean} isFailedStatus - true if workflow is in a failed state
 * @returns {Promise}
 */
async function publishReportSnsMessages(eventMessage, isTerminalStatus, isFailedStatus) {
  let status;

  if (isTerminalStatus) {
    status = isFailedStatus ? 'failed' : 'completed';
  } else {
    status = 'running';
  }

  merge(eventMessage, {
    meta: {
      status
    }
  });

  return Promise.all([
    handleExecutionMessage(eventMessage),
    handleGranuleMessages(eventMessage),
    handlePdrMessage(eventMessage)
  ]);
}

/**
 * Lambda handler for publish-reports Lambda.
 *
 * @param {Object} event - Cloudwatch event
 * @returns {Promise}
 */
async function handler(event) {
  const eventStatus = getSfEventStatus(event);
  const isTerminalStatus = isTerminalSfStatus(eventStatus);
  const isFailedStatus = isFailedSfStatus(eventStatus);

  const eventMessage = isTerminalStatus && !isFailedStatus
    ? getSfEventMessageObject(event, 'output')
    : getSfEventMessageObject(event, 'input', '{}');

  // TODO: Get event message from first failed step from execution history for failed executions
  /*if (isFailedSfStatus) {
    const executionArn = getMessageExecutionArn(eventMessage);
    const executionHistory = await StepFunctions.getExecutionHistory({ executionArn });
    for (let i = 0; i < executionHistory.events.length; i += 1) {
      const sfEvent = executionHistory.events[i];
      updatedEvents.push(getEventDetails(sfEvent));
    }
  }*/

  return publishReportSnsMessages(eventMessage, isTerminalStatus, isFailedStatus);
}

module.exports = {
  handler,
  publishReportSnsMessages
};
