import * as querystring from 'querystring';
import { URL } from 'url';
import { s3 } from './services';
import { headObject, parseS3Uri } from './S3';

// Code modified from https://github.com/nasa/harmony/blob/main/app/util/object-store.ts

/**
 * Class to use when interacting with S3
 *
 */
class S3ObjectStore {
  private readonly s3: AWS.S3;

  constructor() {
    this.s3 = s3();
  }

  /**
   * Returns an HTTPS URL that can be used to perform a GET on the given object
   * store URL
   *
   * @param {string} objectUrl - the URL of the object to sign
   * @param {string} [options] - options to pass to S3.getObject
   * @param {string} [queryParams] - a mapping of parameter key/values to put in the URL
   * @returns {Promise<string>} a signed URL
   * @throws TypeError - if the URL is not a recognized protocol or cannot be parsed
   */
  async signGetObject(
    objectUrl: string,
    options: { [key: string]: string } = {},
    queryParams: { [key: string]: string }
  ): Promise<string> {
    const url = new URL(objectUrl);
    if (url.protocol.toLowerCase() !== 's3:') {
      throw new TypeError(`Invalid S3 URL: ${objectUrl}`);
    }

    const { Bucket, Key } = parseS3Uri(objectUrl);

    // Verifies that the object exists, or throws NotFound
    await headObject(Bucket, Key);

    const req = this.s3.getObject({ Bucket, Key, ...options });

    if (queryParams && req.on) {
      (req.on('build', () => { req.httpRequest.path += `${options ? '' : '?'}${querystring.stringify(queryParams)}`; }));
    }

    // TypeScript doesn't recognize that req has a presign method.  It does.
    const result = await (req as any).presign();
    return result;
  }

  /**
   * Returns an HTTPS URL that can be used to perform a HEAD on the given object
   * store URL
   *
   * @param {string} objectUrl - the URL of the object to sign
   * @param {string} [options] - options to pass to S3.getObject
   * @param {string} [queryParams] - a mapping of parameter key/values to put in the URL
   * @returns {Promise<string>} a signed URL
   * @throws TypeError - if the URL is not a recognized protocol or cannot be parsed
   */
  async signHeadObject(
    objectUrl: string,
    options: { [key: string]: string } = {}
  ): Promise<string> {

    const url = new URL(objectUrl);

    if (url.protocol.toLowerCase() !== 's3:') {
      throw new TypeError(`Invalid S3 URL: ${objectUrl}`);
    }

    const { Bucket, Key } = parseS3Uri(objectUrl);

    let presignedS3Url = s3().getSignedUrl('headObject', {
      Bucket, Key, ...options
    });

    return presignedS3Url;
  }
}

export = S3ObjectStore;
