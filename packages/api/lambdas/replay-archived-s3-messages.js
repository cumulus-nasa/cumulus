'use strict';

const pMap = require('p-map');

const { envUtils } = require('@cumulus/common');
const { getJsonS3Object, listS3Keys } = require('@cumulus/aws-client/S3');
const { getQueueUrlByName, sendSQSMessage } = require('@cumulus/aws-client/SQS');
const { getS3PrefixForArchivedMessage } = require('@cumulus/ingest/sqs');
const Logger = require('@cumulus/logger');

const logger = new Logger({ sender: '@cumulus/replay-archived-messages' });

// Get messages from S3 using queueName
const getArchivedMessagesFromQueue = async (queueName) => {
  const bucket = envUtils.getRequiredEnvVar('system_bucket', process.env);
  const stackName = envUtils.getRequiredEnvVar('stackName', process.env);
  const prefix = getS3PrefixForArchivedMessage(stackName, queueName);
  const params = {
    Bucket: bucket,
    Prefix: prefix,
  };
  const keys = await listS3Keys(params);
  logger.debug(`Keys retrieved for ${queueName}: ${JSON.stringifiy(keys)}`);
  const archivedMessages = [];
  keys.map(async (key) => {
    archivedMessages.push(await getJsonS3Object(bucket, key.Key));
  });

  return archivedMessages;
};

async function replayArchivedMessages(event) {
  const replayedMessages = [];
  const queueName = event.queueName;
  const queueUrl = getQueueUrlByName(queueName);
  const messagesToReplay = await getArchivedMessagesFromQueue(event.queueName);
  await pMap(
    messagesToReplay,
    async (message) => {
      logger.debug(`Sending message to queue URL ${queueUrl}`);
      try {
        await sendSQSMessage(queueUrl, message);
        replayedMessages.push(message);
      } catch (error) {
        logger.error(`Could not send message to queue. Message: ${message}, Queue: ${queueUrl}`, error);
        throw error;
      }
    },
    {
      stopOnError: false,
    }
  );
  return replayedMessages;
}

async function handler(event) {
  return await replayArchivedMessages(event);
}

module.exports = {
  handler,
};
