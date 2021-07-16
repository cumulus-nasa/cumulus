'use strict';

const test = require('ava');
const uuidv4 = require('uuid/v4');

const awsServices = require('@cumulus/aws-client/services');
const S3 = require('@cumulus/aws-client/S3');
const { s3PutObject } = require('@cumulus/aws-client/S3');
const { getS3KeyForArchivedMessage } = require('@cumulus/ingest/sqs');

const { randomString } = require('@cumulus/common/test-utils');

const {
  replayArchivedMessages,
} = require('../../lambdas/replay-archived-s3-messages');

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
  t.context.system_bucket = process.env.system_bucket;
  await S3.createBucket(t.context.system_bucket);
});

test.beforeEach(async (t) => {
  process.env.stackName = 'test-stack';
  t.context.stackName = process.env.stackName;

  const queues = await createSqsQueues(randomString());
  t.context.queueName = queues.queueName;

  const message1 = { id: uuidv4(), Body: JSON.stringify({ testdata: randomString() }) };
  t.context.message1 = message1;

  const key1 = getS3KeyForArchivedMessage(t.context.stackName, message1.id, queues.queueName);
  await s3PutObject({
    Bucket: process.env.system_bucket,
    Key: key1,
    Body: message1.Body,
  });
});

test.after(async (t) => {
  await S3.recursivelyDeleteS3Bucket(t.context.system_bucket);
});

test('replayArchivedMessages queues messages to SQS for each archived message', async (t) => {
  const { message1 } = t.context;
  const event = {
    queueName: t.context.queueName,
  };
  const expected = [JSON.parse(message1.Body)];

  const replay = (await replayArchivedMessages(event));
  t.deepEqual(replay, expected);
});
