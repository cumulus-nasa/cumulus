import { URL } from 'url';
import https from 'https';
import path from 'path';

import Logger from '@cumulus/logger';
import { getS3Object, s3ObjectExists } from '@cumulus/aws-client/S3';

import {
  LaunchpadTokenParams,
  GetTokenResponse,
  ValidateTokenResponse
} from './types';
import { getEnvVar } from './utils';

const log = new Logger({ sender: '@cumulus/launchpad-auth/LaunchpadToken' });

/**
 * @class
 * @classdesc A class for sending requests to Launchpad token service endpoints
 *
 * @example
 * const LaunchpadToken = require('@cumulus/launchpad-auth/LaunchpadToken');
 *
 * const launchpadToken = new LaunchpadToken({
 *  api: 'launchpad-token-api-endpoint',
 *  passphrase: 'my-pki-passphrase',
 *  certificate: 'my-pki-certificate.pfx'
 * });
 *
 * @alias LaunchpadToken
 */
class LaunchpadToken {
  private readonly api: string;
  private readonly passphrase: string;
  private readonly certificate: string;

  /**
  * @param {Object} params
  * @param {string} params.api - the Launchpad token service api endpoint
  * @param {string} params.passphrase - the passphrase of the Launchpad PKI certificate
  * @param {string} params.certificate - the name of the Launchpad PKI pfx certificate
  */
  constructor(params: LaunchpadTokenParams) {
    this.api = params.api;
    this.passphrase = params.passphrase;
    this.certificate = params.certificate;
  }

  /**
   * Retrieve Launchpad credentials
   *
   * @returns {Promise<string | undefined>} - an object with the pfx
   * @private
   */
  private async retrieveCertificate(): Promise<string | undefined> {
    const bucket = getEnvVar('system_bucket');
    const stackName = getEnvVar('stackName');

    // we are assuming that the specified certificate file is in the S3 crypto directory
    const cryptKey = `${stackName}/crypto/${this.certificate}`;

    const keyExists = await s3ObjectExists(
      { Bucket: bucket, Key: cryptKey }
    );

    if (!keyExists) {
      throw new Error(`${this.certificate} does not exist in S3 crypto directory: ${cryptKey}`);
    }

    log.debug(`Reading Key: ${this.certificate} bucket:${bucket},stack:${stackName}`);
    const pfx = (await getS3Object(bucket, `${stackName}/crypto/${this.certificate}`)).Body?.toString();

    return pfx;
  }

  /**
   * Get a token from Launchpad
   *
   * @returns {Promise<Object>} - the Launchpad gettoken response object
   */
  async requestToken(): Promise<GetTokenResponse> {
    log.debug('LaunchpadToken.requestToken');
    const pfx = await this.retrieveCertificate();
    const launchpadUrl = new URL(this.api);

    const options = {
      hostname: launchpadUrl.hostname,
      port: launchpadUrl.port || 443,
      path: path.join(launchpadUrl.pathname, 'gettoken'),
      method: 'GET',
      pfx,
      passphrase: this.passphrase
    };

    const responseBody = await this.submitRequest(options);
    return <GetTokenResponse>JSON.parse(responseBody);
  }

  /**
   * Validate a Launchpad token
   *
   * @param {string} token - the Launchpad token for validation
   * @returns {Promise<Object>} - the Launchpad validate token response object
   */
  async validateToken(token: string): Promise<ValidateTokenResponse> {
    log.debug('LaunchpadToken.validateToken');
    const pfx = await this.retrieveCertificate();
    const launchpadUrl = new URL(this.api);

    const data = JSON.stringify({ token });
    const options = {
      hostname: launchpadUrl.hostname,
      port: launchpadUrl.port || 443,
      path: path.join(launchpadUrl.pathname, 'validate'),
      method: 'POST',
      pfx,
      passphrase: this.passphrase,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    // const response = await got.post('validate', options).json();
    // return <ValidateTokenResponse>response;
    const responseBody = await this.submitRequest(options, data);
    return <ValidateTokenResponse>JSON.parse(responseBody);
  }

  /**
   * Submit HTTPS request
   *
   * @param {Object} options - the Launchpad token for validation
   * @param {string} data - the request body
   * @returns {Promise<string>} - the response body
   * @private
   */
  private submitRequest(options: object, data?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let responseBody = '';

      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`launchpad request failed with statusCode ${res.statusCode} ${res.statusMessage}`));
        }

        res.on('data', (d) => {
          responseBody += d;
        });

        res.on('end', () => resolve(responseBody));
      });

      req.on('error', (e) => reject(e));

      if (data) req.write(data);
      req.end();
    });
  }
}

export = LaunchpadToken;
