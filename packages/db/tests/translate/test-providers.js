const test = require('ava');

const {
  encryptValueWithKMS,
  translateApiProviderToPostgresProvider,
} = require('../../dist/translate/providers');

test.beforeEach(() => {
  process.env.provider_kms_key_id = 'fakeKeyId';
});

test('translateApiProviderToPostgresProvider translates a Cumulus Provider object to a Postgres Provider object', async (t) => {
  const fakeEncryptFunction = () => Promise.resolve('fakeEncryptedString');
  const cumulusProviderObject = {
    id: 'testId',
    globalConnectionLimit: 1,
    protocol: 'fakeProtocol',
    host: 'fakeHost',
    port: 1234,
    username: 'fakeUsername',
    password: 'fakePassword',
    encrypted: true,
    createdAt: 1234,
    updatedAt: 5678,
    privateKey: 'fakeKey',
    cmKeyId: 'fakecmId',
    certificateUri: 'fakeUri',
    basicAuthRedirectHost: 'redirectHost',
  };

  const expected = {
    certificate_uri: 'fakeUri',
    cm_key_id: 'fakecmId',
    created_at: new Date(1234),
    global_connection_limit: 1,
    host: 'fakeHost',
    name: 'testId',
    password: 'fakeEncryptedString',
    port: 1234,
    private_key: 'fakeKey',
    protocol: 'fakeProtocol',
    updated_at: new Date(5678),
    username: 'fakeEncryptedString',
    basic_auth_redirect_host: 'redirectHost',
  };
  const result = await translateApiProviderToPostgresProvider(
    cumulusProviderObject,
    fakeEncryptFunction
  );
  t.deepEqual(result, expected);
});

test.serial('encryptValueWithKMS throws if provder_kms_key_id does not exist', async (t) => {
  await t.throwsAsync(() => encryptValueWithKMS('somevalue'));
});

test.serial('encryptValueWithKMS encrypts the key', async (t) => {
  const actual = await encryptValueWithKMS('somevalue', () => 'encrypted');
  t.is(actual, 'encrypted');
});
