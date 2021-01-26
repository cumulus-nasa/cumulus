import Knex from 'knex';

import DynamoDbSearchQueue from '@cumulus/aws-client/DynamoDbSearchQueue';
import { ApiFile } from '@cumulus/types/api/files';
import {
  CollectionPgModel,
  GranulePgModel,
  PostgresFile,
  PostgresGranuleRecord,
  tableNames,
  translateApiGranuleToPostgresGranule,
} from '@cumulus/db';
import { envUtils } from '@cumulus/common';
import Logger from '@cumulus/logger';

import { RecordAlreadyMigrated } from '@cumulus/errors';
import { MigrationSummary } from './types';

const logger = new Logger({ sender: '@cumulus/data-migration/granules' });
const Manager = require('@cumulus/api/models/base');
const schemas = require('@cumulus/api/models/schemas');
const { getBucket, getKey } = require('@cumulus/api/lib/FileUtils');
const { deconstructCollectionId } = require('@cumulus/api/lib/utils');

export interface GranulesAndFilesMigrationSummary {
  granulesSummary: MigrationSummary,
  filesSummary: MigrationSummary,
}

/**
 * Migrate granules record from Dynamo to RDS.
 *
 * @param {AWS.DynamoDB.DocumentClient.AttributeMap} record
 *   Record from DynamoDB
 * @param {Knex} knex - Knex client for writing to RDS database
 * @returns {Promise<void>}
 * @throws {RecordAlreadyMigrated} if record was already migrated
 */
export const migrateGranuleRecord = async (
  record: AWS.DynamoDB.DocumentClient.AttributeMap,
  knex: Knex
): Promise<void> => {
  // Validate record before processing using API model schema
  Manager.recordIsValid(record, schemas.granule);
  const { name, version } = deconstructCollectionId(record.collectionId);
  const collectionPgModel = new CollectionPgModel();

  const collectionCumulusId = await collectionPgModel.getRecordCumulusId(
    knex,
    { name, version }
  );

  const existingRecord = await knex<PostgresGranuleRecord>('granules')
    .where({ granule_id: record.granuleId, collection_cumulus_id: collectionCumulusId })
    .first();

  // Throw error if it was already migrated.
  if (existingRecord) {
    throw new RecordAlreadyMigrated(`Granule ${record.granuleId} was already migrated, skipping`);
  }

  const granule = await translateApiGranuleToPostgresGranule(record, knex, collectionCumulusId);
  await knex(tableNames.granules).insert(granule);
};

/**
 * Migrate File record from a Granules record from DynamoDB  to RDS.
 *
 * @param {ApiFile} file - Granule file
 * @param {string} granuleId - ID of granule
 * @param {string} collectionId - ID of collection
 * @param {Knex} knex - Knex client for writing to RDS database
 * @returns {Promise<number>} - Cumulus ID for record
 * @throws {RecordAlreadyMigrated} if record was already migrated
 */
export const migrateFileRecord = async (
  file: ApiFile,
  granuleId: string,
  collectionId: string,
  knex: Knex
): Promise<void> => {
  const [name, version] = collectionId.split('___');
  const collectionPgModel = new CollectionPgModel();
  const granulePgModel = new GranulePgModel();

  const collectionCumulusId = await collectionPgModel.getRecordCumulusId(
    knex,
    { name, version }
  );

  const granuleCumulusId = await granulePgModel.getRecordCumulusId(
    knex,
    { granule_id: granuleId, collection_cumulus_id: collectionCumulusId }
  );

  const bucket = getBucket(file);
  const key = getKey(file);

  // Map old record to new schema.
  const updatedRecord: PostgresFile = {
    bucket,
    key,
    granule_cumulus_id: granuleCumulusId,
    file_size: file.size,
    checksum_value: file.checksum,
    checksum_type: file.checksumType,
    file_name: file.fileName,
    source: file.source,
    path: file.path,
  };
  await knex(tableNames.files).insert(updatedRecord);
};

/**
 * Migrate granule and files from DynamoDB to RDS
 * @param {AWS.DynamoDB.DocumentClient.AttributeMap} dynamoRecord
 * @param {Knex} knex
 * @returns {Promise<MigrationSummary>} - Migration summary for files
 */
export const migrateGranuleAndFilesViaTransaction = async (
  dynamoRecord: AWS.DynamoDB.DocumentClient.AttributeMap,
  knex: Knex
): Promise<MigrationSummary> => {
  const fileMigrationSummary = {
    dynamoRecords: 0,
    success: 0,
    failed: 0,
    skipped: 0,
  };

  // Validate record before processing using API model schema
  Manager.recordIsValid(dynamoRecord, schemas.granule);
  const files = dynamoRecord.files;
  const granuleId = dynamoRecord.granuleId;
  const collectionId = dynamoRecord.collectionId;

  await knex.transaction(async () => {
    await migrateGranuleRecord(dynamoRecord, knex);
    await Promise.all(files.map(async (file : ApiFile) => {
      fileMigrationSummary.dynamoRecords += 1;
      try {
        await migrateFileRecord(file, granuleId, collectionId, knex);
        fileMigrationSummary.success += 1;
      } catch (error) {
        fileMigrationSummary.failed += 1;
        logger.error(
          `Could not create file record in RDS for file ${file}`,
          error
        );
      }
    }));
  });

  return fileMigrationSummary;
};

export const migrateGranulesAndFiles = async (
  env: NodeJS.ProcessEnv,
  knex: Knex
): Promise<GranulesAndFilesMigrationSummary> => {
  const granulesTable = envUtils.getRequiredEnvVar('GranulesTable', env);

  const searchQueue = new DynamoDbSearchQueue({
    TableName: granulesTable,
  });

  const granuleMigrationSummary = {
    dynamoRecords: 0,
    success: 0,
    failed: 0,
    skipped: 0,
  };

  const fileMigrationSummary = {
    dynamoRecords: 0,
    success: 0,
    failed: 0,
    skipped: 0,
  };

  let record = await searchQueue.peek();

  /* eslint-disable no-await-in-loop */
  while (record) {
    granuleMigrationSummary.dynamoRecords += 1;
    try {
      const granuleFileMigrationSummary = await migrateGranuleAndFilesViaTransaction(record, knex);
      granuleMigrationSummary.success += 1;
      fileMigrationSummary.dynamoRecords += granuleFileMigrationSummary.dynamoRecords;
      fileMigrationSummary.success += granuleFileMigrationSummary.success;
      fileMigrationSummary.failed += granuleFileMigrationSummary.failed;
    } catch (error) {
      if (error instanceof RecordAlreadyMigrated) {
        granuleMigrationSummary.skipped += 1;
        logger.info(error);
      } else {
        granuleMigrationSummary.failed += 1;
        logger.error(
          `Could not create granule record and file records in RDS for DynamoDB Granule granuleId: ${record.granuleId} with files ${record.files}`,
          error
        );
      }
    }

    await searchQueue.shift();
    record = await searchQueue.peek();
  }
  /* eslint-enable no-await-in-loop */
  logger.info(`Successfully migrated ${granuleMigrationSummary.success} granule records.`);
  logger.info(`Successfully migrated ${fileMigrationSummary.success} file records.`);
  return { granulesSummary: granuleMigrationSummary, filesSummary: fileMigrationSummary };
};
