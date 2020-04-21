'use strict';

const test = require('ava');
const KMS = require('@cumulus/aws-client/KMS');
const S3 = require('@cumulus/aws-client/S3');
const { randomString } = require('@cumulus/common/test-utils');

const schemas = require('../../models/schemas');
const {
  fakeProviderFactory,
  fakeRuleFactoryV2
} = require('../../lib/testUtils');
const { Manager, Provider, Rule } = require('../../models');
const { AssociatedRulesError } = require('../../lib/errors');

let manager;
let ruleModel;
test.before(async () => {
  process.env.stackName = randomString();

  process.env.system_bucket = randomString();
  await S3.createBucket(process.env.system_bucket);

  const createKeyResponse = await KMS.createKey();
  process.env.provider_kms_key_id = createKeyResponse.KeyMetadata.KeyId;

  process.env.ProvidersTable = randomString();

  manager = new Manager({
    tableName: process.env.ProvidersTable,
    tableHash: { name: 'id', type: 'S' },
    schema: schemas.provider
  });

  await manager.createTable();

  process.env.RulesTable = randomString();
  ruleModel = new Rule();
  await ruleModel.createTable();
});

test.after.always(async () => {
  await manager.deleteTable();
  await ruleModel.deleteTable();
  await S3.recursivelyDeleteS3Bucket(process.env.system_bucket);
});

test('Providers.exists() returns true when a record exists', async (t) => {
  const id = randomString();

  await manager.create(fakeProviderFactory({ id }));

  const providersModel = new Provider();

  t.true(await providersModel.exists(id));
});

test('Providers.exists() returns false when a record does not exist', async (t) => {
  const providersModel = new Provider();

  t.false(await providersModel.exists(randomString()));
});

test('Providers.delete() throws an exception if the provider has associated rules', async (t) => {
  const providersModel = new Provider();

  const providerId = randomString();
  await manager.create(fakeProviderFactory({ id: providerId }));

  const rule = fakeRuleFactoryV2({
    provider: providerId,
    rule: {
      type: 'onetime'
    }
  });

  // The workflow message template must exist in S3 before the rule can be created
  await Promise.all([
    S3.putJsonS3Object(
      process.env.system_bucket,
      `${process.env.stackName}/workflows/${rule.workflow}.json`,
      {}
    ),
    S3.putJsonS3Object(
      process.env.system_bucket,
      `${process.env.stackName}/workflow_template.json`,
      {}
    )
  ]);

  await ruleModel.create(rule);

  try {
    await providersModel.delete({ id: providerId });
    t.fail('Expected an exception to be thrown');
  } catch (err) {
    t.true(err instanceof AssociatedRulesError);
    t.is(err.message, 'Cannot delete a provider that has associated rules');
    t.deepEqual(err.rules, [rule.name]);
  }
});

test('Providers.delete() deletes a provider', async (t) => {
  const providersModel = new Provider();

  const providerId = randomString();
  await manager.create(fakeProviderFactory({ id: providerId }));

  await providersModel.delete({ id: providerId });

  t.false(await manager.exists({ id: providerId }));
});

test('Providers.create() throws a ValidationError if an invalid hostname is used', async (t) => {
  const providersModel = new Provider();

  await t.throwsAsync(
    providersModel.create(
      // host should just be a host name, not a full URL
      fakeProviderFactory({ host: 'http://www.example.com' })
    ),
    { name: 'ValidationError' }
  );
});

test('Providers.create() throws a ValidationError if an invalid IP host is used', async (t) => {
  const providersModel = new Provider();

  await t.throwsAsync(
    providersModel.create(
      fakeProviderFactory({ host: '-127.0.0.1' })
    ),
    { name: 'ValidationError' }
  );
});

test('Providers.create() encrypts the credentials using KMS', async (t) => {
  const providersModel = new Provider();

  const provider = fakeProviderFactory({
    username: 'my-username',
    password: 'my-password'
  });

  await providersModel.create(provider);

  const fetchedProvider = await providersModel.get({ id: provider.id });

  t.true(fetchedProvider.encrypted);

  t.is(
    await KMS.decryptBase64String(fetchedProvider.username),
    'my-username'
  );

  t.is(
    await KMS.decryptBase64String(fetchedProvider.password),
    'my-password'
  );
});

test('Providers.update() throws a ValidationError if an invalid host is used', async (t) => {
  const providersModel = new Provider();

  const provider = fakeProviderFactory();
  await providersModel.create(provider);

  try {
    await providersModel.update(
      { id: provider.id },
      { host: 'http://www.example.com' }
    );

    t.fail('Expected an exception');
  } catch (err) {
    t.is(err.name, 'ValidationError');
  }
});

test('Providers.update() encrypts the credentials using KMS', async (t) => {
  const providersModel = new Provider();

  const provider = fakeProviderFactory({
    username: 'my-username-1',
    password: 'my-password-1'
  });

  await providersModel.create(provider);

  await providersModel.update(
    { id: provider.id },
    {
      username: 'my-username-2',
      password: 'my-password-2'
    }
  );

  const fetchedProvider = await providersModel.get({ id: provider.id });

  t.true(fetchedProvider.encrypted);

  t.is(
    await KMS.decryptBase64String(fetchedProvider.username),
    'my-username-2'
  );

  t.is(
    await KMS.decryptBase64String(fetchedProvider.password),
    'my-password-2'
  );
});
