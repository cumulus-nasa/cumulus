'use strict';

const get = require('lodash.get');
const isObject = require('lodash.isobject');

const { setGranuleStatus, sns } = require('@cumulus/common/aws');
const errors = require('@cumulus/common/errors');

/**
 * Determines if there was a valid exception in the input message
 *
 * @param {Object} event - aws event object
 * @returns {boolean} true if there was an exception, false otherwise
 */
function eventFailed(event) {
  // event has exception
  // and it is needed to avoid flagging cases like "exception: {}" or "exception: 'none'"
  if (isObject(event.exception)
    && (Object.keys(event.exception).length > 0)) return true;

  // Error and error keys are not part of the cumulus message
  // and if they appear in the message something is seriously wrong
  if (event.Error || event.error) return true;

  return false;
}

/**
 * Builds error object based on error type
 *
 * @param {string} type - error type
 * @param {string} cause - error cause
 * @returns {Object} the error object
 */
function buildError(type, cause) {
  let ErrorClass;

  if (Object.keys(errors).includes(type)) ErrorClass = errors[type];
  else if (type === 'TypeError') ErrorClass = TypeError;
  else ErrorClass = Error;

  return new ErrorClass(cause);
}

/**
 * If the cumulus message shows that a previous step failed,
 * this function extracts the error message from the cumulus message
 * and fails the function with that information. This ensures that the
 * Step Function workflow fails with the correct error info
 *
 * @param {Object} event - aws event object
 * @returns {undefined} throws an error and does not return anything
 */
function makeLambdaFunctionFail(event) {
  const error = event.exception || event.error;

  if (error) throw buildError(error.Error, error.Cause);

  throw new Error('Step Function failed for an unknown reason.');
}

/**
 * Lambda handler for publish-notifications Lambda.
 *
 * @param {Object} event - SNS Notification Event
 * @returns {Promise<Array>} PDR records
 */
async function handler(event) {
  const config = get(event, 'config');
  const message = get(event, 'input');

  const finished = get(config, 'sfnEnd', false);
  const topicArn = get(message, 'meta.topic_arn', null);
  const failed = eventFailed(message);

  if (topicArn) {
    // if this is the sns call at the end of the execution
    if (finished) {
      message.meta.status = failed ? 'failed' : 'completed';
      const granuleId = get(message, 'meta.granuleId', null);
      if (granuleId) {
        await setGranuleStatus(
          granuleId,
          config.stack,
          config.bucket,
          config.stateMachine,
          config.executionName,
          message.meta.status
        );
      }
    } else {
      message.meta.status = 'running';
    }

    await sns().publish({
      TopicArn: topicArn,
      Message: JSON.stringify(message)
    }).promise();
  }

  if (failed) {
    makeLambdaFunctionFail(message);
  }

  return get(message, 'payload', {});
}

module.exports = {
  handler
};
