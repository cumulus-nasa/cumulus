'use strict';

const log = require('cumulus-common/log');
const aws = require('cumulus-common/aws');
const Task = require('cumulus-common/task');
const FtpClient = require('ftp');
const SftpClient = require('sftpjs');
const pdrMod = require('./pdr');
const pdrValid = require('./pdr-validations');

/**
 * Task that validates a PDR retrieved from a SIPS server
 * Input payload: An object containing the PDR to process
 * Output payload: An object possibly containing a `topLevelErrors` key pointing to an array
 * of error messages, a `fileGroupErrors` key pointing to an array of error messages, or
 * a list of paths to files to be downloaded. The original input pdr is included in the output
 * payload.
 */
module.exports = class ValidatePdr extends Task {
  /**
   * Main task entry point
   * @return Array An array of archive files to be processed
   */
  async run() {
    // Message payload contains the PDR
    const message = this.message;
    const { pdrFileName, pdr } = await message.payload;

    // Parse the PDR and do a preliminary validation
    let pdrObj;
    let topLevelErrors = [];
    let fileGroupErrors = [];

    try {
      pdrObj = pdrMod.parsePdr(pdr);

      // Do a top-level validation
      const errors = pdrValid.validateTopLevelPdr(pdrObj);
      topLevelErrors = topLevelErrors.concat(errors);

      // Validate each file group entry
      const fileGroups = pdrObj.objects('FILE_GROUP');
      fileGroupErrors = fileGroups.map(pdrValid.validateFileGroup);
    }
    catch (e) {
      log.error(e);
      log.error(e.stack);
      topLevelErrors.push('INVALID PVL STATEMENT');
    }

    return {
      pdrFileName: pdrFileName,
      pdr: pdr,
      topLevelErrors: topLevelErrors,
      fileGroupErrors: fileGroupErrors
    };
  }

  /**
   * Entry point for Lambda
   * @param {array} args The arguments passed by AWS Lambda
   * @return The handler return value
   */
  static handler(...args) {
    return ValidatePdr.handle(...args);
  }
};

// Test code
const local = require('cumulus-common/local-helpers');
local.setupLocalRun(module.exports.handler, () => ({
  workflow_config_template: {
    DiscoverPdr: {
      s3Bucket: '{resources.s3Bucket}',
      folder: 'PDR'
    },
    ValidatePdr: {
      s3Bucket: '{resources.s3Bucket}',

    }
  },
  resources: {
    s3Bucket: 'gitc-jn-sips-mock'
  },
  provider: {
    id: 'DUMMY',
    config: {}
  },
  meta: {},
  ingest_meta: {
    task: 'ValidatePdr',
    id: 'abc1234',
    message_source: 'stdin'
  }

}));
