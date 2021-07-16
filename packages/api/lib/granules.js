'use strict';

const isNil = require('lodash/isNil');

const awsClients = require('@cumulus/aws-client/services');
const s3Utils = require('@cumulus/aws-client/S3');
const log = require('@cumulus/common/log');

const {
  generateMoveFileParams,
  moveGranuleFile,
} = require('@cumulus/ingest/granule');

const {
  CollectionPgModel,
  FilePgModel,
  getKnexClient,
  GranulePgModel,
} = require('@cumulus/db');

const { getBucketsConfigKey } = require('@cumulus/common/stack');

const { fetchDistributionBucketMap } = require('@cumulus/distribution-utils');

const { deconstructCollectionId } = require('./utils');
const FileUtils = require('./FileUtils');

const translateGranule = async (
  granule,
  fileUtils = FileUtils
) => {
  if (isNil(granule.files)) return granule;

  return {
    ...granule,
    files: await fileUtils.buildDatabaseFiles({
      s3: awsClients.s3(),
      files: granule.files,
    }),
  };
};

const getExecutionProcessingTimeInfo = ({
  startDate,
  stopDate,
  now = new Date(),
}) => {
  const processingTimeInfo = {};
  if (startDate) {
    processingTimeInfo.processingStartDateTime = startDate.toISOString();
    processingTimeInfo.processingEndDateTime = stopDate
      ? stopDate.toISOString()
      : now.toISOString();
  }
  return processingTimeInfo;
};

const renameProperty = (from, to, obj) => {
  const newObj = { ...obj, [to]: obj[from] };
  delete newObj[from];
  return newObj;
};

/**
* Move granule 'file' S3 Objects and update Postgres/Dynamo/CMR metadata with new locations
*
* @param {Object} params                       - params object
* @param {Object} params.apiGranule            - API 'granule' object to move
* @param {Object} params.granulesModel         - DynamoDB granules model instance
* @param {Object} params.destinations          - 'Destinations' API object ()
* @param {Object} params.granulePgModel        - parameter override, used for unit testing
* @param {Object} params.collectionPgModel     - parameter override, used for unit testing
* @param {Object} params.filesPgModel          - parameter override, used for unit testing
* @param {Object} params.dbClient              - parameter override, used for unit testing
* @returns {{updatedFiles, moveGranuleErrors}} - Object containing an 'updated' files object
* with current file key values and an error object containing a set of Promise.allSettled errors
*/
async function moveGranuleFilesAndUpdateDatastore(params) {
  const {
    apiGranule,
    granulesModel,
    destinations,
    granulePgModel = new GranulePgModel(),
    collectionPgModel = new CollectionPgModel(),
    filesPgModel = new FilePgModel(),
    dbClient = await getKnexClient(),
  } = params;
  let postgresCumulusGranuleId;
  let writeToPostgres = true;

  try {
    const { name, version } = deconstructCollectionId(apiGranule.collectionId);
    postgresCumulusGranuleId = await granulePgModel.getRecordCumulusId(dbClient, {
      granule_id: apiGranule.granuleId,
      collection_cumulus_id: await collectionPgModel.getRecordCumulusId(
        dbClient,
        { name, version }
      ),
    });
  } catch (error) {
    // If the granule or associated record hasn't been migrated yet
    // run the 'original' dynamo update
    if (error.name !== 'RecordDoesNotExist') {
      throw error;
    }
    log.info(`Granule ${JSON.stringify(apiGranule)} has not been migrated yet, updating DynamoDb records only`);
    writeToPostgres = false;
  }

  const updatedFiles = [];
  const moveFileParams = generateMoveFileParams(apiGranule.files, destinations);
  const moveFilePromises = moveFileParams.map(async (moveFileParam) => {
    const { file } = moveFileParam;
    try {
      // Update the datastores, then move files
      await dbClient.transaction(async (trx) => {
        const updatedFile = await moveGranuleFile(
          moveFileParam,
          filesPgModel,
          trx,
          postgresCumulusGranuleId,
          writeToPostgres
        );
        updatedFiles.push(renameProperty('name', 'fileName', updatedFile));
      });
      // Add updated file to postgresDatabase
    } catch (error) {
      updatedFiles.push(file);
      log.error(`Failed to move file ${JSON.stringify(moveFileParam)} -- ${JSON.stringify(error.message)}`);
      error.message = `${JSON.stringify(moveFileParam)}: ${error.message}`;
      throw error;
    }
  });

  const moveResults = await Promise.allSettled(moveFilePromises);
  await granulesModel.update(
    { granuleId: apiGranule.granuleId },
    {
      files: updatedFiles,
    }
  );
  const filteredResults = moveResults.filter((r) => r.status === 'rejected');
  const moveGranuleErrors = filteredResults.map((error) => error.reason);

  return { updatedFiles, moveGranuleErrors };
}

/**
 * Move a granule's files to destinations specified
 *
 * @param {Object} apiGranule - the granule record object
 * @param {Array<{regex: string, bucket: string, filepath: string}>} destinations
 *    - list of destinations specified
 *    regex - regex for matching filepath of file to new destination
 *    bucket - aws bucket of the destination
 *    filepath - file path/directory on the bucket for the destination
 * @param {string} distEndpoint - distribution endpoint URL
 * @param {Object} granulesModel - An instance of an API Granule granulesModel
 * @returns {Promise<undefined>} undefined
 */
async function moveGranule(apiGranule, destinations, distEndpoint, granulesModel) {
  log.info(`granules.move ${apiGranule.granuleId}`);

  const bucketsConfig = await s3Utils.getJsonS3Object(
    process.env.system_bucket,
    getBucketsConfigKey(process.env.stackName)
  );

  const bucketTypes = Object.values(bucketsConfig)
    .reduce(
      (acc, { name, type }) => ({ ...acc, [name]: type }),
      {}
    );

  const distributionBucketMap = await fetchDistributionBucketMap();

  const {
    updatedFiles,
    moveGranuleErrors,
  } = await moveGranuleFilesAndUpdateDatastore({ apiGranule, granulesModel, destinations });
  await granulesModel.cmrUtils.reconcileCMRMetadata({
    granuleId: apiGranule.granuleId,
    updatedFiles,
    distEndpoint,
    published: apiGranule.published,
    distributionBucketMap,
    bucketTypes,
  });
  if (moveGranuleErrors.length > 0) {
    log.error(`Granule ${JSON.stringify(apiGranule)} failed to move.`);
    log.error(JSON.stringify(moveGranuleErrors));
    throw new Error(JSON.stringify({
      reason: 'Failed to move granule',
      granule: apiGranule,
      errors: moveGranuleErrors,
      granuleFilesRecords: updatedFiles,
    }));
  }
}

module.exports = {
  moveGranule,
  translateGranule,
  getExecutionProcessingTimeInfo,
  moveGranuleFilesAndUpdateDatastore,
};
