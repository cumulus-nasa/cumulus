'use strict';

const aws = require('@cumulus/common/aws');
const log = require('@cumulus/common/log');
const errors = require('@cumulus/common/errors');
const isString = require('lodash.isstring');
const {
  basename,
  dirname,
  isAbsolute,
  normalize
} = require('path');

class S3ProviderClient {
  constructor({ bucket }) {
    if (!isString(bucket)) throw new TypeError('bucket is required');
    this.bucket = bucket;
  }

  /**
   * Download a remote file to disk
   *
   * @param {string} remotePath - the full path to the remote file to be fetched
   * @param {string} localPath - the full local destination file path
   * @returns {Promise<string>} - the path that the file was saved to
   */
  async download(remotePath, localPath) {
    const remoteUrl = `s3://${this.bucket}/${remotePath}`;
    log.info(`Downloading ${remoteUrl} to ${localPath}`);

    const s3Obj = {
      Bucket: this.bucket,
      Key: remotePath
    };

    const retval = await aws.downloadS3File(s3Obj, localPath);
    log.info(`Finishing downloading ${remoteUrl}`);

    return retval;
  }

  /**
   * List all files from a given endpoint
   *
   * @param {string} path - the remote path to list
   * @returns {Promise<Array>} a list of files
   * @private
   */
  async list(path) {
    // absolute paths are not valid S3 prefixes
    const prefix = isAbsolute(path) ? normalize(path.slice(1)) : normalize(path);
    const objects = await aws.listS3ObjectsV2({
      Bucket: this.bucket,
      FetchOwner: true,
      Prefix: prefix
    });

    return objects.map(({ Key, Size, LastModified }) => ({
      name: basename(Key),
      // If the object is at the top level of the bucket, path.dirname is going
      // to return "." as the dirname.  It should instead be null.
      path: dirname(Key) === '.' ? null : dirname(Key),
      size: Size,
      time: (new Date(LastModified)).valueOf()
    }));
  }

  /**
   * Download the remote file to a given s3 location
   *
   * @param {string} remotePath - the full path to the remote file to be fetched
   * @param {string} bucket - destination s3 bucket of the file
   * @param {string} key - destination s3 key of the file
   * @returns {Promise} s3 uri of destination file
   */
  async sync(remotePath, bucket, key) {
    const remoteUrl = aws.buildS3Uri(this.bucket, remotePath);
    const s3uri = aws.buildS3Uri(bucket, key);
    log.info(`Sync ${remoteUrl} to ${s3uri}`);

    const exist = await aws.fileExists(this.bucket, remotePath.replace(/^\/+/, ''));
    if (!exist) {
      const message = `Source file not found ${remoteUrl}`;
      throw new errors.FileNotFound(message);
    }
    const params = {
      Bucket: bucket,
      CopySource: remoteUrl.replace(/^s3:\//, ''),
      Key: key,
      ACL: 'private'
    };
    log.info('sync params:', params);
    const startTime = new Date();

    await aws.s3CopyObject(params);

    const syncTimeSecs = (new Date() - startTime) / 1000.0;
    log.info(`s3 Upload completed in ${syncTimeSecs} secs`, s3uri);
    const syncedBytes = await aws.getObjectSize(params.Bucket, params.Key);
    log.info(`synced ${syncedBytes} bytes`);
    return s3uri;
  }
}

module.exports = S3ProviderClient;
