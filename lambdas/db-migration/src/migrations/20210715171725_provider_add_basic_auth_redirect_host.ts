import * as Knex from 'knex';

export const up = async (knex: Knex): Promise<void> =>
  await knex.schema.table('providers', (table) => {
    table
      .string('basic_auth_redirect_host')
      .comment('Allowed host for redirect if data is protected by HTTP basic-auth');
  });

export const down = async (knex: Knex): Promise<void> => {
  if (await knex.schema.hasColumn('providers', 'basic_auth_redirect_host')) {
    await knex.schema.table('providers', (table) => {
      table.dropColumn('basic_auth_redirect_host');
    });
  }
};
