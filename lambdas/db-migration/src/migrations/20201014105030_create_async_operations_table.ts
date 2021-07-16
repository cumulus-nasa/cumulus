import * as Knex from 'knex';

export const up = async (knex: Knex): Promise<void> =>
  await knex.schema.createTable('async_operations', (table) => {
    table
      .increments('cumulus_id')
      .primary();
    table
      .uuid('id')
      .comment('Unique ID for async operation')
      .notNullable();
    table
      .text('description')
      .comment('description for async operation')
      .notNullable();
    table
      .enum('operation_type',
        [
          'Archived S3 Messages Replay',
          'ES Index',
          'Bulk Granules',
          'Bulk Granule Reingest',
          'Bulk Granule Delete',
          'Dead-Letter Processing',
          'Kinesis Replay',
          'Reconciliation Report',
          'Migration Count Report',
          'Data Migration',
        ])
      .comment('type of async operation')
      .notNullable();
    table
      .jsonb('output')
      .comment('output of completed async operation');
    table
      .enum('status', ['RUNNING', 'SUCCEEDED', 'RUNNER_FAILED', 'TASK_FAILED'])
      .comment('async operation status')
      .notNullable();
    table
      .text('task_arn')
      .comment('async operation ECS task ARN');
    table
      .timestamps(false, true);
    table.unique(['id']);
  });

export const down = async (knex: Knex): Promise<void> => await knex.schema
  .dropTableIfExists('async_operations');
