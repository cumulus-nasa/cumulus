'use strict';

const pick = require('lodash/pick');
const test = require('ava');
const rewire = require('rewire');
const fs = require('fs');
const path = require('path');
const createTestServer = require('create-test-server');
const cookieParser = require('cookie-parser');
const { tmpdir } = require('os');
const {
  s3ObjectExists,
  getTextObject,
  headObject,
  promiseS3Upload,
  recursivelyDeleteS3Bucket,
} = require('@cumulus/aws-client/S3');
const { s3 } = require('@cumulus/aws-client/services');
const { randomString } = require('@cumulus/common/test-utils');
const HttpProviderClient = rewire('../HttpProviderClient');

const remoteContent = '<HDF CONTENT>';
const expectedContentType = 'application/x-hdf';

const basicUsername = 'user';
const basicPassword = 'pass';
const expectedAuthHeader = `Basic ${Buffer.from(`${basicUsername}:${basicPassword}`).toString('base64')}`;

// path for testing unauthenticated HTTPS requests
const publicFile = '/public/file.hdf';
// path for testing Basic auth HTTPS requests
const protectedFile = '/protected-basic/file.hdf';
const protectedFile2 = '/protected-basic/file2.hdf';

test.beforeEach(async (t) => {
  t.context.server = await createTestServer({ certificate: '127.0.0.1' });
  t.context.server.use(cookieParser());

  t.context.server2 = await createTestServer({ certificate: '127.0.0.1' });
  t.context.server2Url = new URL(t.context.server2.url);
  t.context.server2.use(cookieParser());
  // auth endpoint
  t.context.server2.get('/auth', (req, res) => {
    if (req.headers.authorization === expectedAuthHeader) {
      res.cookie('DATA', 'abcd1234'); // set cookie to test cookie-jar usage
      const protectedUrl = new URL(protectedFile2, t.context.server.url);
      res.redirect(protectedUrl.toString());
    } else {
      res.status(401).end();
    }
  });

  // public endpoint
  t.context.server.get(publicFile, (_, res) => {
    res.header({ 'content-type': expectedContentType });
    res.end(remoteContent);
  });
  // protected endpoint with redirect to /auth
  t.context.server.get(protectedFile, (req, res) => {
    if (req.cookies && req.cookies.DATA === 'abcd1234') {
      res.header({ 'content-type': expectedContentType });
      res.end(remoteContent);
    } else {
      res.redirect('/auth');
    }
  });
  // protected endpoint with redirect to /auth on a
  // different server
  t.context.server.get(protectedFile2, (req, res) => {
    if (req.cookies && req.cookies.DATA === 'abcd1234') {
      res.header({ 'content-type': expectedContentType });
      res.end(remoteContent);
    } else {
      res.redirect(`${t.context.server2.url}/auth`);
    }
  });
  // auth endpoint
  t.context.server.get('/auth', (req, res) => {
    if (req.headers.authorization === expectedAuthHeader) {
      res.cookie('DATA', 'abcd1234'); // set cookie to test cookie-jar usage
      res.redirect(protectedFile);
    } else {
      res.status(401).end();
    }
  });

  t.context.configBucket = randomString();
  await s3().createBucket({ Bucket: t.context.configBucket }).promise();
  await promiseS3Upload({
    Bucket: t.context.configBucket,
    Key: 'certificate.pem',
    Body: t.context.server.caCert,
  });

  t.context.httpsProviderClient = new HttpProviderClient({
    protocol: 'https',
    host: '127.0.0.1',
    port: t.context.server.sslPort,
    certificateUri: `s3://${t.context.configBucket}/certificate.pem`,
  });
});

test.afterEach.always(async (t) => {
  await t.context.server.close();
  await recursivelyDeleteS3Bucket(t.context.configBucket);
});

test('HttpsProviderClient decrypts credentials when encrypted', async (t) => {
  const encryptedUser = 'abcd1234';
  const encryptedPass = '1234abcd';
  const encryptionMap = {
    [encryptedUser]: basicUsername,
    [encryptedPass]: basicPassword,
  };

  HttpProviderClient.__set__('decrypt', (encryptedValue) => Promise.resolve(encryptionMap[encryptedValue]));
  const httpsProviderClient = new HttpProviderClient({
    protocol: 'https',
    host: '127.0.0.1',
    port: t.context.server.sslPort,
    certificateUri: `s3://${t.context.configBucket}/certificate.pem`,
    username: encryptedUser,
    password: encryptedPass,
    encrypted: true,
  });

  await httpsProviderClient.setUpGotOptions();

  t.deepEqual(
    { username: basicUsername, password: basicPassword },
    pick(httpsProviderClient, ['username', 'password'])
  );
});

test('HttpsProviderClient.list() with HTTPS returns expected files', async (t) => {
  t.context.server.get('/', '<html><body><A HREF="test.txt">test.txt</A></body></html>');

  const expectedFiles = [{ name: 'test.txt', path: '' }];

  const actualFiles = await t.context.httpsProviderClient.list('');

  t.deepEqual(actualFiles, expectedFiles);
});

test('HttpsProviderClient.download() downloads a file', async (t) => {
  const { httpsProviderClient } = t.context;
  const localPath = path.join(tmpdir(), randomString());
  try {
    await httpsProviderClient.download({ remotePath: publicFile, localPath });
    t.true(fs.existsSync(localPath));
    t.is(fs.readFileSync(localPath, 'utf-8'), remoteContent);
  } finally {
    fs.unlinkSync(localPath);
  }
});

test('HttpsProviderClient.sync() copies remote file to s3 with correct content-type', async (t) => {
  const destinationBucket = randomString();
  const destinationKey = 'syncedFile.json';

  try {
    await s3().createBucket({ Bucket: destinationBucket }).promise();
    const { s3uri, etag } = await t.context.httpsProviderClient.sync({
      fileRemotePath: publicFile,
      destinationBucket,
      destinationKey,
    });
    t.truthy(s3uri, 'Missing s3uri');
    t.truthy(etag, 'Missing etag');
    t.true(await s3ObjectExists({
      Bucket: destinationBucket,
      Key: destinationKey,
    }));
    const syncedContent = await getTextObject(destinationBucket, destinationKey);
    t.is(syncedContent, remoteContent);

    const s3HeadResponse = await headObject(destinationBucket, destinationKey);
    t.is(expectedContentType, s3HeadResponse.ContentType);
  } finally {
    await recursivelyDeleteS3Bucket(destinationBucket);
  }
});

test('HttpsProviderClient throws error if it gets a username but no password', (t) => {
  t.throws(() => new HttpProviderClient({
    protocol: 'https',
    host: '127.0.0.1',
    port: t.context.server.sslPort,
    certificateUri: `s3://${t.context.configBucket}/certificate.pem`,
    username: 'user',
  }),
  {
    instanceOf: ReferenceError,
    message: 'Found providerConfig.username, but providerConfig.password is not defined',
  });
});

test('HttpsProviderClient.download() supports basic auth with redirects', async (t) => {
  const httpsProviderClient = new HttpProviderClient({
    protocol: 'https',
    host: '127.0.0.1',
    port: t.context.server.sslPort,
    certificateUri: `s3://${t.context.configBucket}/certificate.pem`,
    username: basicUsername,
    password: basicPassword,
  });

  const localPath = path.join(tmpdir(), randomString());
  try {
    await httpsProviderClient.download({ remotePath: protectedFile, localPath });
    t.true(fs.existsSync(localPath));
    t.is(fs.readFileSync(localPath, 'utf-8'), remoteContent);
  } finally {
    fs.unlinkSync(localPath);
  }
});

test('HttpsProviderClient.download() supports basic auth with redirect to different host/port', async (t) => {
  const httpsProviderClient = new HttpProviderClient({
    protocol: 'https',
    host: '127.0.0.1',
    port: t.context.server.sslPort,
    certificateUri: `s3://${t.context.configBucket}/certificate.pem`,
    username: basicUsername,
    password: basicPassword,
    basicAuthRedirectHost: t.context.server2Url.host,
  });

  const localPath = path.join(tmpdir(), randomString());
  try {
    await httpsProviderClient.download({ remotePath: protectedFile2, localPath });
    t.true(fs.existsSync(localPath));
    t.is(fs.readFileSync(localPath, 'utf-8'), remoteContent);
  } finally {
    fs.unlinkSync(localPath);
  }
});

test('HttpsProviderClient.download() fails on basic auth redirect to different host if basicAuthRedirectHost is missing', async (t) => {
  const httpsProviderClient = new HttpProviderClient({
    protocol: 'https',
    host: '127.0.0.1',
    port: t.context.server.sslPort,
    certificateUri: `s3://${t.context.configBucket}/certificate.pem`,
    username: basicUsername,
    password: basicPassword,
  });

  const localPath = path.join(tmpdir(), randomString());
  console.log(localPath);
  try {
    await t.throwsAsync(
      httpsProviderClient.download({ remotePath: protectedFile2, localPath }),
      { message: /Response code 401/ }
    );
    t.is(fs.readFileSync(localPath, 'utf-8'), '');
  } finally {
    fs.unlinkSync(localPath);
  }
});

test('HttpsProviderClient.download() fails on basic auth redirect to different host if basicAuthRedirectHost does not match redirect host', async (t) => {
  const httpsProviderClient = new HttpProviderClient({
    protocol: 'https',
    host: '127.0.0.1',
    port: t.context.server.sslPort,
    certificateUri: `s3://${t.context.configBucket}/certificate.pem`,
    username: basicUsername,
    password: basicPassword,
    basicAuthRedirectHost: 'fake-host',
  });

  const localPath = path.join(tmpdir(), randomString());
  try {
    await t.throwsAsync(
      httpsProviderClient.download({ remotePath: protectedFile2, localPath }),
      { message: /Response code 401/ }
    );
    t.is(fs.readFileSync(localPath, 'utf-8'), '');
  } finally {
    fs.unlinkSync(localPath);
  }
});

test('HttpsProviderClient.sync() supports basic auth with redirects', async (t) => {
  const httpsProviderClient = new HttpProviderClient({
    protocol: 'https',
    host: '127.0.0.1',
    port: t.context.server.sslPort,
    certificateUri: `s3://${t.context.configBucket}/certificate.pem`,
    username: basicUsername,
    password: basicPassword,
  });

  const destinationBucket = randomString();
  const destinationKey = 'syncedFile.json';
  try {
    await s3().createBucket({ Bucket: destinationBucket }).promise();
    await httpsProviderClient.sync({
      fileRemotePath: protectedFile, destinationBucket, destinationKey,
    });
    t.true(await s3ObjectExists({
      Bucket: destinationBucket,
      Key: destinationKey,
    }));
    const syncedContent = await getTextObject(destinationBucket, destinationKey);
    t.is(syncedContent, remoteContent);

    const s3HeadResponse = await headObject(destinationBucket, destinationKey);
    t.is(expectedContentType, s3HeadResponse.ContentType);
  } finally {
    await recursivelyDeleteS3Bucket(destinationBucket);
  }
});

test('HttpsProviderClient.sync() supports basic auth with redirect to different host/port', async (t) => {
  const httpsProviderClient = new HttpProviderClient({
    protocol: 'https',
    host: '127.0.0.1',
    port: t.context.server.sslPort,
    certificateUri: `s3://${t.context.configBucket}/certificate.pem`,
    username: basicUsername,
    password: basicPassword,
    basicAuthRedirectHost: t.context.server2Url.host,
  });

  const destinationBucket = randomString();
  const destinationKey = 'syncedFile.hdf';
  try {
    await s3().createBucket({ Bucket: destinationBucket }).promise();
    await httpsProviderClient.sync({
      fileRemotePath: protectedFile2,
      destinationBucket,
      destinationKey,
    });
    t.true(await s3ObjectExists({
      Bucket: destinationBucket,
      Key: destinationKey,
    }));
    const syncedContent = await getTextObject(destinationBucket, destinationKey);
    t.is(syncedContent, remoteContent);

    const s3HeadResponse = await headObject(destinationBucket, destinationKey);
    t.is(expectedContentType, s3HeadResponse.ContentType);
  } finally {
    await recursivelyDeleteS3Bucket(destinationBucket);
  }
});

test('HttpsProviderClient.sync() fails on basic auth redirect to different host if basicAuthRedirectHost is missing', async (t) => {
  const httpsProviderClient = new HttpProviderClient({
    protocol: 'https',
    host: '127.0.0.1',
    port: t.context.server.sslPort,
    certificateUri: `s3://${t.context.configBucket}/certificate.pem`,
    username: basicUsername,
    password: basicPassword,
  });

  const destinationBucket = randomString();
  const destinationKey = 'syncedFile.hdf';
  try {
    await s3().createBucket({ Bucket: destinationBucket }).promise();
    await t.throwsAsync(
      httpsProviderClient.sync({
        fileRemotePath: protectedFile2,
        destinationBucket,
        destinationKey,
      }),
      { message: /Response code 401/ }
    );
    t.false(await s3ObjectExists({
      Bucket: destinationBucket,
      Key: destinationKey,
    }));
  } finally {
    await recursivelyDeleteS3Bucket(destinationBucket);
  }
});

test('HttpsProviderClient.sync() fails on basic auth redirect to different host if basicAuthRedirectHost does not match redirect host', async (t) => {
  const httpsProviderClient = new HttpProviderClient({
    protocol: 'https',
    host: '127.0.0.1',
    port: t.context.server.sslPort,
    certificateUri: `s3://${t.context.configBucket}/certificate.pem`,
    username: basicUsername,
    password: basicPassword,
    basicAuthRedirectHost: 'fake-host',
  });

  const destinationBucket = randomString();
  const destinationKey = 'syncedFile.hdf';
  try {
    await s3().createBucket({ Bucket: destinationBucket }).promise();
    await t.throwsAsync(
      httpsProviderClient.sync({
        fileRemotePath: protectedFile2,
        destinationBucket,
        destinationKey,
      }),
      { message: /Response code 401/ }
    );
    t.false(await s3ObjectExists({
      Bucket: destinationBucket,
      Key: destinationKey,
    }));
  } finally {
    await recursivelyDeleteS3Bucket(destinationBucket);
  }
});
