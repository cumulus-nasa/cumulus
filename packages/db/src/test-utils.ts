import Knex from 'knex';
import cryptoRandomString from 'crypto-random-string';
import { v4 as uuidv4 } from 'uuid';

import { getKnexClient } from './connection';
import { localStackConnectionEnv } from './config';

import { PostgresAsyncOperation } from './types/async_operation';
import { PostgresCollection } from './types/collection';
import { PostgresExecution } from './types/execution';
import { PostgresFile } from './types/file';
import { PostgresGranule } from './types/granule';
import { PostgresPdr } from './types/pdr';
import { PostgresProvider } from './types/provider';
import { PostgresRule } from './types/rule';

export const createTestDatabase = async (knex: Knex, dbName: string, dbUser: string) => {
  await knex.raw(`create database "${dbName}";`);
  await knex.raw(`grant all privileges on database "${dbName}" to "${dbUser}"`);
};

export const deleteTestDatabase = async (knex: Knex, dbName: string) =>
  await knex.raw(`drop database if exists "${dbName}"`);

export const generateLocalTestDb = async (
  testDbName: string,
  migrationDir: string,
  envParams: object
) => {
  const knexAdmin = await getKnexClient({ env: localStackConnectionEnv });
  const knex = await getKnexClient({
    env: {
      ...envParams,
      ...localStackConnectionEnv,
      PG_DATABASE: testDbName,
      migrationDir,
    },
  });
  await createTestDatabase(knexAdmin, testDbName, localStackConnectionEnv.PG_USER);
  await knex.migrate.latest();
  return ({ knex, knexAdmin });
};

export const destroyLocalTestDb = async ({
  knex, knexAdmin, testDbName,
}: {
  knex: Knex,
  knexAdmin: Knex,
  testDbName: string
}) => {
  knex.destroy();
  await deleteTestDatabase(knexAdmin, testDbName);
  knexAdmin.destroy();
};

export const fakeRuleRecordFactory = (
  params: Partial<PostgresRule>
): PostgresRule => ({
  name: cryptoRandomString({ length: 8 }),
  workflow: 'Random Workflow',
  type: 'onetime',
  enabled: false,
  created_at: new Date(),
  updated_at: new Date(),
  ...params,
});

export const fakeCollectionRecordFactory = (
  params: Partial<PostgresCollection>
): PostgresCollection => ({
  name: cryptoRandomString({ length: 5 }),
  version: '0.0.0',
  sample_file_name: 'file.txt',
  granule_id_extraction_regex: 'fake-regex',
  granule_id_validation_regex: 'fake-regex',
  files: JSON.stringify([{
    regex: 'fake-regex',
    sampleFileName: 'file.txt',
  }]),
  meta: { foo: 'bar' },
  ...params,
});

export const fakeExecutionRecordFactory = (
  params: Partial<PostgresExecution>
): PostgresExecution => ({
  arn: cryptoRandomString({ length: 10 }),
  status: 'running',
  created_at: new Date(),
  updated_at: new Date(),
  timestamp: new Date(),
  ...params,
});

export const fakeProviderRecordFactory = (
  params: Partial<PostgresProvider>
): PostgresProvider => ({
  name: `provider${cryptoRandomString({ length: 5 })}`,
  host: 'test-bucket',
  protocol: 's3',
  ...params,
});

export const fakeGranuleRecordFactory = (
  params: Partial<PostgresGranule>
): Partial<PostgresGranule> => ({
  granule_id: cryptoRandomString({ length: 5 }),
  status: 'completed',
  created_at: new Date(),
  ...params,
});

export const fakeFileRecordFactory = (
  params: Partial<PostgresFile>
): Omit<PostgresFile, 'granule_cumulus_id'> => ({
  bucket: cryptoRandomString({ length: 3 }),
  key: cryptoRandomString({ length: 3 }),
  ...params,
});

export const fakeAsyncOperationRecordFactory = (
  params: Partial<PostgresAsyncOperation>
): PostgresAsyncOperation => ({
  id: uuidv4(),
  description: cryptoRandomString({ length: 10 }),
  operation_type: 'ES Index',
  status: 'RUNNING',
  output: { test: 'output' },
  task_arn: cryptoRandomString({ length: 3 }),
  ...params,
});

export const fakePdrRecordFactory = (
  params: Partial<PostgresPdr>
) => ({
  name: `pdr${cryptoRandomString({ length: 8 })}`,
  status: 'running',
  created_at: new Date(),
  ...params,
});
