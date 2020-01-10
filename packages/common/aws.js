'use strict';

const AWS = require('aws-sdk');
const { JSONPath } = require('jsonpath-plus');
const pRetry = require('p-retry');

const awsServices = require('@cumulus/aws-client/services');
const s3Utils = require('@cumulus/aws-client/s3');
const dynamoDbUtils = require('@cumulus/aws-client/dynamo');
const DynamoDbSearchQueueCore = require('@cumulus/aws-client/DynamoDbSearchQueue');
const S3ListObjectsV2QueueCore = require('@cumulus/aws-client/S3ListObjectsV2Queue');
const sqsUtils = require('@cumulus/aws-client/sqs');
const stepFunctionUtils = require('@cumulus/aws-client/step-functions');

const log = require('./log');
const {
  deprecate,
  setErrorStack,
  noop
} = require('./util');
const { UnparsableFileLocationError } = require('./errors');

/**
 * Wrap a function and provide a better stack trace
 *
 * If a call is made to the aws-sdk and it causes an exception, the stack trace
 * that is returned gives no indication of where the error actually occurred.
 *
 * This utility will wrap a function and, when it is called, update any raised
 * error with a better stack trace.
 *
 * @param {Function} fn - the function to wrap
 * @returns {Function} a wrapper function
 */
const improveStackTrace = (fn) =>
  async (...args) => {
    const tracerError = {};
    try {
      Error.captureStackTrace(tracerError);
      return await fn(...args);
    } catch (err) {
      setErrorStack(err, tracerError.stack);
      err.message = `${err.message}; Function params: ${JSON.stringify(args, null, 2)}`;
      throw err;
    }
  };
exports.improveStackTrace = improveStackTrace;

exports.region = process.env.AWS_DEFAULT_REGION || 'us-east-1';
AWS.config.update({ region: exports.region });

// Workaround upload hangs. See: https://github.com/andrewrk/node-s3-client/issues/74'
AWS.util.update(AWS.S3.prototype, { addExpect100Continue: noop });
AWS.config.setPromisesDependency(Promise);

exports.apigateway = () => {
  deprecate('@cumulus/common/aws/apigateway', '1.17.1', '@cumulus/aws-client/aws/apigateway');
  return awsServices.apigateway();
};
exports.ecs = () => {
  deprecate('@cumulus/common/aws/ecs', '1.17.1', '@cumulus/aws-client/aws/ecs');
  return awsServices.ecs();
};
exports.s3 = () => {
  deprecate('@cumulus/common/aws/s3', '1.17.1', '@cumulus/aws-client/aws/s3');
  return awsServices.s3();
};
exports.kinesis = () => {
  deprecate('@cumulus/common/aws/kinesis', '1.17.1', '@cumulus/aws-client/aws/kinesis');
  return awsServices.kinesis();
};
exports.lambda = () => {
  deprecate('@cumulus/common/aws/lambda', '1.17.1', '@cumulus/aws-client/aws/lambda');
  return awsServices.lambda();
};
exports.sqs = () => {
  deprecate('@cumulus/common/aws/sqs', '1.17.1', '@cumulus/aws-client/aws/sqs');
  return awsServices.sqs();
};
exports.cloudwatchevents = () => {
  deprecate('@cumulus/common/aws/cloudwatchevents', '1.17.1', '@cumulus/aws-client/aws/cloudwatchevents');
  return awsServices.cloudwatchevents();
};
exports.cloudwatchlogs = () => {
  deprecate('@cumulus/common/aws/cloudwatchlogs', '1.17.1', '@cumulus/aws-client/aws/cloudwatchlogs');
  return awsServices.cloudwatchlogs();
};
exports.cloudwatch = () => {
  deprecate('@cumulus/common/aws/cloudwatch', '1.17.1', '@cumulus/aws-client/aws/cloudwatch');
  return awsServices.cloudwatch();
};
exports.dynamodb = () => {
  deprecate('@cumulus/common/aws/dynamodb', '1.17.1', '@cumulus/aws-client/aws/dynamodb');
  return awsServices.dynamodb();
};
exports.dynamodbstreams = () => {
  deprecate('@cumulus/common/aws/dynamodbstreams', '1.17.1', '@cumulus/aws-client/aws/dynamodbstreams');
  return awsServices.dynamodbstreams();
};
exports.dynamodbDocClient = () => {
  deprecate('@cumulus/common/aws/dynamodbDocClient', '1.17.1', '@cumulus/aws-client/aws/dynamodbDocClient');
  return awsServices.dynamodbDocClient();
};
exports.sfn = () => {
  deprecate('@cumulus/common/aws/sfn', '1.17.1', '@cumulus/aws-client/aws/sfn');
  return awsServices.sfn();
};
exports.cf = () => {
  deprecate('@cumulus/common/aws/cf', '1.17.1', '@cumulus/aws-client/aws/cf');
  return awsServices.cf();
};
exports.sns = () => {
  deprecate('@cumulus/common/aws/sns', '1.17.1', '@cumulus/aws-client/aws/sns');
  return awsServices.sns();
};
exports.secretsManager = () => {
  deprecate('@cumulus/common/aws/secretsManager', '1.17.1', '@cumulus/aws-client/aws/secretsManager');
  return awsServices.secretsManager();
};

/**
 * Describes the resources belonging to a given CloudFormation stack
 *
 * See https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/CloudFormation.html#describeStackResources-property
 *
 * @param {string} stackName -  The name of the CloudFormation stack to query
 * @returns {Array<Object>} The resources belonging to the stack
 */
exports.describeCfStackResources = (stackName) =>
  exports.cf().describeStackResources({ StackName: stackName })
    .promise()
    .then((response) => response.StackResources);

exports.findResourceArn = (obj, fn, prefix, baseName, opts, callback) => {
  obj[fn](opts, (err, data) => {
    if (err) {
      callback(err, data);
      return;
    }

    let arns = null;
    Object.keys(data).forEach((prop) => {
      if (prop.endsWith('Arns')) {
        arns = data[prop];
      }
    });

    if (!arns) {
      callback(`Could not find an 'Arn' property in response from ${fn}`, data);
      return;
    }

    const prefixRe = new RegExp(`^${prefix}-[A-Z0-9]`);
    const baseNameOnly = `-${baseName}-`;
    let matchingArn = null;

    arns.forEach((arn) => {
      const name = arn.split('/').pop();
      if (name.match(prefixRe) && name.includes(baseNameOnly)) {
        matchingArn = arn;
      }
    });

    if (matchingArn) {
      callback(null, matchingArn);
    } else if (data.NextToken) {
      const nextOpts = Object.assign({}, opts, { NextToken: data.NextToken });
      exports.findResourceArn(obj, fn, prefix, baseName, nextOpts, callback);
    } else {
      callback(`Could not find resource ${baseName} in ${fn}`);
    }
  });
};

/* S3 utils */

/**
 * Join strings into an S3 key without a leading slash or double slashes
 *
 * @param {...string|Array<string>} args - the strings to join
 * @returns {string} the full S3 key
 */
exports.s3Join = (...args) => {
  deprecate('@cumulus/common/aws/s3Join', '1.17.1', '@cumulus/aws-client/s3/s3Join');
  return s3Utils.s3Join(...args);
};

/**
* Convert S3 TagSet Object to query string
* e.g. [{ Key: 'tag', Value: 'value }] to 'tag=value'
*
* @param {Array<Object>} tagset - S3 TagSet array
* @returns {string} - tags query string
*/
exports.s3TagSetToQueryString = (tagset) => {
  deprecate('@cumulus/common/aws/s3TagSetToQueryString', '1.17.1', '@cumulus/aws-client/s3/s3TagSetToQueryString');
  return s3Utils.s3TagSetToQueryString(tagset);
};

/**
 * Delete an object from S3
 *
 * @param {string} bucket - bucket where the object exists
 * @param {string} key - key of the object to be deleted
 * @returns {Promise} - promise of the object being deleted
 */
exports.deleteS3Object = (bucket, key) => {
  deprecate('@cumulus/common/aws/deleteS3Object', '1.17.1', '@cumulus/aws-client/s3/deleteS3Object');
  return s3Utils.deleteS3Object(bucket, key);
};

/**
 * Test if an object exists in S3
 *
 * @param {Object} params - same params as https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#headObject-property
 * @returns {Promise<boolean>} - a Promise that will resolve to a boolean indicating
 *                               if the object exists
 */
exports.s3ObjectExists = (params) => {
  deprecate('@cumulus/common/aws/s3ObjectExists', '1.17.1', '@cumulus/aws-client/s3/s3ObjectExists');
  return s3Utils.s3ObjectExists(params);
};

/**
* Put an object on S3
*
* @param {Object} params - same params as https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObject-property
* @returns {Promise} - promise of the object being put
**/
exports.s3PutObject = (params) => {
  deprecate('@cumulus/common/aws/s3PutObject', '1.17.1', '@cumulus/aws-client/s3/s3PutObject');
  return s3Utils.s3PutObject(params);
};

/**
* Copy an object from one location on S3 to another
*
* @param {Object} params - same params as https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObject-property
* @returns {Promise} - promise of the object being copied
**/
exports.s3CopyObject = (params) => {
  deprecate('@cumulus/common/aws/s3CopyObject', '1.17.1', '@cumulus/aws-client/s3/s3CopyObject');
  return s3Utils.s3CopyObject(params);
};

/**
 * Upload data to S3
 *
 * Note: This is equivalent to calling `aws.s3().upload(params).promise()`
 *
 * @param {Object} params - see [S3.upload()](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#upload-property)
 * @returns {Promise} see [S3.upload()](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#upload-property)
 */
exports.promiseS3Upload = (params) => {
  deprecate('@cumulus/common/aws/promiseS3Upload', '1.17.1', '@cumulus/aws-client/s3/promiseS3Upload');
  return s3Utils.promiseS3Upload(params);
};

/**
 * Downloads the given s3Obj to the given filename in a streaming manner
 *
 * @param {Object} s3Obj - The parameters to send to S3 getObject call
 * @param {string} filepath - The filepath of the file that is downloaded
 * @returns {Promise<string>} - returns filename if successful
 */
exports.downloadS3File = (s3Obj, filepath) => {
  deprecate('@cumulus/common/aws/downloadS3File', '1.17.1', '@cumulus/aws-client/s3/downloadS3File');
  return s3Utils.downloadS3File(s3Obj, filepath);
};

/**
* Get an object header from S3
*
* @param {string} Bucket - name of bucket
* @param {string} Key - key for object (filepath + filename)
* @returns {Promise} - returns response from `S3.headObject` as a promise
**/
exports.headObject = (Bucket, Key) => {
  deprecate('@cumulus/common/aws/headObject', '1.17.1', '@cumulus/aws-client/s3/headObject');
  return s3Utils.headObject(Bucket, Key);
};

/**
 * Get the size of an S3Object, in bytes
 *
 * @param {string} bucket - S3 bucket
 * @param {string} key - S3 key
 * @returns {Promise<integer>} - object size, in bytes
 */
exports.getObjectSize = (bucket, key) => {
  deprecate('@cumulus/common/aws/getObjectSize', '1.17.1', '@cumulus/aws-client/s3/getObjectSize');
  return s3Utils.getObjectSize(bucket, key);
};

/**
* Get object Tagging from S3
*
* @param {string} bucket - name of bucket
* @param {string} key - key for object (filepath + filename)
* @returns {Promise} - returns response from `S3.getObjectTagging` as a promise
**/
exports.s3GetObjectTagging = (bucket, key) => {
  deprecate('@cumulus/common/aws/s3GetObjectTagging', '1.17.1', '@cumulus/aws-client/s3/s3GetObjectTagging');
  return s3Utils.s3GetObjectTagging(bucket, key);
};

/**
* Puts object Tagging in S3
* https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObjectTagging-property
*
* @param {string} Bucket - name of bucket
* @param {string} Key - key for object (filepath + filename)
* @param {Object} Tagging - tagging object
* @returns {Promise} - returns response from `S3.getObjectTagging` as a promise
**/
exports.s3PutObjectTagging = (Bucket, Key, Tagging) => {
  deprecate('@cumulus/common/aws/s3PutObjectTagging', '1.17.1', '@cumulus/aws-client/s3/s3PutObjectTagging');
  return s3Utils.s3PutObjectTagging(Bucket, Key, Tagging);
};

/**
* Get an object from S3
*
* @param {string} Bucket - name of bucket
* @param {string} Key - key for object (filepath + filename)
* @param {Object} retryOptions - options to control retry behavior when an
*   object does not exist. See https://github.com/tim-kos/node-retry#retryoperationoptions
*   By default, retries will not be performed
* @returns {Promise} - returns response from `S3.getObject` as a promise
**/
exports.getS3Object = (Bucket, Key, retryOptions = { retries: 0 }) => {
  deprecate('@cumulus/common/aws/getS3Object', '1.17.1', '@cumulus/aws-client/s3/getS3Object');
  return s3Utils.getS3Object(Bucket, Key, retryOptions);
};

exports.getJsonS3Object = (bucket, key) => {
  deprecate('@cumulus/common/aws/getJsonS3Object', '1.17.1', '@cumulus/aws-client/s3/getJsonS3Object');
  return s3Utils.getJsonS3Object(bucket, key);
};

exports.putJsonS3Object = (bucket, key, data) => {
  deprecate('@cumulus/common/aws/putJsonS3Object', '1.17.1', '@cumulus/aws-client/s3/putJsonS3Object');
  return s3Utils.putJsonS3Object(bucket, key, data);
};

exports.getS3ObjectReadStream = (bucket, key) => {
  deprecate('@cumulus/common/aws/getS3ObjectReadStream', '1.17.1', '@cumulus/aws-client/s3/getS3ObjectReadStream');
  return s3Utils.getS3ObjectReadStream(bucket, key);
};

/**
* Check if a file exists in an S3 object
*
* @name fileExists
* @param {string} bucket - name of the S3 bucket
* @param {string} key - key of the file in the S3 bucket
* @returns {Promise} returns the response from `S3.headObject` as a promise
**/
exports.fileExists = async (bucket, key) => {
  deprecate('@cumulus/common/aws/fileExists', '1.17.1', '@cumulus/aws-client/s3/fileExists');
  return s3Utils.fileExists(bucket, key);
};

exports.downloadS3Files = (s3Objs, dir, s3opts = {}) => {
  deprecate('@cumulus/common/aws/downloadS3Files', '1.17.1', '@cumulus/aws-client/s3/downloadS3Files');
  return s3Utils.downloadS3Files(s3Objs, dir, s3opts);
};

/**
 * Delete files from S3
 *
 * @param {Array} s3Objs - An array of objects containing keys 'Bucket' and 'Key'
 * @returns {Promise} A promise that resolves to an Array of the data returned
 *   from the deletion operations
 */
exports.deleteS3Files = (s3Objs) => {
  deprecate('@cumulus/common/aws/deleteS3Files', '1.17.1', '@cumulus/aws-client/s3/deleteS3Files');
  return s3Utils.deleteS3Files(s3Objs);
};

/**
* Delete a bucket and all of its objects from S3
*
* @param {string} bucket - name of the bucket
* @returns {Promise} - the promised result of `S3.deleteBucket`
**/
exports.recursivelyDeleteS3Bucket = async (bucket) => {
  deprecate('@cumulus/common/aws/recursivelyDeleteS3Bucket', '1.17.1', '@cumulus/aws-client/s3/recursivelyDeleteS3Bucket');
  return s3Utils.recursivelyDeleteS3Bucket(bucket);
};

exports.uploadS3Files = (files, defaultBucket, keyPath, s3opts = {}) => {
  deprecate('@cumulus/common/aws/uploadS3Files', '1.17.1', '@cumulus/aws-client/s3/uploadS3Files');
  return s3Utils.uploadS3Files(files, defaultBucket, keyPath, s3opts);
};

/**
 * Upload the file associated with the given stream to an S3 bucket
 *
 * @param {ReadableStream} fileStream - The stream for the file's contents
 * @param {string} bucket - The S3 bucket to which the file is to be uploaded
 * @param {string} key - The key to the file in the bucket
 * @param {Object} s3opts - Options to pass to the AWS sdk call (defaults to `{}`)
 * @returns {Promise} A promise
 */
exports.uploadS3FileStream = (fileStream, bucket, key, s3opts = {}) => {
  deprecate('@cumulus/common/aws/uploadS3FileStream', '1.17.1', '@cumulus/aws-client/s3/uploadS3FileStream');
  return s3Utils.uploadS3FileStream(fileStream, bucket, key, s3opts);
};

/**
 * List the objects in an S3 bucket
 *
 * @param {string} bucket - The name of the bucket
 * @param {string} prefix - Only objects with keys starting with this prefix
 *   will be included (useful for searching folders in buckets, e.g., '/PDR')
 * @param {boolean} skipFolders - If true don't return objects that are folders
 *   (defaults to true)
 * @returns {Promise} - A promise that resolves to the list of objects. Each S3
 *   object is represented as a JS object with the following attributes: `Key`,
 * `ETag`, `LastModified`, `Owner`, `Size`, `StorageClass`.
 */
exports.listS3Objects = (bucket, prefix = null, skipFolders = true) => {
  deprecate('@cumulus/common/aws/listS3Objects', '1.17.1', '@cumulus/aws-client/s3/listS3Objects');
  return s3Utils.listS3Objects(bucket, prefix, skipFolders);
};

/**
 * Fetch complete list of S3 objects
 *
 * listObjectsV2 is limited to 1,000 results per call.  This function continues
 * listing objects until there are no more to be fetched.
 *
 * The passed params must be compatible with the listObjectsV2 call.
 *
 * https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#listObjectsV2-property
 *
 * @param {Object} params - params for the s3.listObjectsV2 call
 * @returns {Promise<Array>} - resolves to an array of objects corresponding to
 *   the Contents property of the listObjectsV2 response
 */
exports.listS3ObjectsV2 = (params) => {
  deprecate('@cumulus/common/aws/listS3ObjectsV2', '1.17.1', '@cumulus/aws-client/s3/listS3ObjectsV2');
  return s3Utils.listS3ObjectsV2(params);
};

// Class to efficiently list all of the objects in an S3 bucket, without loading
// them all into memory at once.  Handles paging of listS3ObjectsV2 requests.
class S3ListObjectsV2Queue extends S3ListObjectsV2QueueCore {
  constructor(params) {
    deprecate('@cumulus/common/aws/S3ListObjectsV2QueueCore', '1.17.1', '@cumulus/aws-client/S3ListObjectsV2QueueCore');
    super(params);
  }
}
exports.S3ListObjectsV2Queue = S3ListObjectsV2Queue;

/**
 * Calculate checksum for S3 Object
 *
 * @param {Object} params - params
 * @param {string} params.algorithm - checksum algorithm
 * @param {string} params.bucket - S3 bucket
 * @param {string} params.key - S3 key
 * @param {Object} [params.options] - crypto.createHash options
 *
 * @returns {number|string} - calculated checksum
 */
exports.calculateS3ObjectChecksum = async ({
  algorithm,
  bucket,
  key,
  options
}) => {
  deprecate('@cumulus/common/aws/calculateS3ObjectChecksum', '1.17.1', '@cumulus/aws-client/s3/calculateS3ObjectChecksum');
  return s3Utils.calculateS3ObjectChecksum({
    algorithm,
    bucket,
    key,
    options
  });
};

/**
 * Validate S3 object checksum against expected sum
 *
 * @param {Object} params - params
 * @param {string} params.algorithm - checksum algorithm
 * @param {string} params.bucket - S3 bucket
 * @param {string} params.key - S3 key
 * @param {number|string} params.expectedSum - expected checksum
 * @param {Object} [params.options] - crypto.createHash options
 *
 * @throws {InvalidChecksum} - Throws error if validation fails
 * @returns {boolean} - returns true for success
 */
exports.validateS3ObjectChecksum = async ({
  algorithm,
  bucket,
  key,
  expectedSum,
  options
}) => {
  deprecate('@cumulus/common/aws/validateS3ObjectChecksum', '1.17.1', '@cumulus/aws-client/s3/validateS3ObjectChecksum');
  return s3Utils.validateS3ObjectChecksum({
    algorithm,
    bucket,
    key,
    expectedSum,
    options
  });
};

/**
* parse an s3 uri to get the bucket and key
*
* @param {string} uri - must be a uri with the `s3://` protocol
* @returns {Object} Returns an object with `Bucket` and `Key` properties
**/
exports.parseS3Uri = (uri) => {
  deprecate('@cumulus/common/aws/parseS3Uri', '1.17.1', '@cumulus/aws-client/s3/parseS3Uri');
  return s3Utils.parseS3Uri(uri);
};

/**
 * Given a bucket and key, return an S3 URI
 *
 * @param {string} bucket - an S3 bucket name
 * @param {string} key - an S3 key
 * @returns {string} - an S3 URI
 */
exports.buildS3Uri = (bucket, key) => {
  deprecate('@cumulus/common/aws/buildS3Uri', '1.17.1', '@cumulus/aws-client/s3/buildS3Uri');
  return s3Utils.buildS3Uri(bucket, key);
};

/** DynamoDB utils */

/**
 * Create a DynamoDB table and then wait for the table to exist
 *
 * @param {Object} params - the same params that you would pass to AWS.createTable
 *   See https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB.html#createTable-property
 * @returns {Promise<Object>} - the output of the createTable call
 */
exports.createAndWaitForDynamoDbTable = async (params) => {
  deprecate('@cumulus/common/aws/createAndWaitForDynamoDbTable', '1.17.1', '@cumulus/aws-client/dynamo/createAndWaitForDynamoDbTable');
  return dynamoDbUtils.createAndWaitForDynamoDbTable(params);
};

// Class to efficiently search all of the items in a DynamoDB table, without
// loading them all into memory at once.  Handles paging.
class DynamoDbSearchQueue extends DynamoDbSearchQueueCore {
  constructor(params, searchType = 'scan') {
    deprecate('@cumulus/common/aws/DynamoDbSearchQueue', '1.17.1', '@cumulus/aws-client/DynamoDbSearchQueue');
    super(params, searchType);
  }
}
exports.DynamoDbSearchQueue = DynamoDbSearchQueue;

/** SQS utils */

/**
 * Create an SQS Queue.  Properly handles localstack queue URLs
 *
 * @param {string} queueName - defaults to a random string
 * @returns {Promise.<string>} the Queue URL
 */
exports.createQueue = (queueName) => {
  deprecate('@cumulus/common/aws/createQueue', '1.17.1', '@cumulus/aws-client/sqs/createQueue');
  return sqsUtils.createQueue(queueName);
};

exports.getQueueUrl = (sourceArn, queueName) => {
  deprecate('@cumulus/common/aws/getQueueUrl', '1.17.1', '@cumulus/aws-client/sqs/getQueueUrl');
  return sqsUtils.getQueueUrl(sourceArn, queueName);
};

/**
* Send a message to AWS SQS
*
* @param {string} queueUrl - url of the SQS queue
* @param {string|Object} message - either string or object message. If an
*   object it will be serialized into a JSON string.
* @returns {Promise} - resolves when the messsage has been sent
**/
exports.sendSQSMessage = (queueUrl, message) => {
  deprecate('@cumulus/common/aws/sendSQSMessage', '1.17.1', '@cumulus/aws-client/sqs/sendSQSMessage');
  return sqsUtils.sendSQSMessage(queueUrl, message);
};

/**
 * Receives SQS messages from a given queue. The number of messages received
 * can be set and the timeout is also adjustable.
 *
 * @param {string} queueUrl - url of the SQS queue
 * @param {Object} options - options object
 * @param {integer} [options.numOfMessages=1] - number of messages to read from the queue
 * @param {integer} [options.visibilityTimeout=30] - number of seconds a message is invisible
 *   after read
 * @param {integer} [options.waitTimeSeconds=0] - number of seconds to poll SQS queue (long polling)
 * @returns {Promise.<Array>} an array of messages
 */
exports.receiveSQSMessages = async (queueUrl, options) => {
  deprecate('@cumulus/common/aws/receiveSQSMessages', '1.17.1', '@cumulus/aws-client/sqs/receiveSQSMessages');
  return sqsUtils.receiveSQSMessages(queueUrl, options);
};

/**
 * Delete a given SQS message from a given queue.
 *
 * @param {string} queueUrl - url of the SQS queue
 * @param {integer} receiptHandle - the unique identifier of the sQS message
 * @returns {Promise} an AWS SQS response
 */
exports.deleteSQSMessage = (queueUrl, receiptHandle) => {
  deprecate('@cumulus/common/aws/deleteSQSMessage', '1.17.1', '@cumulus/aws-client/sqs/deleteSQSMessage');
  return sqsUtils.deleteSQSMessage(queueUrl, receiptHandle);
};

/**
 * Test if an SQS queue exists
 *
 * @param {Object} queue - queue name or url
 * @returns {Promise<boolean>} - a Promise that will resolve to a boolean indicating
 *                               if the queue exists
 */
exports.sqsQueueExists = (queue) => {
  deprecate('@cumulus/common/aws/sqsQueueExists', '1.17.1', '@cumulus/aws-client/sqs/sqsQueueExists');
  return sqsUtils.sqsQueueExists(queue);
};

/** Step Functions utils */

/**
 * Given an array of fields, returns that a new string that's safe for use as a StepFunction,
 * execution name, where all fields are joined by a StepFunction-safe delimiter
 * Important: This transformation isn't entirely two-way. Names longer than 80 characters
 *            will be truncated.
 *
 * @param {string} fields - The fields to be injected into an execution name
 * @param {string} delimiter - An optional delimiter string to replace, pass null to make
 *   no replacements
 * @returns {string} A string that's safe to use as a StepFunctions execution name
 */
exports.toSfnExecutionName = (fields, delimiter = '__') => {
  deprecate('@cumulus/common/aws/toSfnExecutionName', '1.17.1', '@cumulus/aws-client/step-functions/toSfnExecutionName');
  return stepFunctionUtils.toSfnExecutionName(fields, delimiter);
};

/**
 * Opposite of toSfnExecutionName. Given a delimited StepFunction execution name, returns
 * an array of its original fields
 * Important: This value may be truncated from the original because of the 80-char limit on
 *            execution names
 *
 * @param {string} str - The string to make stepfunction safe
 * @param {string} [delimiter='__'] - An optional delimiter string to replace, pass null to make
 *   no replacements
 * @returns {Array} An array of the original fields
 */
exports.fromSfnExecutionName = (str, delimiter = '__') => {
  deprecate('@cumulus/common/aws/fromSfnExecutionName', '1.17.1', '@cumulus/aws-client/step-functions/fromSfnExecutionName');
  return stepFunctionUtils.fromSfnExecutionName(str, delimiter);
};

/**
 * Returns execution ARN from a statement machine Arn and executionName
 *
 * @param {string} stateMachineArn - state machine ARN
 * @param {string} executionName - state machine's execution name
 * @returns {string} - Step Function Execution Arn
 */
exports.getExecutionArn = (stateMachineArn, executionName) => {
  deprecate('@cumulus/common/aws/getExecutionArn', '1.17.1', '@cumulus/aws-client/step-functions/getExecutionArn');
  return stepFunctionUtils.getExecutionArn(stateMachineArn, executionName);
};

exports.getStateMachineArn = (executionArn) => {
  deprecate('@cumulus/common/aws/getStateMachineArn', '1.17.1', '@cumulus/aws-client/step-functions/getStateMachineArn');
  return stepFunctionUtils.getStateMachineArn(executionArn);
};

/**
 * Publish a message to an SNS topic. Does not catch
 * errors, to allow more specific handling by the caller.
 *
 * @param {string} snsTopicArn - SNS topic ARN
 * @param {Object} message - Message object
 * @param {Object} retryOptions - options to control retry behavior when publishing
 * a message fails. See https://github.com/tim-kos/node-retry#retryoperationoptions
 * @returns {Promise<undefined>}
 */
exports.publishSnsMessage = async (
  snsTopicArn,
  message,
  retryOptions = {}
) =>
  pRetry(
    async () => {
      if (!snsTopicArn) {
        throw new pRetry.AbortError('Missing SNS topic ARN');
      }

      await exports.sns().publish({
        TopicArn: snsTopicArn,
        Message: JSON.stringify(message)
      }).promise();
    },
    {
      maxTimeout: 5000,
      onFailedAttempt: (err) => log.debug(`publishSnsMessage('${snsTopicArn}', '${message}') failed with ${err.retriesLeft} retries left: ${err.message}`),
      ...retryOptions
    }
  );

/**
 * Test to see if a given exception is an AWS Throttling Exception
 *
 * @param {Error} err
 * @returns {boolean}
 */
exports.isThrottlingException = (err) => err.code === 'ThrottlingException';

/**
 * Given a Cumulus step function event, if the message is on S3, pull the full message
 * from S3 and return, otherwise return the event.
 *
 * @param {Object} event - the Cumulus event
 * @returns {Object} - the full Cumulus message
 */
exports.pullStepFunctionEvent = async (event) => {
  if (!event.replace) return event;

  const remoteMsgS3Object = await exports.getS3Object(
    event.replace.Bucket,
    event.replace.Key,
    { retries: 0 }
  );
  const remoteMsg = JSON.parse(remoteMsgS3Object.Body.toString());

  let returnEvent = remoteMsg;
  if (event.replace.TargetPath) {
    const replaceNodeSearch = JSONPath({
      path: event.replace.TargetPath,
      json: event,
      resultType: 'all'
    });
    if (replaceNodeSearch.length !== 1) {
      throw new Error(`Replacement TargetPath ${event.replace.TargetPath} invalid`);
    }
    if (replaceNodeSearch[0].parent) {
      replaceNodeSearch[0].parent[replaceNodeSearch[0].parentProperty] = remoteMsg;
      returnEvent = event;
      delete returnEvent.replace;
    }
  }
  return returnEvent;
};

const retryIfThrottlingException = (err) => {
  if (exports.isThrottlingException(err)) throw err;
  throw new pRetry.AbortError(err);
};

/**
 * Wrap a function so that it will retry when a ThrottlingException is encountered.
 *
 * @param {Function} fn - the function to retry.  This function must return a Promise.
 * @param {Object} options - retry options, documented here:
 *   - https://github.com/sindresorhus/p-retry#options
 *   - https://github.com/tim-kos/node-retry#retryoperationoptions
 *   - https://github.com/tim-kos/node-retry#retrytimeoutsoptions
 * @returns {Function} a function that will retry on a ThrottlingException
 */
exports.retryOnThrottlingException = (fn, options) =>
  (...args) =>
    pRetry(
      () => fn(...args).catch(retryIfThrottlingException),
      { maxTimeout: 5000, ...options }
    );

/**
 * Extract the S3 bucket and key from the URL path parameters
 *
 * @param {string} pathParams - path parameters from the URL
 * @returns {Object} - bucket/key in the form of
 * { Bucket: x, Key: y }
 */
exports.getFileBucketAndKey = (pathParams) => {
  const fields = pathParams.split('/');

  const Bucket = fields.shift();
  const Key = fields.join('/');

  if (Bucket.length === 0 || Key.length === 0) {
    throw new UnparsableFileLocationError(`File location "${pathParams}" could not be parsed`);
  }

  return [Bucket, Key];
};
