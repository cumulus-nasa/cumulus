'use strict';

const pMap = require('p-map');

const { envUtils } = require('@cumulus/common');
const { getJsonS3Object } = require('@cumulus/aws-client/S3');
const { s3 } = require('@cumulus/aws-client/services');
const { getQueueUrlByName, sendSQSMessage } = require('@cumulus/aws-client/SQS');
const { getS3PrefixForArchivedMessage } = require('@cumulus/ingest/sqs');
const Logger = require('@cumulus/logger');

const logger = new Logger({ sender: '@cumulus/replay-archived-messages' });

// Get messages from S3 using queueName
const getArchivedMessagesFromQueue = async (queueName) => {
  let listObjectsResponse;
  let continuationToken;
  const bucket = envUtils.getRequiredEnvVar('system_bucket', process.env);
  const stackName = envUtils.getRequiredEnvVar('stackName', process.env);
  const prefix = getS3PrefixForArchivedMessage(stackName, queueName);
  const params = {
    Bucket: bucket,
    Prefix: prefix,
    ContinuationToken: continuationToken,
    Delimiter: '/',
  };
  logger.debug(`Params for listS3Keys bucket: ${bucket}, prefix: ${prefix}`);
  const archivedMessages = [];

  /* eslint-disable no-await-in-loop */
  do {
    listObjectsResponse = await s3().listObjectsV2(params).promise();
    continuationToken = listObjectsResponse.NextContinuationToken;
    const messageObjects = listObjectsResponse.Contents;

    await Promise.allSettled(messageObjects.map(
      async (messageObject) => {
        const sqsMessage = await getJsonS3Object(bucket, messageObject.Key);
        logger.debug(`Message retrieved ${JSON.stringify(sqsMessage)}`);
        archivedMessages.push(sqsMessage);
      }
    ));
  } while (listObjectsResponse.IsTruncated);
  /* eslint-enable no-await-in-loop */
  logger.debug(`Archived messages length ${archivedMessages.length}`);
  return archivedMessages;
};

async function replayArchivedMessages(event) {
  const replayedMessages = [];
  const queueName = event.queueName;
  const queueUrl = await getQueueUrlByName(queueName);
  logger.debug(`Queue URL is ${queueUrl}`);
  const messagesToReplay = await getArchivedMessagesFromQueue(event.queueName);
  await pMap(
    messagesToReplay,
    async (message) => {
      logger.debug(`Sending message to queue URL ${queueUrl}`);
      try {
        await sendSQSMessage(queueUrl, message);
        logger.debug(`Successfully sent message to queue URL ${queueUrl}`);
        replayedMessages.push(message);
      } catch (error) {
        logger.error(`Could not send message to queue. Message: ${JSON.stringify(message)}, Queue: ${queueUrl}`, error);
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
  replayArchivedMessages,
};
