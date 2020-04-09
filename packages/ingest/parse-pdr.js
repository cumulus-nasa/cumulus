/**
 * This module includes tools for validating PDRs
 * and generating PDRD and PAN messages
 */

'use strict';

const isNumber = require('lodash/isNumber');
const isString = require('lodash/isString');
const { PDRParsingError } = require('@cumulus/errors');

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

function getItem(spec, pdrName, name, must = true) {
  const item = spec.get(name);
  if (item) {
    return item.value;
  }

  if (must) {
    throw new PDRParsingError(name, pdrName);
  }

  return null;
}

/**
 * Validate that checksum info from the PDR includes neither or both of a type and value, and
 * that the type is a supported algorithm, and the value is a valid checksum value for the type.
 *
 * @param {string|number} checksum - checksum value
 * @param {string} checksumType - checksum type (CKSUM & MD5 supported)
 *
 * @throws {PDRParsingError} - On failing to validate checksum information.
 */
function validateChecksumInfo(checksum, checksumType) {
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
}

/**
 * Makes sure that a FILE Spec has all the required files and returns
 * the content as an object. Throws error if anything is missing
 * For more info refer to https://github.com/nasa/cumulus-api/issues/104#issuecomment-285744333
 *
 * @param {string} pdrName - the name of the PDR, used when throwing a PDRParsingError
 * @param {Object} spec - PDR spec object generated by PVL
 * @returns {Object} throws error if failed
 */
function parseSpec(pdrName, spec) {
  const get = getItem.bind(null, spec, pdrName);

  // check each file_spec has DIRECTORY_ID, FILE_ID, FILE_SIZE
  const path = get('DIRECTORY_ID');
  const filename = get('FILE_ID');
  const fileSize = get('FILE_SIZE');
  const fileType = get('FILE_TYPE');

  const checksumType = get('FILE_CKSUM_TYPE', false);
  const checksum = get('FILE_CKSUM_VALUE', false);

  // Validate fileType is in the mapping
  if (fileType) {
    if (!Object.keys(pdrToCnmMap).includes(fileType)) {
      throw new PDRParsingError(`INVALID FILE_TYPE PARAMETER : ${fileType}`);
    }
  }

  const parsedSpec = {
    path,
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
}
module.exports.parseSpec = parseSpec;

/**
 * Extract a granuleId from a filename
 *
 * @param {string} fileName - The filename to extract the granuleId from
 * @param {RegExp|string} regex - A regular expression describing how to extract
 *   a granuleId from a filename
 * @returns {string} the granuleId or the name of the file if no granuleId was
 *   found
 */
function extractGranuleId(fileName, regex) {
  const test = new RegExp(regex);
  const match = fileName.match(test);

  if (match) {
    return match[1];
  }
  return fileName;
}

// FIXME Figure out what this function does and document it
async function granuleFromFileGroup(fileGroup, pdrName, collectionConfigStore) {
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
}
exports.granuleFromFileGroup = granuleFromFileGroup;
