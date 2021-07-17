import { NewCollectionRecord, CollectionRecord } from '@cumulus/types/api/collections';
import { PostgresCollection, PostgresCollectionRecord } from '../types/collection';
const { removeNilProperties } = require('@cumulus/common/util');

/**
* Translates a PostgresCollectionRecord object to a `CollectionRecord` API collection object
* @param {PostgresCollectionRecord} collectionRecord - PostgreSQL collection record to translate
* @returns {CollectionRecord} - Translated record
*/
export const translatePostgresCollectionToApiCollection = (
  collectionRecord: PostgresCollectionRecord
): CollectionRecord => removeNilProperties(({
  createdAt: collectionRecord.created_at.getTime(),
  updatedAt: collectionRecord.updated_at.getTime(),
  name: collectionRecord.name,
  version: collectionRecord.version,
  process: collectionRecord.process,
  url_path: collectionRecord.url_path,
  duplicateHandling: collectionRecord.duplicate_handling,
  granuleId: collectionRecord.granule_id_validation_regex,
  granuleIdExtraction: collectionRecord.granule_id_extraction_regex,
  files: collectionRecord.files,
  reportToEms: collectionRecord.report_to_ems,
  sampleFileName: collectionRecord.sample_file_name,
  ignoreFilesConfigForDiscovery: collectionRecord.ignore_files_config_for_discovery,
  meta: collectionRecord.meta,
  tags: collectionRecord.tags,
}));

/**
* Translates a NewCollectionRecord API collection object to a `PostgresCollectionRecord` object
* @param {NewCollectionRecord} record - API collection record to translate
* @returns {PostgresCollectionRecord} - Translated record
*/
export const translateApiCollectionToPostgresCollection = (
  record: NewCollectionRecord
): PostgresCollection => {
  // Map old record to new schema.
  const translatedRecord: PostgresCollection = {
    name: record.name,
    version: record.version,
    process: record.process,
    url_path: record.url_path,
    duplicate_handling: record.duplicateHandling,
    granule_id_validation_regex: record.granuleId,
    granule_id_extraction_regex: record.granuleIdExtraction,
    // have to stringify on an array of values
    files: (JSON.stringify(record.files)),
    report_to_ems: record.reportToEms,
    sample_file_name: record.sampleFileName,
    ignore_files_config_for_discovery: record.ignoreFilesConfigForDiscovery,
    meta: record.meta,
    // have to stringify on an array of values
    tags: (record.tags ? JSON.stringify(record.tags) : undefined),
  };
  if (record.createdAt !== undefined) {
    translatedRecord.created_at = new Date(record.createdAt);
  }
  if (record.updatedAt !== undefined) {
    translatedRecord.updated_at = new Date(record.updatedAt);
  }
  return translatedRecord;
};
