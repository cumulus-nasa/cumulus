/* eslint no-console: "off" */

'use strict';

const AWS = require('aws-sdk');
const got = require('got');
const pRetry = require('p-retry');
const util = require('util');
const isError = require('lodash/isError');
const exec = util.promisify(require('child_process').exec);
const fs = require('fs');
const url = require('url');
const Logger = require('@cumulus/logger');
const { pipeline } = require('stream');
const { promisify } = require('util');
const { getKnexClient, AsyncOperationPgModel } = require('@cumulus/db');
const { dynamodb } = require('@cumulus/aws-client/services');

const logger = new Logger({ sender: 'ecs/async-operation' });

/**
 * Return a list of environment variables that should be set but aren't
 *
 * @returns {Array<string>} a list of missing environment variables
 */
function missingEnvironmentVariables() {
  return [
    'asyncOperationId',
    'asyncOperationsTable',
    'lambdaName',
    'payloadUrl',
  ].filter((key) => process.env[key] === undefined);
}

/**
 * Fetch an object from S3 and parse it as JSON
 *
 * @param {string} Bucket - the S3 bucket
 * @param {string} Key - the S3 key
 * @returns {Object|Array} the parsed payload
 */
async function fetchPayload(Bucket, Key) {
  const s3 = new AWS.S3();

  let payloadResponse;
  try {
    payloadResponse = await s3.getObject({ Bucket, Key }).promise();
  } catch (error) {
    throw new Error(`Failed to fetch s3://${Bucket}/${Key}: ${error.message}`);
  }

  let parsedPayload;
  try {
    parsedPayload = JSON.parse(payloadResponse.Body.toString());
  } catch (error) {
    if (error.name !== 'SyntaxError') throw error;
    const newError = new Error(`Unable to parse payload: ${error.message}`);
    newError.name = 'JSONParsingError';
    throw newError;
  }

  return parsedPayload;
}

/**
 * Fetch and delete a lambda payload from S3
 *
 * @param {string} payloadUrl - the s3:// URL of the payload
 * @returns {Promise<Object>} a payload that can be passed as the event of a lambda call
 */
async function fetchAndDeletePayload(payloadUrl) {
  const parsedPayloadUrl = url.parse(payloadUrl);
  const Bucket = parsedPayloadUrl.hostname;
  const Key = parsedPayloadUrl.path.substring(1);

  const payload = await fetchPayload(Bucket, Key);

  await (new AWS.S3()).deleteObject({ Bucket, Key }).promise();

  return payload;
}

/**
 * Query AWS for the codeUrl, moduleFileName, and moduleFunctionName of a
 *   Lambda function.
 *
 * @param {string} FunctionName - the name of the Lambda function
 * @returns {Promise<Object>} an object with the codeUrl, moduleFileName, and
 *   moduleFunctionName
 */
async function getLambdaInfo(FunctionName) {
  const lambda = new AWS.Lambda();

  const getFunctionResponse = await lambda.getFunction({
    FunctionName,
  }).promise();

  const handler = getFunctionResponse.Configuration.Handler;
  const [moduleFileName, moduleFunctionName] = handler.split('.');

  return {
    moduleFileName,
    moduleFunctionName,
    codeUrl: getFunctionResponse.Code.Location,
  };
}

/**
 * Download a lambda function from AWS and extract it to the
 *   /home/task/lambda-function directory
 *
 * @param {string} codeUrl - an https URL to download the lambda code from
 * @returns {Promise<undefined>} resolves when the code has been downloaded
 */
async function fetchLambdaFunction(codeUrl) {
  // Fetching the lambda zip file from S3 was failing intermittently because
  // of connection timeouts.  If the download fails, this will retry it up to
  // 10 times with an exponential backoff.
  await pRetry(
    () => promisify(pipeline)(
      got.stream(codeUrl),
      fs.createWriteStream('/home/task/fn.zip')
    ),
    {
      maxTimeout: 10000,
      onFailedAttempt: (err) => {
        const message = (err.attemptsLeft > 0)
          ? `Failed to download lambda function (will retry): ${err}`
          : `Failed to download lambda function (will not retry): ${err}`;
        logger.error(message);
      },
    }
  );

  return exec('unzip -o /home/task/fn.zip -d /home/task/lambda-function');
}

/**
 * Given an Error object return an object to be stored as the AsyncOperation
 *   output.
 *
 * @param {Error} error - the error to be stored
 * @returns {Object} an object with name, message, and stack properties
 */
function buildErrorOutput(error) {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

const writeAsyncOperationToPostgres = async (params) => {
  const { trx, env, dbOutput, status, updatedTime } = params;
  const id = env.asyncOperationId;
  const asyncOperationPgModel = new AsyncOperationPgModel();
  return await asyncOperationPgModel
    .update(
      trx,
      { id },
      {
        status,
        output: dbOutput,
        updated_at: new Date(Number(updatedTime)),
      }
    );
};

const writeAsyncOperationToDynamoDb = async (params) => {
  const { env, status, dbOutput, updatedTime } = params;
  return await dynamodb().updateItem({
    TableName: env.asyncOperationsTable,
    Key: { id: { S: env.asyncOperationId } },
    ExpressionAttributeNames: {
      '#S': 'status',
      '#O': 'output',
      '#U': 'updatedAt',
    },
    ExpressionAttributeValues: {
      ':s': { S: status },
      ':o': { S: dbOutput },
      ':u': { N: updatedTime },
    },
    UpdateExpression: 'SET #S = :s, #O = :o, #U = :u',
  }).promise();
};

/**
 * Update an AsyncOperation item in DynamoDB
 *
 * For help with parameters, see:
 * https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB.html#updateItem-property
 *
 * @param {string} status - the new AsyncOperation status
 * @param {Object} output - the new output to store.  Must be parsable JSON
 * @param {Object} envOverride - Object to override/extend environment variables
 * @returns {Promise} resolves when the item has been updated
 */
const updateAsyncOperation = async (status, output, envOverride = {}) => {
  logger.info(`Updating AsyncOperation to ${JSON.stringify(status)} with output: ${JSON.stringify(output)}`);
  const actualOutput = isError(output) ? buildErrorOutput(output) : output;
  const dbOutput = actualOutput ? JSON.stringify(actualOutput) : undefined;
  const updatedTime = envOverride.updateTime || (Number(Date.now())).toString();
  const env = { ...process.env, ...envOverride };
  const knex = await getKnexClient({ env });
  return knex.transaction(async (trx) => {
    await writeAsyncOperationToPostgres({
      dbOutput,
      env,
      status,
      trx,
      updatedTime,
    });
    return writeAsyncOperationToDynamoDb({ env, status, dbOutput, updatedTime });
  });
};

/**
 * Download and run a Lambda task locally.  On completion, write the results out
 *   to a DynamoDB table.
 *
 * @returns {Promise<undefined>} resolves when the task has completed
 */
async function runTask() {
  let lambdaInfo;
  let payload;

  logger.debug('Running async operation %s', process.env.asyncOperationId);

  try {
    // Get some information about the lambda function that we'll be calling
    lambdaInfo = await getLambdaInfo(process.env.lambdaName);

    // Download the task (to the /home/task/lambda-function directory)
    await fetchLambdaFunction(lambdaInfo.codeUrl);
  } catch (error) {
    logger.error('Failed to fetch lambda function:', error);
    await updateAsyncOperation('RUNNER_FAILED', error);
    return;
  }

  try {
    // Fetch the event that will be passed to the lambda function from S3
    payload = await fetchAndDeletePayload(process.env.payloadUrl);
  } catch (error) {
    logger.error('Failed to fetch payload:', error);
    if (error.name === 'JSONParsingError') {
      await updateAsyncOperation('TASK_FAILED', error);
    } else {
      await updateAsyncOperation('RUNNER_FAILED', error);
    }

    return;
  }

  let result;
  try {
    // Load the lambda function
    const task = require(`/home/task/lambda-function/${lambdaInfo.moduleFileName}`); //eslint-disable-line global-require, import/no-dynamic-require

    // Run the lambda function
    result = await task[lambdaInfo.moduleFunctionName](payload);
  } catch (error) {
    logger.error('Failed to execute the lambda function:', error);
    await updateAsyncOperation('TASK_FAILED', error);
    return;
  }

  // Write the result out to databases
  try {
    await updateAsyncOperation('SUCCEEDED', result);
  } catch (error) {
    logger.error('Failed to update record', error);
    throw error;
  }
}

const missingVars = missingEnvironmentVariables();

if (missingVars.length === 0) runTask();
else logger.error('Missing environment variables:', missingVars.join(', '));

module.exports = { updateAsyncOperation };
