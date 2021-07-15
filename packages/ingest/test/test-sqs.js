'use strict';

const test = require('ava');

const awsServices = require('@cumulus/aws-client/services');
const SQS = require('@cumulus/aws-client/SQS');
const { randomString } = require('@cumulus/common/test-utils');
const { receiveSQSMessages } = require('@cumulus/aws-client/SQS');
const { s3 } = require('@cumulus/aws-client/services');
const {
  createBucket,
  recursivelyDeleteS3Bucket,
  s3ObjectExists,
  s3PutObject,
} = require('@cumulus/aws-client/S3');

const { archiveSqsMessageToS3, deleteArchivedMessageFromS3, getS3KeyForArchivedMessage } = require('../sqs');
// Copied from @cumulus/api/lib/testUtils to avoid circular dependency

/**
 * create a source queue
 *
 * @param {string} queueNamePrefix - prefix of the queue name
 * @param {string} visibilityTimeout - visibility timeout for queue messages
 * @returns {Object} - {queueUrl: <url>} queue created
 */
async function createSqsQueues(
  queueNamePrefix,
  visibilityTimeout = '300'
) {
  // source queue
  const queueName = `${queueNamePrefix}Queue`;
  const queueParms = {
    QueueName: queueName,
    Attributes: {
      VisibilityTimeout: visibilityTimeout,
    },
  };

  const { QueueUrl: queueUrl } = await awsServices.sqs().createQueue(queueParms).promise();
  return { queueName, queueUrl };
}

test.before(async (t) => {
  process.env.system_bucket = randomString();
  process.env.stackName = randomString();
  t.context.stackName = process.env.stackName;
  await createBucket(process.env.system_bucket);
});

test.after.always(async () => {
  await recursivelyDeleteS3Bucket(process.env.system_bucket);
});

test.serial('archiveSqsMessageToS3 archives an SQS message', async (t) => {
  const { stackName } = t.context;
  const queues = await createSqsQueues(randomString());
  const body = { testdata: randomString() };
  const message = await SQS.sendSQSMessage(
    queues.queueUrl,
    body
  );
  const messages = await receiveSQSMessages(
    queues.queueUrl,
    { numOfMessages: 1, visibilityTimeout: 5 }
  );
  const key = getS3KeyForArchivedMessage(stackName, message.MessageId, queues.queueName);

  await Promise.all(messages.map((m) => archiveSqsMessageToS3(queues.queueUrl, m)));

  const item = await s3().getObject({
    Bucket: process.env.system_bucket,
    Key: key,
  }).promise();

  t.deepEqual(body, JSON.parse(item.Body));
});

test.serial('deleteArchivedMessageFromS3 deletes archived message in S3', async (t) => {
  const message = { testdata: randomString() };
  await createBucket(process.env.system_bucket);

  const sqsQueues = await createSqsQueues(randomString());
  const sqsMessage = await awsServices.sqs().sendMessage({
    QueueUrl: sqsQueues.queueUrl, MessageBody: JSON.stringify(message),
  }).promise();
  const messageId = sqsMessage.MessageId;
  const key = getS3KeyForArchivedMessage(process.env.stackName, messageId, sqsQueues.queueName);

  await s3PutObject({
    Bucket: process.env.system_bucket,
    Key: key,
    Body: sqsMessage.Body,
  });

  // Check that item exists in S3
  t.true(await s3ObjectExists({
    Bucket: process.env.system_bucket,
    Key: key,
  }));

  await deleteArchivedMessageFromS3(messageId, sqsQueues.queueUrl);

  // Check that item no longer exists
  t.false(await s3ObjectExists({
    Bucket: process.env.system_bucket,
    Key: key,
  }));
});
