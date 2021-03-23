'use strict';

const get = require('lodash/get');
const { s3PutObject } = require('@cumulus/aws-client/S3');

async function handler(event, _) {
  if (!process.env.system_bucket) throw new Error('System bucket env var is required.');
  if (!process.env.stackName) throw new Error('Could not determine archive path as stackName env var is undefined.');
  const sqsMessages = get(event, 'Records', []);

  return Promise.all(sqsMessages.map(async (message) => s3PutObject({
    Bucket: process.env.system_bucket,
    Key: `${process.env.stackName}/dead-letter-archive/sqs/${message.messageId}.json`,
    Body: message.body,
  })));
}

module.exports = {
  handler,
};
