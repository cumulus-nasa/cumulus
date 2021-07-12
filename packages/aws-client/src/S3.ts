/**
 * @module S3
 */

import fs from 'fs';
import isBoolean from 'lodash/isBoolean';
import path from 'path';
import pMap from 'p-map';
import pRetry from 'p-retry';
import pWaitFor from 'p-wait-for';
import pump from 'pump';
import querystring from 'querystring';
import { Readable, TransformOptions } from 'stream';
import { deprecate } from 'util';

import {
  generateChecksumFromStream,
  validateChecksumFromStream,
} from '@cumulus/checksum';
import {
  InvalidChecksum,
  UnparsableFileLocationError,
} from '@cumulus/errors';
import Logger from '@cumulus/logger';

import * as S3MultipartUploads from './lib/S3MultipartUploads';
import { s3 } from './services';
import { inTestMode } from './test-utils';
import { improveStackTrace } from './utils';

export type GetObjectCreateReadStreamMethod = (params: AWS.S3.GetObjectRequest) => {
  createReadStream: () => Readable
};

export type GetObjectPromiseMethod = (params: AWS.S3.GetObjectRequest) => {
  promise: () => Promise<AWS.S3.GetObjectOutput>
};

export type Object = Required<AWS.S3.Object>;

export interface ListObjectsV2Output extends AWS.S3.ListObjectsV2Output {
  Contents: Object[]
}

const log = new Logger({ sender: 'aws-client/s3' });

const buildDeprecationMessage = (
  name: string,
  version: string,
  alternative?: string
) => {
  let message = `${name} is deprecated after version ${version} and will be removed in a future release.`;
  if (alternative) message += ` Use ${alternative} instead.`;

  return log.buildMessage('warn', message);
};

const S3_RATE_LIMIT = inTestMode() ? 1 : 20;

/**
 * Join strings into an S3 key without a leading slash
 *
 * @param {...string|Array<string>} args - the strings to join
 * @returns {string} the full S3 key
 */
export const s3Join = (...args: [string | string[], ...string[]]) => {
  let tokens: string[];
  if (typeof args[0] === 'string') tokens = <string[]>args;
  else tokens = args[0];

  const removeLeadingSlash = (token: string) => token.replace(/^\//, '');
  const removeTrailingSlash = (token: string) => token.replace(/\/$/, '');
  const isNotEmptyString = (token: string) => token.length > 0;

  const key = tokens
    .map(removeLeadingSlash)
    .map(removeTrailingSlash)
    .filter(isNotEmptyString)
    .join('/');

  if (tokens[tokens.length - 1].endsWith('/')) return `${key}/`;
  return key;
};

/**
* parse an s3 uri to get the bucket and key
*
* @param {string} uri - must be a uri with the `s3://` protocol
* @returns {Object} Returns an object with `Bucket` and `Key` properties
**/
export const parseS3Uri = (uri: string) => {
  const match = uri.match('^s3://([^/]+)/(.*)$');

  if (match === null) {
    throw new TypeError(`Unable to parse S3 URI: ${uri}`);
  }

  return {
    Bucket: match[1],
    Key: match[2],
  };
};

/**
 * Given a bucket and key, return an S3 URI
 *
 * @param {string} bucket - an S3 bucket name
 * @param {string} key - an S3 key
 * @returns {string} an S3 URI
 */
export const buildS3Uri = (bucket: string, key: string) =>
  `s3://${bucket}/${key.replace(/^\/+/, '')}`;

/**
* Convert S3 TagSet Object to query string
* e.g. [{ Key: 'tag', Value: 'value }] to 'tag=value'
*
* @param {Array<Object>} tagset - S3 TagSet array
* @returns {string} tags query string
*/
export const s3TagSetToQueryString = (tagset: AWS.S3.TagSet) =>
  tagset.map(({ Key, Value }) => `${Key}=${Value}`).join('&');

/**
 * Delete an object from S3
 *
 * @param {string} bucket - bucket where the object exists
 * @param {string} key - key of the object to be deleted
 * promise of the object being deleted
 */
export const deleteS3Object = improveStackTrace(
  (bucket: string, key: string) =>
    s3().deleteObject({ Bucket: bucket, Key: key }).promise()
);

/**
* Get an object header from S3
*
* @param {string} Bucket - name of bucket
* @param {string} Key - key for object (filepath + filename)
* @param {Object} retryOptions - options to control retry behavior when an
*   object does not exist. See https://github.com/tim-kos/node-retry#retryoperationoptions
*   By default, retries will not be performed
* @returns {Promise} returns response from `S3.headObject` as a promise
**/
export const headObject = improveStackTrace(
  (Bucket: string, Key: string, retryOptions: pRetry.Options = { retries: 0 }) =>
    pRetry(
      async () => {
        try {
          return await s3().headObject({ Bucket, Key }).promise();
        } catch (error) {
          if (error.code === 'NotFound') throw error;
          throw new pRetry.AbortError(error);
        }
      },
      { maxTimeout: 10000, ...retryOptions }
    )
);

/**
 * Test if an object exists in S3
 *
 * @param {Object} params - same params as https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#headObject-property
 * @returns {Promise<boolean>} a Promise that will resolve to a boolean indicating
 *                               if the object exists
 */
export const s3ObjectExists = (params: { Bucket: string, Key: string }) =>
  headObject(params.Bucket, params.Key)
    .then(() => true)
    .catch((error) => {
      if (error.code === 'NotFound') return false;
      throw error;
    });

/**
 * Wait for an object to exist in S3
 *
 * @param {Object} params
 * @param {string} params.bucket
 * @param {string} params.key
 * @param {number} [params.interval=1000] - interval before retries, in ms
 * @param {number} [params.timeout=30000] - timeout, in ms
 * @returns {Promise<undefined>}
 */
export const waitForObjectToExist = async (params: {
  bucket: string,
  key: string,
  interval: number,
  timeout: number
}) => {
  const {
    bucket,
    key,
    interval = 1000,
    timeout = 30 * 1000,
  } = params;

  await pWaitFor(
    () => s3ObjectExists({ Bucket: bucket, Key: key }),
    { interval, timeout }
  );
};

/**
* Put an object on S3
*
* @param {Object} params - same params as https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObject-property
* promise of the object being put
**/
export const s3PutObject = improveStackTrace(
  (params: AWS.S3.PutObjectRequest) => s3().putObject({
    ACL: 'private',
    ...params,
  }).promise()
);

/**
 * Upload a file to S3
 *
 * @param {string} bucket - the destination S3 bucket
 * @param {string} key - the destination S3 key
 * @param {filename} filename - the local file to be uploaded
 * @returns {Promise}
 */
export const putFile = (bucket: string, key: string, filename: string) =>
  s3PutObject({
    Bucket: bucket,
    Key: key,
    Body: fs.createReadStream(filename),
  });

/**
* Copy an object from one location on S3 to another
*
* @param {Object} params - same params as https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObject-property
* @returns {Promise} promise of the object being copied
**/
export const s3CopyObject = improveStackTrace(
  (params: AWS.S3.CopyObjectRequest) => s3().copyObject({
    TaggingDirective: 'COPY',
    ...params,
  }).promise()
);

/**
 * Upload data to S3
 *
 * Note: This is equivalent to calling `aws.s3().upload(params).promise()`
 *
 * @param {Object} params - see [S3.upload()](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#upload-property)
 * @returns {Promise} see [S3.upload()](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#upload-property)
 */
export const promiseS3Upload = improveStackTrace(
  (params: AWS.S3.PutObjectRequest) => s3().upload(params).promise()
);

/**
 * Downloads the given s3Obj to the given filename in a streaming manner
 *
 * @param {Object} s3Obj - The parameters to send to S3 getObject call
 * @param {string} filepath - The filepath of the file that is downloaded
 * @returns {Promise<string>} returns filename if successful
 */
export const downloadS3File = (
  s3Obj: AWS.S3.GetObjectRequest,
  filepath: string
): Promise<string> => {
  const fileWriteStream = fs.createWriteStream(filepath);

  return new Promise((resolve, reject) => {
    const objectReadStream = s3().getObject(s3Obj).createReadStream();

    pump(objectReadStream, fileWriteStream, (err) => {
      if (err) reject(err);
      else resolve(filepath);
    });
  });
};

/**
 * Get the size of an S3 object
 *
 * @param {Object} params
 * @param {string} params.bucket
 * @param {string} params.key
 * @param {AWS.S3} params.s3 - an S3 client instance
 * @returns {Promise<number|undefined>} object size, in bytes
 */
export const getObjectSize = async (
  params: {
    s3: {
      headObject: (params: { Bucket: string, Key: string }) => {
        promise: () => Promise<{ ContentLength?: number }>
      }
    },
    bucket: string,
    key: string
  }
) => {
  // eslint-disable-next-line no-shadow
  const { s3, bucket, key } = params;

  const headObjectResponse = await s3.headObject({
    Bucket: bucket,
    Key: key,
  }).promise();

  return headObjectResponse.ContentLength;
};

/**
* Get object Tagging from S3
*
* @param {string} bucket - name of bucket
* @param {string} key - key for object (filepath + filename)
* @returns {Promise<AWS.S3.GetObjectTaggingOutput>} the promised response from `S3.getObjectTagging`
**/
export const s3GetObjectTagging = improveStackTrace(
  (bucket: string, key: string) =>
    s3().getObjectTagging({ Bucket: bucket, Key: key }).promise()
);

const getObjectTags = async (bucket: string, key: string) => {
  const taggingResponse = await s3GetObjectTagging(bucket, key);

  return taggingResponse.TagSet.reduce(
    (acc, { Key, Value }) => ({ ...acc, [Key]: Value }),
    {}
  );
};

const getObjectTaggingString = async (bucket: string, key: string) => {
  const tags = await getObjectTags(bucket, key);

  return querystring.stringify(tags);
};

/**
* Puts object Tagging in S3
* https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObjectTagging-property
*
* @param {string} Bucket - name of bucket
* @param {string} Key - key for object (filepath + filename)
* @param {Object} Tagging - tagging object
* @returns {Promise} returns response from `S3.getObjectTagging` as a promise
**/
export const s3PutObjectTagging = improveStackTrace(
  (Bucket: string, Key: string, Tagging: AWS.S3.Tagging) =>
    s3().putObjectTagging({
      Bucket,
      Key,
      Tagging,
    }).promise()
);

/**
 * Gets an object from S3.
 *
 * @example
 * const obj = await getObject(s3(), { Bucket: 'b', Key: 'k' })
 *
 * @param {AWS.S3} s3 - an `AWS.S3` instance
 * @param {AWS.S3.GetObjectRequest} params - parameters object to pass through
 *   to `AWS.S3.getObject()`
 * @returns {Promise<AWS.S3.GetObjectOutput>} response from `AWS.S3.getObject()`
 *   as a Promise
 */
export const getObject = (
  // eslint-disable-next-line no-shadow
  s3: { getObject: GetObjectPromiseMethod },
  params: AWS.S3.GetObjectRequest
): Promise<AWS.S3.GetObjectOutput> => s3.getObject(params).promise();

/**
 * Get an object from S3, waiting for it to exist and, if specified, have the
 * correct ETag.
 *
 * @param {AWS.S3} s3Client
 * @param {AWS.S3.GetObjectRequest} params
 * @param {pRetry.Options} [retryOptions={}]
 * @returns {Promise<AWS.S3.GetObjectOutput>}
 */
export const waitForObject = (
  s3Client: { getObject: GetObjectPromiseMethod },
  params: AWS.S3.GetObjectRequest,
  retryOptions: pRetry.Options = {}
): Promise<AWS.S3.GetObjectOutput> =>
  pRetry(
    async () => {
      try {
        return await getObject(s3Client, params);
      } catch (error) {
        // Retry if the object does not exist
        if (error.code === 'NoSuchKey') throw error;

        // Retry if the etag did not match
        if (params.IfMatch && error.code === 'PreconditionFailed') throw error;

        // For any other error, fail without retrying
        throw new pRetry.AbortError(error);
      }
    },
    retryOptions
  );

/**
 * Gets an object from S3.
 *
 * @param {string} Bucket - name of bucket
 * @param {string} Key - key for object (filepath + filename)
 * @param {Object} retryOptions - options to control retry behavior when an
 *   object does not exist. See https://github.com/tim-kos/node-retry#retryoperationoptions
 *   By default, retries will not be performed
 * @returns {Promise} returns response from `S3.getObject` as a promise
 *
 * @deprecated
 */
export const getS3Object = deprecate(
  improveStackTrace(
    (Bucket: string, Key: string, retryOptions: pRetry.Options = { retries: 0 }) =>
      waitForObject(
        s3(),
        { Bucket, Key },
        {
          maxTimeout: 10000,
          onFailedAttempt: (err) => log.debug(`getS3Object('${Bucket}', '${Key}') failed with ${err.retriesLeft} retries left: ${err.message}`),
          ...retryOptions,
        }
      )
  ),
  buildDeprecationMessage(
    '@cumulus/aws-client/S3.getS3Object',
    '2.0.1',
    '@cumulus/aws-client/S3.getObject or @cumulus/aws-client/S3.waitForObject'
  )
);

/**
 * Fetch the contents of an S3 object
 *
 * @param {string} bucket - the S3 object's bucket
 * @param {string} key - the S3 object's key
 * @returns {Promise<string>} the contents of the S3 object
 */
export const getTextObject = (bucket: string, key: string) =>
  getS3Object(bucket, key)
    .then(({ Body }) => {
      if (Body === undefined) return undefined;
      return Body.toString();
    });

/**
 * Fetch JSON stored in an S3 object
 * @param {string} bucket - the S3 object's bucket
 * @param {string} key - the S3 object's key
 * @returns {Promise<*>} the contents of the S3 object, parsed as JSON
 */
export const getJsonS3Object = (bucket: string, key: string) =>
  getTextObject(bucket, key)
    .then((text) => {
      if (text === undefined) return undefined;
      return JSON.parse(text);
    });

export const putJsonS3Object = (bucket: string, key: string, data: any) =>
  s3PutObject({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(data),
  });

/**
 * Get a readable stream for an S3 object
 *
 * @param {Object} params
 * @param {AWS.S3} params.s3 - an AWS.S3 instance
 * @param {string} params.bucket - the bucket of the requested object
 * @param {string} params.key - the key of the requested object
 * @returns {Readable}
 */
export const getObjectReadStream = (params: {
  s3: { getObject: GetObjectCreateReadStreamMethod },
  bucket: string,
  key: string
}) => {
  // eslint-disable-next-line no-shadow
  const { s3, bucket, key } = params;

  return s3.getObject({ Bucket: bucket, Key: key }).createReadStream();
};

/**
* Check if a file exists in an S3 object
*
* @param {string} bucket - name of the S3 bucket
* @param {string} key - key of the file in the S3 bucket
* @returns {Promise} returns the response from `S3.headObject` as a promise
**/
export const fileExists = async (bucket: string, key: string) => {
  try {
    const r = await s3().headObject({ Key: key, Bucket: bucket }).promise();
    return r;
  } catch (error) {
    // if file is not return false
    if (error.stack.match(/(NotFound)/) || error.stack.match(/(NoSuchBucket)/)) {
      return false;
    }
    throw error;
  }
};

export const downloadS3Files = async (
  s3Objs: AWS.S3.GetObjectRequest[],
  dir: string,
  s3opts: Partial<AWS.S3.GetObjectRequest> = {}
) => {
  // Scrub s3Ojbs to avoid errors from the AWS SDK
  const scrubbedS3Objs = s3Objs.map((s3Obj) => ({
    Bucket: s3Obj.Bucket,
    Key: s3Obj.Key,
  }));
  let i = 0;
  const n = s3Objs.length;
  log.info(`Starting download of ${n} keys to ${dir}`);
  const promiseDownload = (s3Obj: AWS.S3.GetObjectRequest) => {
    const filename = path.join(dir, path.basename(s3Obj.Key));
    const file = fs.createWriteStream(filename);
    const opts = Object.assign(s3Obj, s3opts);
    return new Promise((resolve, reject) => {
      s3().getObject(opts)
        .createReadStream()
        .pipe(file)
        .on('finish', () => {
          log.info(`Progress: [${i} of ${n}] s3://${s3Obj.Bucket}/${s3Obj.Key} -> ${filename}`);
          i += 1;
          return resolve(s3Obj.Key);
        })
        .on('error', reject);
    });
  };

  return await pMap(scrubbedS3Objs, promiseDownload, { concurrency: S3_RATE_LIMIT });
};

/**
 * Delete files from S3
 *
 * @param {Array} s3Objs - An array of objects containing keys 'Bucket' and 'Key'
 * @returns {Promise} A promise that resolves to an Array of the data returned
 *   from the deletion operations
 */
export const deleteS3Files = async (s3Objs: AWS.S3.DeleteObjectRequest[]) => await pMap(
  s3Objs,
  (s3Obj) => s3().deleteObject(s3Obj).promise(),
  { concurrency: S3_RATE_LIMIT }
);

/**
* Delete a bucket and all of its objects from S3
*
* @param {string} bucket - name of the bucket
* @returns {Promise} the promised result of `S3.deleteBucket`
**/
export const recursivelyDeleteS3Bucket = improveStackTrace(
  async (bucket: string) => {
    const response = await s3().listObjects({ Bucket: bucket }).promise();
    const s3Objects: AWS.S3.DeleteObjectRequest[] = (response.Contents || []).map((o) => {
      if (!o.Key) throw new Error(`Unable to determine S3 key of ${JSON.stringify(o)}`);

      return {
        Bucket: bucket,
        Key: o.Key,
      };
    });

    await deleteS3Files(s3Objects);
    await s3().deleteBucket({ Bucket: bucket }).promise();
  }
);

/**
* Delete a list of buckets and all of their objects from S3
*
* @param {Array} buckets - list of bucket names
* @returns {Promise} the promised result of `S3.deleteBucket`
**/
export const deleteS3Buckets = async (
  buckets: Array<string>
): Promise<any> => await Promise.all(buckets.map(recursivelyDeleteS3Bucket));

type FileInfo = {
  filename: string,
  key: string,
  bucket: string
};

export const uploadS3Files = async (
  files: Array<string | FileInfo>,
  defaultBucket: string,
  keyPath: string | ((x: string) => string),
  s3opts: Partial<AWS.S3.PutObjectRequest> = {}
) => {
  let i = 0;
  const n = files.length;
  if (n > 1) {
    log.info(`Starting upload of ${n} keys`);
  }
  const promiseUpload = async (file: string | FileInfo) => {
    let bucket: string;
    let filename: string;
    let key: string;

    if (typeof file === 'string') {
      bucket = defaultBucket;
      filename = file;

      if (typeof keyPath === 'string') {
        key = s3Join(keyPath, path.basename(file));
      } else {
        key = keyPath(file);
      }
    } else {
      bucket = file.bucket || defaultBucket;
      filename = file.filename;
      key = file.key;
    }

    await promiseS3Upload({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(filename),
      ...s3opts,
    });

    i += 1;

    log.info(`Progress: [${i} of ${n}] ${filename} -> s3://${bucket}/${key}`);

    return { key, bucket };
  };

  return await pMap(files, promiseUpload, { concurrency: S3_RATE_LIMIT });
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
export const uploadS3FileStream = (
  fileStream: Readable,
  bucket: string,
  key: string,
  s3opts: Partial<AWS.S3.PutObjectRequest> = {}
) =>
  promiseS3Upload({
    Bucket: bucket,
    Key: key,
    Body: fileStream,
    ...s3opts,
  });

/**
 * List the objects in an S3 bucket
 *
 * @param {string} bucket - The name of the bucket
 * @param {string} prefix - Only objects with keys starting with this prefix
 *   will be included (useful for searching folders in buckets, e.g., '/PDR')
 * @param {boolean} skipFolders - If true don't return objects that are folders
 *   (defaults to true)
 * @returns {Promise} A promise that resolves to the list of objects. Each S3
 *   object is represented as a JS object with the following attributes: `Key`,
 * `ETag`, `LastModified`, `Owner`, `Size`, `StorageClass`.
 */
export const listS3Objects = async (
  bucket: string,
  prefix?: string,
  skipFolders: boolean = true
) => {
  log.info(`Listing objects in s3://${bucket}`);
  const params: AWS.S3.ListObjectsRequest = {
    Bucket: bucket,
  };
  if (prefix) params.Prefix = prefix;

  const data = await s3().listObjects(params).promise();
  let contents = data.Contents || [];
  if (skipFolders) {
    // Filter out any references to folders
    contents = contents.filter((obj) => obj.Key !== undefined && !obj.Key.endsWith('/'));
  }
  return contents;
};

export type ListS3ObjectsV2Result = Promise<Object[]>;

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
 * @returns {Promise<Array>} resolves to an array of objects corresponding to
 *   the Contents property of the listObjectsV2 response
 *
 * @static
 */
export const listS3ObjectsV2 = async (
  params: AWS.S3.ListObjectsV2Request
): ListS3ObjectsV2Result => {
  // Fetch the first list of objects from S3
  let listObjectsResponse = <ListObjectsV2Output>(
    await s3().listObjectsV2(params).promise()
  );

  let discoveredObjects = listObjectsResponse.Contents;

  // Keep listing more objects from S3 until we have all of them
  while (listObjectsResponse.IsTruncated) {
    // eslint-disable-next-line no-await-in-loop
    listObjectsResponse = <ListObjectsV2Output>(await s3().listObjectsV2(
      // Update the params with a Continuation Token
      {

        ...params,
        ContinuationToken: listObjectsResponse.NextContinuationToken,
      }
    ).promise());
    discoveredObjects = discoveredObjects.concat(listObjectsResponse.Contents);
  }

  return discoveredObjects;
};

/**
 * Calculate the cryptographic hash of an S3 object
 *
 * @param {Object} params
 * @param {AWS.S3} params.s3 - an AWS.S3 instance
 * @param {string} params.algorithm - `cksum`, or an algorithm listed in
 *   `openssl list -digest-algorithms`
 * @param {string} params.bucket
 * @param {string} params.key
 */
export const calculateObjectHash = async (
  params: {
    s3: { getObject: GetObjectCreateReadStreamMethod },
    algorithm: string,
    bucket: string,
    key: string
  }
) => {
  // eslint-disable-next-line no-shadow
  const { algorithm, bucket, key, s3 } = params;

  const stream = getObjectReadStream({ s3, bucket, key });

  return await generateChecksumFromStream(algorithm, stream);
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
 * @returns {Promise<boolean>} returns true for success
 */
export const validateS3ObjectChecksum = async (params: {
  algorithm: string,
  bucket: string,
  key: string,
  expectedSum: string,
  options: TransformOptions
}) => {
  const { algorithm, bucket, key, expectedSum, options } = params;
  const fileStream = getObjectReadStream({ s3: s3(), bucket, key });
  if (await validateChecksumFromStream(algorithm, fileStream, expectedSum, options)) {
    return true;
  }
  const msg = `Invalid checksum for S3 object s3://${bucket}/${key} with type ${algorithm} and expected sum ${expectedSum}`;
  throw new InvalidChecksum(msg);
};

/**
 * Extract the S3 bucket and key from the URL path parameters
 *
 * @param {string} pathParams - path parameters from the URL
 * bucket/key in the form of
 * @returns {Array<string>} `[Bucket, Key]`
 */
export const getFileBucketAndKey = (pathParams: string): [string, string] => {
  const [Bucket, ...fields] = pathParams.split('/');

  const Key = fields.join('/');

  if (Bucket.length === 0 || Key.length === 0) {
    throw new UnparsableFileLocationError(`File location "${pathParams}" could not be parsed`);
  }

  return [Bucket, Key];
};

/**
 * Create an S3 bucket
 *
 * @param {string} Bucket - the name of the S3 bucket to create
 * @returns {Promise}
 */
export const createBucket = (Bucket: string) =>
  s3().createBucket({ Bucket }).promise();

/**
 * Create multiple S3 buckets
 *
 * @param {Array<string>} buckets - the names of the S3 buckets to create
 * @returns {Promise}
 */
export const createS3Buckets = async (
  buckets: Array<string>
): Promise<any> => await Promise.all(buckets.map(createBucket));

const createMultipartUpload = async (
  params: {
    sourceBucket: string,
    sourceKey: string,
    destinationBucket: string,
    destinationKey: string,
    ACL?: AWS.S3.ObjectCannedACL,
    copyTags?: boolean,
    contentType?: AWS.S3.ContentType
  }
) => {
  const uploadParams: AWS.S3.CreateMultipartUploadRequest = {
    Bucket: params.destinationBucket,
    Key: params.destinationKey,
    ACL: params.ACL,
    ContentType: params.contentType,
  };

  if (params.copyTags) {
    uploadParams.Tagging = await getObjectTaggingString(
      params.sourceBucket,
      params.sourceKey
    );
  }

  // Create a multi-part upload (copy) and get its UploadId
  const { UploadId } = await S3MultipartUploads.createMultipartUpload(
    uploadParams
  );

  if (UploadId === undefined) {
    throw new Error('Unable to create multipart upload');
  }

  return UploadId;
};

// This performs an S3 `uploadPartCopy` call. That response includes an `ETag`
// value specific to the part that was uploaded. When `completeMultipartUpload`
// is called later, it needs that `ETag` value, as well as the `PartNumber` for
// each part. Since the `PartNumber` is not included in the `uploadPartCopy`
// response, we are adding it here to make our lives easier when we eventually
// call `completeMultipartUpload`.
const uploadPartCopy = async (
  params: {
    partNumber: number,
    start: number,
    end: number,
    destinationBucket: string,
    destinationKey: string,
    sourceBucket: string,
    sourceKey: string,
    uploadId: string
  }
) => {
  const response = await S3MultipartUploads.uploadPartCopy({
    UploadId: params.uploadId,
    Bucket: params.destinationBucket,
    Key: params.destinationKey,
    PartNumber: params.partNumber,
    CopySource: `/${params.sourceBucket}/${params.sourceKey}`,
    CopySourceRange: `bytes=${params.start}-${params.end}`,
  });

  if (response.CopyPartResult === undefined) {
    throw new Error('Did not get ETag from uploadPartCopy');
  }

  return {
    ETag: response.CopyPartResult.ETag,
    PartNumber: params.partNumber,
  };
};

/**
 * Copy an S3 object to another location in S3 using a multipart copy
 *
 * @param {Object} params
 * @param {string} params.sourceBucket
 * @param {string} params.sourceKey
 * @param {string} params.destinationBucket
 * @param {string} params.destinationKey
 * @param {AWS.S3.HeadObjectOutput} [params.sourceObject]
 *   Output from https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#headObject-property
 * @param {string} [params.ACL] - an [S3 Canned ACL](https://docs.aws.amazon.com/AmazonS3/latest/dev/acl-overview.html#canned-acl)
 * @param {boolean} [params.copyTags=false]
 * @returns {Promise.<{ etag: string }>} object containing the ETag of the
 *    destination object
 */
export const multipartCopyObject = async (
  params: {
    sourceBucket: string,
    sourceKey: string,
    destinationBucket: string,
    destinationKey: string,
    sourceObject?: AWS.S3.HeadObjectOutput,
    ACL?: AWS.S3.ObjectCannedACL,
    copyTags?: boolean,
    copyMetadata?: boolean
  }
): Promise<{etag: string}> => {
  const {
    sourceBucket,
    sourceKey,
    destinationBucket,
    destinationKey,
    ACL,
    copyTags = false,
  } = params;

  const sourceObject = params.sourceObject ?? await headObject(sourceBucket, sourceKey);

  // Create a multi-part upload (copy) and get its UploadId
  const uploadId = await createMultipartUpload({
    sourceBucket,
    sourceKey,
    destinationBucket,
    destinationKey,
    ACL,
    copyTags,
    contentType: sourceObject.ContentType,
  });

  try {
    // Build the separate parts of the multi-part upload (copy)
    const objectSize = sourceObject.ContentLength;

    if (objectSize === undefined) {
      throw new Error(`Unable to determine size of s3://${sourceBucket}/${sourceKey}`);
    }

    const chunks = S3MultipartUploads.createMultipartChunks(objectSize);

    // Submit all of the upload (copy) parts to S3
    const uploadPartCopyResponses = await Promise.all(
      chunks.map(
        ({ start, end }, index) =>
          uploadPartCopy({
            uploadId,
            partNumber: index + 1,
            start,
            end,
            sourceBucket,
            sourceKey,
            destinationBucket,
            destinationKey,
          })
      )
    );

    // Let S3 know that the multi-part upload (copy) is completed
    const { ETag: etag } = await S3MultipartUploads.completeMultipartUpload({
      UploadId: uploadId,
      Bucket: destinationBucket,
      Key: destinationKey,
      MultipartUpload: {
        Parts: uploadPartCopyResponses,
      },
    });

    return { etag };
  } catch (error) {
    // If anything went wrong, make sure that the multi-part upload (copy)
    // is aborted.
    await S3MultipartUploads.abortMultipartUpload({
      Bucket: destinationBucket,
      Key: destinationKey,
      UploadId: uploadId,
    });

    throw error;
  }
};

/**
 * Move an S3 object to another location in S3
 *
 * @param {Object} params
 * @param {string} params.sourceBucket
 * @param {string} params.sourceKey
 * @param {string} params.destinationBucket
 * @param {string} params.destinationKey
 * @param {string} [params.ACL] - an [S3 Canned ACL](https://docs.aws.amazon.com/AmazonS3/latest/dev/acl-overview.html#canned-acl)
 * @param {boolean} [params.copyTags=false]
 * @returns {Promise<undefined>}
 */
export const moveObject = async (
  params: {
    sourceBucket: string,
    sourceKey: string,
    destinationBucket: string,
    destinationKey: string,
    ACL?: AWS.S3.ObjectCannedACL,
    copyTags?: boolean
  }
) => {
  await multipartCopyObject({
    sourceBucket: params.sourceBucket,
    sourceKey: params.sourceKey,
    destinationBucket: params.destinationBucket,
    destinationKey: params.destinationKey,
    ACL: params.ACL,
    copyTags: isBoolean(params.copyTags) ? params.copyTags : true,
  });
  await deleteS3Object(params.sourceBucket, params.sourceKey);
};

/**
 * List keys of an S3 path
 *
 * @param {Object} params - params for the s3.listObjectsV2 call
 * @returns {Promise<Array>} resolves to an array of objects corresponding to
 *   the Contents property of the listObjectsV2 response
 *
 * @static
 */
export const listS3Keys = async (
  params: AWS.S3.ListObjectsV2Request
): ListS3ObjectsV2Result => {
  const s3params = {
    ...params,
    Delimiter: '/',
  };
  return await listS3ObjectsV2(s3params);
};
