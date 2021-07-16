'use strict';

const get = require('lodash/get');
const isEmpty = require('lodash/isEmpty');
const isNil = require('lodash/isNil');
const pRetry = require('p-retry');
const { render } = require('nunjucks');
const { resolve: pathresolve } = require('path');
const urljoin = require('url-join');

const { buildS3Uri, s3PutObject } = require('@cumulus/aws-client/S3');
const log = require('@cumulus/common/log');
const { removeNilProperties } = require('@cumulus/common/util');
const { RecordDoesNotExist } = require('@cumulus/errors');
const { inTestMode } = require('@cumulus/common/test-utils');
const { objectStoreForProtocol } = require('@cumulus/object-store');

const { buildLoginErrorTemplateVars, getConfigurations, useSecureCookies } = require('../lib/distribution');
const {
  getBucketMap,
  getPathsByBucketName,
  getPathsByPrefixedBucketName,
  processFileRequestPath,
  checkPrivateBucket,
} = require('../lib/bucketMapUtils');

const templatesDirectory = (inTestMode())
  ? pathresolve(__dirname, '../app/data/distribution/templates')
  : pathresolve(__dirname, 'templates');

/**
 * Sends a welcome page
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 */
async function handleRootRequest(req, res) {
  const {
    accessTokenModel,
    oauthClient,
    distributionUrl,
  } = await getConfigurations();
  const accessToken = req.cookies.accessToken;
  let accessTokenRecord;
  if (accessToken) {
    try {
      accessTokenRecord = await accessTokenModel.get({ accessToken });
    } catch (error) {
      if ((error instanceof RecordDoesNotExist) === false) {
        throw error;
      }
    }
  }

  // req.apiGateway is not available for unit test
  const requestid = get(req, 'apiGateway.context.awsRequestId');
  const templateVars = {
    title: 'Welcome',
    profile: accessTokenRecord && accessTokenRecord.tokenInfo,
    logoutURL: urljoin(distributionUrl, 'logout'),
    requestid,
  };

  if (!accessToken || !accessTokenRecord) {
    const authorizeUrl = oauthClient.getAuthorizationUrl(req.path);
    templateVars.URL = authorizeUrl;
  }

  const rendered = render(pathresolve(templatesDirectory, 'root.html'), templateVars);
  return res.send(rendered);
}

/**
 * Responds to a login/redirect request
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} - promise of an express response object
 */
async function handleLoginRequest(req, res) {
  const {
    accessTokenModel,
    oauthClient,
    distributionUrl,
  } = await getConfigurations();

  const { code, state } = req.query;
  const errorTemplate = pathresolve(templatesDirectory, 'error.html');
  const requestid = get(req, 'apiGateway.context.awsRequestId');
  log.debug('the query params:', req.query);
  const templateVars = buildLoginErrorTemplateVars(req.query);
  if (!isEmpty(templateVars) && templateVars.statusCode >= 400) {
    templateVars.requestid = requestid;
    const rendered = render(errorTemplate, templateVars);
    return res.status(templateVars.statusCode).send(rendered);
  }

  try {
    log.debug('pre getAccessToken() with query params:', req.query);
    const accessTokenResponse = await oauthClient.getAccessToken(code);

    // getAccessToken returns username only for EDL
    const params = {
      token: accessTokenResponse.accessToken,
      username: accessTokenResponse.username,
      xRequestId: requestid,
    };
    const userInfo = await oauthClient.getUserInfo(removeNilProperties(params));
    log.debug('getUserInfo:', userInfo);

    await accessTokenModel.create({
      accessToken: accessTokenResponse.accessToken,
      expirationTime: accessTokenResponse.expirationTime,
      refreshToken: accessTokenResponse.refreshToken,
      username: accessTokenResponse.username || userInfo.username,
      tokenInfo: userInfo,
    });

    return res
      .cookie(
        'accessToken',
        accessTokenResponse.accessToken,
        {
          // expirationTime is in seconds but Date() expects milliseconds
          expires: new Date(accessTokenResponse.expirationTime * 1000),
          httpOnly: true,
          secure: useSecureCookies(),
        }
      )
      .status(301)
      .set({ Location: urljoin(distributionUrl, state || '') })
      .send('Redirecting');
  } catch (error) {
    log.error('Error occurred while trying to login:', error);
    const vars = {
      contentstring: `There was a problem talking to OAuth provider, ${error.message}`,
      title: 'Could Not Login',
      statusCode: 401,
      requestid,
    };
    const rendered = render(errorTemplate, vars);
    return res.status(401).send(rendered);
  }
}

/**
 * Responds to a logout request
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} - promise of an express response object
 */
async function handleLogoutRequest(req, res) {
  const {
    accessTokenModel,
    oauthClient,
    distributionUrl,
  } = await getConfigurations();
  const accessToken = req.cookies.accessToken;
  const authorizeUrl = oauthClient.getAuthorizationUrl();
  const requestid = get(req, 'apiGateway.context.awsRequestId');
  await accessTokenModel.delete({ accessToken });
  const templateVars = {
    title: 'Logged Out',
    contentstring: accessToken ? 'You are logged out.' : 'No active login found.',
    URL: authorizeUrl,
    logoutURL: urljoin(distributionUrl, 'logout'),
    requestid,
  };

  const rendered = render(pathresolve(templatesDirectory, 'root.html'), templateVars);
  return res.send(rendered);
}

/**
 * Responds to a locate bucket request
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} - promise of an express response object
 */
async function handleLocateBucketRequest(req, res) {
  const { bucket_name: bucket } = req.query;
  if (bucket === undefined) {
    return res
      .set({ 'Content-Type': 'text/plain' })
      .status(400)
      .send('Required "bucket_name" query paramater not specified');
  }

  const bucketMap = await getBucketMap();
  const matchingPaths = getPathsByBucketName(bucketMap, bucket);
  if (matchingPaths.length === 0) {
    log.debug(`No route defined for ${bucket}`);
    return res
      .set({ 'Content-Type': 'text/plain' })
      .status(404)
      .send(`No route defined for ${bucket}`);
  }

  return res.status(200).json(matchingPaths);
}

/**
 * Responds to a file request
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function handleFileRequest(req, res) {
  const errorTemplate = pathresolve(templatesDirectory, 'error.html');
  const requestid = get(req, 'apiGateway.context.awsRequestId');
  const bucketMap = await getBucketMap();
  const { bucket, key, headers } = processFileRequestPath(req.params[0], bucketMap);
  if (bucket === undefined) {
    const error = `Unable to locate bucket from bucket map for ${req.params[0]}`;
    return res.boom.notFound(error);
  }

  // check private buckets' user groups for earthdata only
  if (process.env.OAUTH_PROVIDER === 'earthdata') {
    const allowedUserGroups = checkPrivateBucket(bucketMap, bucket, key);
    log.debug(`checkPrivateBucket for ${bucket} ${key} returns: ${allowedUserGroups && allowedUserGroups.join(',')}`);
    const allowed = isNil(allowedUserGroups)
      || (req.authorizedMetadata.userGroups || [])
        .some((group) => allowedUserGroups.includes(group));
    if (!allowed) {
      const statusCode = 403;
      const vars = {
        contentstring: 'This data is not currently available.',
        title: 'Could not access data',
        statusCode,
        requestid,
      };
      const rendered = render(errorTemplate, vars);
      return res.status(statusCode).send(rendered);
    }
  }

  let signedS3Url;
  const url = buildS3Uri(bucket, key);
  const objectStore = objectStoreForProtocol('s3');
  const range = req.get('Range');

  // Read custom headers from bucket_map.yaml
  log.debug(`Bucket map headers for ${bucket}/${key}: ${JSON.stringify(headers)}`);

  const options = {
    ...range ? { Range: range } : {},
  };
  const queryParams = { 'A-userid': req.authorizedMetadata.userName };

  try {
    switch (req.method) {
    case 'GET':
      options.ResponseCacheControl = 'private, max-age=600';
      signedS3Url = await objectStore.signGetObject(url, options, queryParams);
      break;
    case 'HEAD':
      signedS3Url = await objectStore.signHeadObject(url, options, queryParams);
      break;
    default:
      break;
    }
  } catch (error) {
    log.error('Error occurred when signing URL:', error);
    let vars = {};
    let statusCode;
    if (error.name.toLowerCase() === 'forbidden') {
      statusCode = 403;
      vars = {
        contentstring: `Cannot access requested bucket: ${error.message}`,
        title: 'Forbidden',
        statusCode,
        requestid,
      };
    } else {
      statusCode = 404;
      vars = {
        contentstring: `Could not find file, ${error.message}`,
        title: 'File not found',
        statusCode,
        requestid,
      };
    }

    const rendered = render(errorTemplate, vars);
    return res.status(statusCode).send(rendered);
  }
  return res
    .status(307)
    .set({ Location: signedS3Url })
    .set({ ...headers })
    .send('Redirecting');
}

/**
 * Takes a bucketlist and a bucket/key event, gets the mapping path for each bucket from bucket map,
 * and writes a bucket mapping object to S3.   Returns the bucket map object.
 *
 * @param {Object} event              - Event containing
 * @param {string[]} event.bucketList - An array of buckets to cache values for
 * @param {string} event.s3Bucket     - Bucket to write .json map cache file to
 * @param {string} event.s3Key        - Key to write .json map cache file to
 * @returns {Promise<Object>}         - A bucketmap object {bucket1: mapping1, bucket2: mapping2}
 */
async function writeBucketMapCacheToS3({
  bucketList,
  s3Bucket,
  s3Key,
}) {
  if (!bucketList || !s3Bucket || !s3Key) {
    throw new Error('A bucketlist and s3 bucket/key must be provided in the event');
  }

  const bucketMap = await getBucketMap();

  const bucketMapObjects = bucketList.map((bucket) => {
    const bucketMapList = getPathsByPrefixedBucketName(bucketMap, bucket);
    if (bucketMapList.length > 1) {
      throw new pRetry.AbortError(`BucketMap configured with multiple responses from ${bucket},
      this package cannot resolve a distirbution URL as configured for this bucket`);
    }
    if (bucketMapList.length === 0) {
      throw new pRetry.AbortError(`No bucket mapping found for ${bucket}`);
    }
    return { [bucket]: bucketMapList[0] };
  });

  const bucketMapCache = bucketMapObjects.reduce((map, obj) => Object.assign(map, obj), {});

  await s3PutObject({
    Bucket: s3Bucket,
    Key: s3Key,
    Body: JSON.stringify(bucketMapCache),
  });

  log.info(`Wrote bucketmap ${JSON.stringify(bucketMapCache)} to ${s3Bucket}/${s3Key}`);
  return bucketMapCache;
}

module.exports = {
  writeBucketMapCacheToS3,
  handleLocateBucketRequest,
  handleLoginRequest,
  handleLogoutRequest,
  handleRootRequest,
  handleFileRequest,
};
