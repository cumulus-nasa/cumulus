'use strict';

const log = require('@cumulus/common/log');
const aws = require('@cumulus/common/aws');
const Task = require('@cumulus/common/task');
const validations = require('./archive-validations');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const tarGz = require('targz');
const promisify = require('util.promisify');

// Promisify function to avoid using callbacks
const decompress = promisify(tarGz.decompress);

/**
 *
 * @param {Array} unarchivedFiles An array of files that were unarchived
 *  @param {string} archiveDirPath The path where the files were extracted
 * @param {Object} fileAttrs An object that contains attributes about the archive file
 */
const uploadArchiveFilesToS3 = async (unarchivedFiles, archiveDirPath, fileAttrs) => {
  const fullFilePaths = unarchivedFiles.map(fileName => path.join(archiveDirPath, fileName));
  const s3DirKey = fileAttrs.target.key.substr(0, fileAttrs.target.key.length - 4);
  aws.uploadS3Files(fullFilePaths, fileAttrs.target.bucket, s3DirKey);
};

/**
 * Extracts a .tgz file
 * @param {string} tmpDir The path to the directory where the file should be extracted
 * @param {string} archiveFilePath The path to the file to be extracted
 * @return {string} The path to the the directory below `tmpDir` where the files are extracted
 * Throws an exception if there is an error decompressing or un-tarring the file
 */
const extractArchive = async (tmpDir, archiveFilePath) => {
  // archiveDirPath is the directory to which the files are extracted, which is
  // just the archive file path minus the extension, e.g., '.tgz'
  const archiveDirPath = archiveFilePath.substr(0, archiveFilePath.length - 4);
  // fs.mkdirSync(archiveDirPath);
  log.debug(`DECOMPRESSING ${archiveFilePath}`);
  await decompress({ dest: tmpDir, src: archiveFilePath });

  return archiveDirPath;
};

/**
 * Task that validates the archive files retrieved from a SIPS server
 * Input payload: An array of objects describing the downloaded archive files
 * Output payload: An object possibly containing an `errors` key pointing to an array
 * of error or success messages. A side-effect of this function is that the
 * archive files will be expanded on S3.
 */
module.exports = class ValidateArchives extends Task {
  /**
   * Main task entry point
   * @return {Array} An array of strings, either error messages or 'SUCCESSFUL'
   */
  async run() {
    const message = this.message;
    const payload = await message.payload;
    const files = payload.files;
    const pdrFileName = payload.pdr_file_name;

    // Create a directory for the files to be downloaded
    const tmpDir = '/tmp/archives';
    fs.mkdirSync(tmpDir);

    // Only files that were successfully downloaded by the provider gateway will be processed
    const archiveFiles = files
      .filter(file => file.success)
      .map(file => [file.target.bucket, file.target.key]);

    const downloadRequest = archiveFiles.map(([s3Bucket, s3Key]) => ({
      Bucket: s3Bucket,
      Key: s3Key
    }));

    try {
      // Download the archive files to the local file system
      await aws.downloadS3Files(downloadRequest, tmpDir);

      const downloadedFiles = fs.readdirSync(tmpDir);
      log.debug(`FILES: ${JSON.stringify(downloadedFiles)}`);

      // Compute the dispositions (status) for each file downloaded successfully by
      // the provider gateway
      const dispositionPromises = files.map(async fileAttrs => {
        // Only process archives that were downloaded successfully by the provider gateway
        if (fileAttrs.success) {
          const archiveFileName = path.basename(fileAttrs.target.key);
          const archiveFilePath = path.join(tmpDir, archiveFileName);
          const returnValue = Object.assign({}, fileAttrs, { success: false });

          // Validate checksum
          const cksumError = await validations.validateChecksum(fileAttrs, archiveFilePath);
          if (cksumError) {
            return Object.assign(returnValue, { error: cksumError });
          }

          // Extract archive
          let archiveDirPath;
          try {
            archiveDirPath = await extractArchive(tmpDir, archiveFilePath);
          }
          catch (e) {
            log.error(e);
            return Object.assign(returnValue, { error: 'FILE I/O ERROR' });
          }

          try {
            // Verify that all the files are present
            let unarchivedFiles;
            try {
              unarchivedFiles = validations.validateArchiveContents(archiveDirPath);
            }
            catch (e) {
              log.error(e);
              return Object.assign(returnValue, { error: e.message });
            }

            // TODO Check for un-parsable metadata file

            // Upload expanded files to S3
            await uploadArchiveFilesToS3(unarchivedFiles, archiveDirPath, fileAttrs);

            // Delete the archive files from S3
            await aws.deleteS3Files(downloadRequest);
          }
          catch (e) {
            log.error(e);
            return Object.assign(returnValue, { error: 'ECS INTERNAL ERROR' });
          }

          return fileAttrs;
        }

        // File was not downloaded successfully by provider gateway so just pass along its status
        return fileAttrs;
      });

      // Have to wait here or the directory holding the archives might get deleted before
      // we are done (see finally block below)
      const dispositions = await Promise.all(dispositionPromises);
      return { pdr_file_name: pdrFileName, files: dispositions };
    }
    finally {
      execSync(`rm -rf ${tmpDir}`);
    }
  }

  /**
   * Entry point for Lambda
   * @param {array} args The arguments passed by AWS Lambda
   * @return The handler return value
   */
  static handler(...args) {
    return ValidateArchives.handle(...args);
  }
};
