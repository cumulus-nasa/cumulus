'use strict';

const log = require('@cumulus/common/log');

const { s3 } = require('@cumulus/aws-client/services');
const { getJsonS3Object } = require('@cumulus/aws-client/S3');
const { getKnexClient } = require('@cumulus/db');

const { writeRecords } = require('./sf-event-sqs-to-db-records');

/**
 * Process dead letters in the bucket dead letter archive
 * and attempt to write records to the Cumulus DB
 *
 * @param {Object}   params - Parameters object
 * @param {Knex}     params.knex - Client to interact with Postgres database
 * @param {string}   [params.bucket] - optional bucket override
 * @param {string}   [params.path] - optional dead letter archive path override
 * @param {Function} [params.writeRecordsFunction] - optional function override for testing
 * @param {number}   [params.batchSize] - optional S3 results batch size override for testing
 * @returns {Promise<void>}
 */
async function processDeadLetterArchive({
  knex,
  bucket = process.env.system_bucket,
  path = `${process.env.stackName}/dead-letter-archive/sqs/`,
  writeRecordsFunction = writeRecords,
  batchSize = 1000,
}) {
  let listObjectsResponse;
  let continuationToken;
  let allSuccessKeys = [];
  const allFailedKeys = [];
  /* eslint-disable no-await-in-loop */
  do {
    listObjectsResponse = await s3().listObjectsV2({
      Bucket: bucket,
      Prefix: path,
      ContinuationToken: continuationToken,
      MaxKeys: batchSize,
    }).promise();
    continuationToken = listObjectsResponse.NextContinuationToken;
    const deadLetterObjects = listObjectsResponse.Contents;
    const promises = await Promise.allSettled(deadLetterObjects.map(
      async (deadLetterObject) => {
        const cumulusMessage = await getJsonS3Object(bucket, deadLetterObject.Key);
        try {
          await writeRecordsFunction({ cumulusMessage, knex });
          return deadLetterObject.Key;
        } catch (error) {
          log.error(`Failed to write records from cumulusMessage for dead letter ${deadLetterObject.Key} due to '${error}'`);
          allFailedKeys.push(deadLetterObject.Key);
          throw error;
        }
      }
    ));

    const successfullyProcessedKeys = promises.filter(
      (prom) => prom.status === 'fulfilled'
    ).map((prom) => prom.value);
    allSuccessKeys = allSuccessKeys.concat(successfullyProcessedKeys);

    const keysToDelete = successfullyProcessedKeys.map((key) => ({ Key: key }));
    if (keysToDelete.length > 0) {
      await s3().deleteObjects({
        Bucket: bucket,
        Delete: {
          Objects: keysToDelete,
        },
      }).promise();
    }
  } while (listObjectsResponse.IsTruncated);
  /* eslint-enable no-await-in-loop */
  // Lambda run as an async operation must have a return
  return {
    processed: allSuccessKeys,
    failed: allFailedKeys,
  };
}

/**
 * Lambda handler for AsyncOperation purposes
 *
 * @param {Object} event - Input payload object
 * @param {string} [event.bucket] - Bucket containing dead letter archive (default to system bucket)
 * @param {string} [event.key] - Dead letter archive path key
 * @returns {Promise<void>}
 */
async function handler(event) {
  const knex = await getKnexClient({
    env: {
      ...process.env,
      ...event.env,
    },
  });
  const {
    bucket,
    path,
  } = event;
  return processDeadLetterArchive({ knex, bucket, path });
}

module.exports = {
  handler,
  processDeadLetterArchive,
};
