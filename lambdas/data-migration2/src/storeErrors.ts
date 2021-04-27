import Logger from '@cumulus/logger';
import { WriteStream } from 'node:fs';

const fs = require('fs');
const JSONStream = require('JSONStream');
const { finished } = require('stream');
const { promisify } = require('util');
const { s3 } = require('@cumulus/aws-client/services');

const logger = new Logger({ sender: '@cumulus/data-migration/storeErrors' });

/**
 * Helper to create error file write stream
 * @param {string} migrationName         - Name of migration
 * @param {string | undefined} timestamp - Timestamp for unit testing
 * @returns {Object}                     - Object containing error write streams and file path
 */
export const createErrorFileWriteStream = (migrationName: string, timestamp?: string) => {
  const dateString = timestamp || new Date().toISOString();
  const filepath = `${migrationName}ErrorLog-${dateString}.json`;
  const errorFileWriteStream = fs.createWriteStream(filepath);
  const jsonWriteStream = JSONStream.stringify();
  jsonWriteStream.pipe(errorFileWriteStream);
  errorFileWriteStream.write('{ "errors": \n');

  return { jsonWriteStream, errorFileWriteStream, filepath };
};

/**
 * Helper to close error JSON write stream
 * @param {WriteStream} errorFileWriteStream - Error file write stream to close
 * @returns {Promise<void>}
 */
export const closeErrorFileWriteStream = async (errorFileWriteStream: WriteStream) => {
  errorFileWriteStream.end('\n]}');
  const asyncFinished = promisify(finished);
  await asyncFinished(errorFileWriteStream);
};

/**
 * Store migration errors JSON file on S3.
 *
 * @param {Object} params
 * @param {string} params.bucket                - Name of S3 bucket where file will be uploaded
 * @param {string} params.filepath              - Write Stream file path
 * @param {string} params.migrationName         - Name of migration
 * @param {string} params.stackName             - User stack name/prefix
 * @param {string | undefined} params.timestamp - Timestamp for unit testing
 * @returns {Promise<void>}
 */
export const storeErrors = async (params: {
  bucket: string,
  filepath: string,
  migrationName: string,
  stackName: string,
  timestamp?: string,
}) => {
  const { bucket, filepath, migrationName, stackName, timestamp } = params;
  const fileKey = `data-migration2-${migrationName}-errors`;
  const dateString = timestamp || new Date().toISOString();
  const key = `${stackName}/${fileKey}-${dateString}.json`;

  await s3().putObject({
    Bucket: bucket,
    Key: key,
    Body: fs.createReadStream(filepath),
  }).promise();

  logger.info(`Stored error log file with key ${key} to bucket ${bucket}.`);
  fs.unlinkSync(filepath);
};
