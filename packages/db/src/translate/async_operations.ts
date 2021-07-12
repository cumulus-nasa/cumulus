import { toSnake } from 'snake-camel';
import { ApiAsyncOperation } from '@cumulus/types/api/async_operations';
import Logger from '@cumulus/logger';
import { PostgresAsyncOperation } from '../types/async_operation';

const log = new Logger({ sender: '@cumulus/db/translate/async-operations' });

/**
 *  Convert async operation output field to object
 * @param {string} output - Record output
 * @returns {Object}
 */
const convertOutputToObject = (output: string) => {
  let convertedOutput;
  try {
    // First case is intended for an output that is a JSON stringified object
    convertedOutput = JSON.parse(output);
    // Second case is intended for an output that is a JSON stringified string or an array
    if (typeof convertedOutput === 'string' || Array.isArray(convertedOutput)) {
      log.info(`Converting JSON string ${output} to object to conform to PostgreSQL schema`);
      convertedOutput = { output: JSON.parse(output) };
    }
  } catch (error) {
    // Third case is for an output that is a string
    log.error('Converting string to object to conform to PostgreSQL schema', error);
    convertedOutput = { output: output };
  }
  return convertedOutput;
};

/**
 * Generate a PostgreSQL Async Operation record from an API record.
 *
 * @param {Object} record - An API Async Operation record
 * @returns {Object} A PostgreSQL Async Operation record
 */
export const translateApiAsyncOperationToPostgresAsyncOperation = (
  record: ApiAsyncOperation
): PostgresAsyncOperation => {
  // fix for old implementation of async-operation output assignment
  const translatedRecord = <PostgresAsyncOperation>toSnake(record);
  if (record.output === 'none') {
    delete translatedRecord.output;
  } else if (record.output !== undefined) {
    translatedRecord.output = convertOutputToObject(record.output);
  }
  if (record.createdAt !== undefined) {
    translatedRecord.created_at = new Date(record.createdAt);
  }
  if (record.updatedAt !== undefined) {
    translatedRecord.updated_at = new Date(record.updatedAt);
  }
  return translatedRecord;
};

/**
 * Generate an API Async Operation record from a PostgreSQL record.
 *
 * @param {Object} pgAsyncOperation - A Postgres PDR record
 * @returns {Object} An Async Operation API record
 */
export const translatePostgresAsyncOperationToApiAsyncOperation = (
  pgAsyncOperation: PostgresAsyncOperation
): ApiAsyncOperation => {
  const apiAsyncOperation = {
    id: pgAsyncOperation.id,
    description: pgAsyncOperation.description,
    operationType: pgAsyncOperation.operation_type,
    status: pgAsyncOperation.status,
    output: pgAsyncOperation.output ? JSON.stringify(pgAsyncOperation.output) : undefined,
    taskArn: pgAsyncOperation.task_arn,
    createdAt: pgAsyncOperation.created_at ? pgAsyncOperation.created_at.getTime() : undefined,
    updatedAt: pgAsyncOperation.updated_at ? pgAsyncOperation.updated_at.getTime() : undefined,
  };
  return apiAsyncOperation;
};
