'use strict';

const cumulusMessageAdapter = require('@cumulus/cumulus-message-adapter-js');
const get = require('lodash/get');
const isNumber = require('lodash/isNumber');
const isString = require('lodash/isString');
const path = require('path');
const S3 = require('@cumulus/aws-client/S3');
const { buildProviderClient, fetchTextFile } = require('@cumulus/ingest/providerClientUtils');
const CollectionConfigStore = require('@cumulus/collection-config-store');
const { PDRParsingError } = require('@cumulus/errors');
const { pvlToJS } = require('@cumulus/pvl/t');

const supportedChecksumTypes = ['CKSUM', 'MD5'];

// If updating this mapping, please update the related documentation
// at docs/workflow_tasks/parse_pdr.md
const pdrToCnmMap = {
  HDF: 'data',
  'HDF-EOS': 'data',
  SCIENCE: 'data',
  BROWSE: 'browse',
  METADATA: 'metadata',
  BROWSE_METADATA: 'metadata',
  QA_METADATA: 'metadata',
  PRODHIST: 'qa',
  QA: 'metadata',
  TGZ: 'data',
  LINKAGE: 'linkage'
};

const getItem = (spec, pdrName, name, must = true) => {
  const item = spec.get(name);
  if (item) {
    return item.value;
  }

  if (must) {
    throw new PDRParsingError(name, pdrName);
  }

  return null;
};

/**
 * Validate that checksum info from the PDR includes neither or both of a type and value, and
 * that the type is a supported algorithm, and the value is a valid checksum value for the type.
 *
 * @param {string|number} checksum - checksum value
 * @param {string} checksumType - checksum type (CKSUM & MD5 supported)
 *
 * @throws {PDRParsingError} - On failing to validate checksum information.
 */
const validateChecksumInfo = (checksum, checksumType) => {
  // Make sure that both checksumType and checksum are set
  if (checksum && !checksumType) throw new PDRParsingError('MISSING FILE_CKSUM_TYPE PARAMETER');
  if (checksumType) {
    if (!checksum) throw new PDRParsingError('MISSING FILE_CKSUM_VALUE PARAMETER');

    // Make sure that the checksumType is valid
    if (!supportedChecksumTypes.includes(checksumType)) {
      throw new PDRParsingError(`UNSUPPORTED CHECKSUM TYPE: ${checksumType}`);
    }
    // Make sure that the checksum is valid
    if ((checksumType === 'CKSUM') && (!isNumber(checksum))) {
      throw new PDRParsingError(`Expected CKSUM value to be a number: ${checksum}`);
    }
    if ((checksumType === 'MD5') && (!isString(checksum))) {
      throw new PDRParsingError(`Expected MD5 value to be a string: ${checksum}`);
    }
  }
};

/**
 * Makes sure that a FILE Spec has all the required files and returns
 * the content as an object. Throws error if anything is missing
 * For more info refer to https://github.com/nasa/cumulus-api/issues/104#issuecomment-285744333
 *
 * @param {string} pdrName - the name of the PDR, used when throwing a PDRParsingError
 * @param {Object} spec - PDR spec object generated by PVL
 * @returns {Object} throws error if failed
 */
const parseSpec = (pdrName, spec) => {
  const getter = getItem.bind(null, spec, pdrName);

  // check each file_spec has DIRECTORY_ID, FILE_ID, FILE_SIZE
  const dirPath = getter('DIRECTORY_ID');
  const filename = getter('FILE_ID');
  const fileSize = getter('FILE_SIZE');
  const fileType = getter('FILE_TYPE');

  const checksumType = getter('FILE_CKSUM_TYPE', false);
  const checksum = getter('FILE_CKSUM_VALUE', false);

  // Validate fileType is in the mapping
  if (fileType) {
    if (!Object.keys(pdrToCnmMap).includes(fileType)) {
      throw new PDRParsingError(`INVALID FILE_TYPE PARAMETER : ${fileType}`);
    }
  }

  const parsedSpec = {
    path: dirPath,
    size: fileSize,
    name: filename,
    type: pdrToCnmMap[fileType]
  };

  if (checksum || checksumType) {
    validateChecksumInfo(checksum, checksumType);
    parsedSpec.checksumType = checksumType;
    parsedSpec.checksum = checksum;
  }

  return parsedSpec;
};

/**
 * Extract a granuleId from a filename
 *
 * @param {string} fileName - The filename to extract the granuleId from
 * @param {RegExp|string} regex - A regular expression describing how to extract
 *   a granuleId from a filename
 * @returns {string} the granuleId or the name of the file if no granuleId was
 *   found
 */
const extractGranuleId = (fileName, regex) => {
  const test = new RegExp(regex);
  const match = fileName.match(test);

  if (match) {
    return match[1];
  }
  return fileName;
};

/**
 * Convert PDR FILE_GROUP to granule object.
 *
 * @param {Object} fileGroup - PDR FILE_GROUP object
 * @param {string} pdrName - name of the PDR for error reporting
 * @param {Object} collectionConfigStore - collectionConfigStore
 * @returns {Object} granule object
 */
const convertFileGroupToGranule = async (fileGroup, pdrName, collectionConfigStore) => {
  if (!fileGroup.get('DATA_TYPE')) throw new PDRParsingError('DATA_TYPE is missing');
  const dataType = fileGroup.get('DATA_TYPE').value;

  if (!fileGroup.get('DATA_VERSION')) {
    throw new PDRParsingError('DATA_VERSION is missing');
  }

  const version = `${fileGroup.get('DATA_VERSION').value}`;

  // get all the file specs in each group
  const specs = fileGroup.objects('FILE_SPEC');
  if (specs.length === 0) throw new Error('No FILE_SPEC sections found.');

  const files = specs.map(parseSpec.bind(null, pdrName));

  const collectionConfig = await collectionConfigStore.get(dataType, version);

  return {
    dataType,
    version,
    files,
    granuleId: extractGranuleId(files[0].name, collectionConfig.granuleIdExtraction),
    granuleSize: files.reduce((total, file) => total + file.size, 0)
  };
};

const buildPdrDocument = (rawPdr) => {
  if (rawPdr.trim().length === 0) throw new Error('PDR file had no contents');

  const cleanedPdr = rawPdr
    .replace(/((\w*)=(\w*))/g, '$2 = $3')
    .replace(/"/g, '');

  return pvlToJS(cleanedPdr);
};

/**
* Parse a PDR
* See schemas/input.json for detailed input schema
*
* @param {Object} event - Lambda event object
* @param {Object} event.config - configuration object for the task
* @param {string} event.config.stack - the name of the deployment stack
* @param {string} event.config.pdrFolder - folder for the PDRs
* @param {Object} event.config.provider - provider information
* @param {Object} event.config.bucket - the internal S3 bucket
* @returns {Promise<Object>} - see schemas/output.json for detailed output schema
* that is passed to the next task in the workflow
**/
const parsePdr = async ({ config, input }) => {
  const providerClient = buildProviderClient(config.provider);

  const rawPdr = await fetchTextFile(
    providerClient,
    path.join(input.pdr.path, input.pdr.name)
  );

  const pdrDocument = buildPdrDocument(rawPdr);

  const collectionConfigStore = new CollectionConfigStore(config.bucket, config.stack);

  const allPdrGranules = await Promise.all(
    pdrDocument.objects('FILE_GROUP').map((fileGroup) =>
      convertFileGroupToGranule(fileGroup, input.pdr.name, collectionConfigStore))
  );

  await S3.s3PutObject({
    Bucket: config.bucket,
    Key: path.join(config.stack, 'pdrs', input.pdr.name),
    Body: rawPdr
  });

  // Filter based on the granuleIdFilter, default to match all granules
  const granuleIdFilter = get(config, 'granuleIdFilter', '.');
  const granules = allPdrGranules.filter((g) => g.files[0].name.match(granuleIdFilter));

  return {
    ...input,
    granules,
    granulesCount: granules.length,
    filesCount: granules.reduce((sum, { files }) => sum + files.length, 0),
    totalSize: granules.reduce((sum, { granuleSize }) => sum + granuleSize, 0)
  };
};

/**
 * Lambda handler
 *
 * @param {Object} event - a Cumulus Message
 * @param {Object} context - an AWS Lambda context
 * @param {Function} callback - an AWS Lambda handler
 * @returns {undefined} - does not return a value
 */
function handler(event, context, callback) {
  cumulusMessageAdapter.runCumulusTask(parsePdr, event, context, callback);
}

module.exports = { handler, parsePdr };
