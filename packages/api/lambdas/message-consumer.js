'use strict';

const Ajv = require('ajv');
const get = require('lodash/get');
const set = require('lodash/set');
const { sns } = require('@cumulus/aws-client/services');
const log = require('@cumulus/common/log');
const {
  getKnexClient,
  CollectionPgModel,
  RulePgModel,
} = require('@cumulus/db');
const kinesisSchema = require('./kinesis-consumer-event-schema.json');
const { lookupCollectionInEvent, queueMessageForRule } = require('../lib/rulesHelpers');

/**
 * `validateMessage` validates an event as being valid for creating a workflow.
 * See the schemas defined at the top of this file.
 *
 * @param {Object} event - lambda event
 * @param {string} originalMessageSource - 'kinesis' or 'sns'
 * @param {Object} messageSchema - provided messageSchema
 * @returns {(error|Object)} Throws an Ajv.ValidationError if event object is invalid.
 * Returns the event object if event is valid.
 */
function validateMessage(event, originalMessageSource, messageSchema) {
  if (originalMessageSource === 'sns') return Promise.resolve(event);

  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(messageSchema);
  return validate(event);
}

/**
 * Publish a record to the fallback SNS topic for further processing.
 *
 * @param {Object} record - errored record
 * @returns {Promise<Object>} - SNS publish response
 */
async function publishRecordToFallbackTopic(record) {
  const fallbackArn = process.env.FallbackTopicArn;
  log.info('publishing bad kinesis record to Topic:', fallbackArn);
  log.info('record:', JSON.stringify(record));
  return await sns().publish({
    TopicArn: fallbackArn,
    Message: JSON.stringify(record),
  }).promise();
}

/**
 * processRecord error handler.  If the error comes on first attempt then publish the failure
 * to the fallback SNS topic. If the message is already a fallback message, throw an error.
 *
 * @param {Error} error - error raised in processRecord.
 * @param {Object} record - record processed during error event.
 * @param {Bool} fromSNS - whether message that caused error is from SNS (non-kinesis)
 * @param {Bool} isKinesisRetry - flag to determine if the error should be sent
 *   for further processing or just raised to be handled by the
 *   lambda. isKinesisRetry is false if the record being processes is directly from
 *   Kinesis.
 * @returns {(res|error)} - result of publishing to topic, or original error if publish fails.
 * @throws {Error} - throws the original error if no special handling requested.
 */
async function handleProcessRecordError(error, record, fromSNS, isKinesisRetry) {
  if (!isKinesisRetry) {
    if (fromSNS) {
      log.error('Failed SNS message:');
      log.error(JSON.stringify(record));
      throw error;
    }
    try {
      const result = await publishRecordToFallbackTopic(record);
      log.debug('sns result:', result);
      return result;
    } catch (snsError) {
      // We couldn't publish the record to the fallback Topic, so we will log
      // and throw the original error.  Kinesis polling will pick up this
      // record again and retry.
      log.error(`Failed to publish record to fallback topic: ${record}`);
      log.error(`original error: ${error}`);
      log.error(`subsequent error: ${snsError}`);
      throw error;
    }
  }
  throw error;
}

/**
 * Process data sent to a kinesis stream. Validate the data and
 * queue a workflow message for each rule.
 *
 * @param {Object} record - input to the kinesis stream
 * @param {Bool} fromSNS - flag specifying if this is event is from SNS.  SNS
 *        events come from the fallback SNS Topic and are retries of original
 *        Kinesis events.  If this flag is true, errors are raised normally.
 *        If false, the record is from a Kinesis stream and any errors
 *        encountered will cause the record to be published to a fallback SNS
 *        topic for further attempts at processing.
 * @returns {[Promises]} Array of promises. Each promise is resolved when a
 * message is queued for all associated kinesis rules.
 */
function processRecord(record, fromSNS) {
  let eventObject;
  let isKinesisRetry = false;
  let parsed = record;
  let validationSchema;
  let originalMessageSource;
  let ruleParam = {};

  if (fromSNS) {
    parsed = JSON.parse(record.Sns.Message);
  }
  if (fromSNS && !parsed.kinesis) {
    // normal SNS notification - not a Kinesis fallback
    eventObject = parsed;
    originalMessageSource = 'sns';
    ruleParam = {
      type: originalMessageSource,
      ...lookupCollectionInEvent(eventObject),
      sourceArn: get(record, 'Sns.TopicArn'),
    };
  } else {
    // kinesis notification -  sns fallback or direct
    if (fromSNS) {
      // Kinesis fallback SNS notification
      isKinesisRetry = true;
    }
    try {
      const kinesisObject = parsed.kinesis;
      validationSchema = kinesisSchema;
      originalMessageSource = 'kinesis';
      const dataString = Buffer.from(kinesisObject.data, 'base64').toString();
      eventObject = JSON.parse(dataString);
      // standard case (collection object), or CNM case
      ruleParam = {
        type: originalMessageSource,
        ...lookupCollectionInEvent(eventObject),
        sourceArn: get(parsed, 'eventSourceARN'),
      };
    } catch (error) {
      log.error('Caught error parsing JSON:');
      log.error(error);
      // TODO (out of scope): does it make sense to attempt retrying bad JSON?
      return handleProcessRecordError(error, record, isKinesisRetry, fromSNS);
    }
  }

  const knex = getKnexClient();
  const rulePgModel = new RulePgModel();
  const collectionPgModel = new CollectionPgModel();
  return validateMessage(eventObject, originalMessageSource, validationSchema)
    .then(() => ((ruleParam.name && ruleParam.version) ?
      collectionPgModel.get(knex, { name: ruleParam.name, version: ruleParam.version }) :
      undefined))
    .then((pgCollection) => rulePgModel.search(
      knex,
      {
        collection_cumulus_id: pgCollection.cumulus_id,
        type: ruleParam.type,
        value: ruleParam.sourceArn,
      }
    ))
    .then((rules) => Promise.all(rules.map((rule) => {
      if (originalMessageSource === 'sns') set(rule, 'meta.snsSourceArn', ruleParam.sourceArn);
      return queueMessageForRule(rule, eventObject);
    })))
    .catch((error) => {
      log.error('Caught error in processRecord:');
      log.error(error);
      return handleProcessRecordError(error, record, isKinesisRetry, fromSNS);
    });
}

/**
 * `handler` Looks up enabled 'kinesis'-type rules associated with the collection
 * in the event argument. It enqueues a message for each kinesis-type rule to trigger
 * the associated workflow.
 *
 * @param {*} event - lambda event
 * @param {*} context - lambda context
 * @param {*} cb - callback function to explicitly return information back to the caller.
 * @returns {(error|string)} Success message or error
 */
function handler(event, context, cb) {
  const fromSns = event.Records[0].EventSource === 'aws:sns';
  const records = event.Records;

  return Promise.all(records.map((r) => processRecord(r, fromSns)))
    .then((results) => cb(null, results.filter((r) => r !== undefined)))
    .catch((error) => {
      cb(error);
    });
}

module.exports = {
  processRecord,
  handler,
};
