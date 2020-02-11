'use strict';

const fs = require('fs');
const rewire = require('rewire');
const test = require('ava');
const EventEmitter = require('events');
const path = require('path');
const { promisify } = require('util');
const { tmpdir } = require('os');
const { Readable } = require('stream');
const {
  calculateS3ObjectChecksum,
  fileExists,
  recursivelyDeleteS3Bucket,
  headObject
} = require('@cumulus/aws-client/S3');
const { s3 } = require('@cumulus/aws-client/services');
const { randomString } = require('@cumulus/common/test-utils');
const HttpProviderClient = rewire('../HttpProviderClient');

const testListWith = (discoverer, event, ...args) => {
  class Crawler extends EventEmitter {
    start() {
      this.emit(event, ...args);
    }
  }

  return HttpProviderClient.__with__({
    Crawler
  })(() => discoverer.list(''));
};

test.before((t) => {
  t.context.httpProviderClient = new HttpProviderClient({
    protocol: 'http',
    host: 'localhost',
    port: 3030
  });
});

test('sync() downloads remote file to s3 with correct content-type', async (t) => {
  const bucket = randomString();
  const key = randomString();
  const expectedContentType = 'application/x-hdf';
  try {
    await s3().createBucket({ Bucket: bucket }).promise();
    await t.context.httpProviderClient.sync(
      '/granules/MOD09GQ.A2017224.h27v08.006.2017227165029.hdf', bucket, key
    );
    t.truthy(fileExists(bucket, key));
    const sum = await calculateS3ObjectChecksum({ algorithm: 'CKSUM', bucket, key });
    t.is(sum, 1435712144);

    const s3HeadResponse = await headObject(bucket, key);
    t.is(expectedContentType, s3HeadResponse.ContentType);
  } finally {
    await recursivelyDeleteS3Bucket(bucket);
  }
});

test.serial('list() returns files with provider path', async (t) => {
  const responseBody = '<html><body><a href="file.txt">asdf</a></body></html>';

  const actualFiles = await testListWith(
    t.context.httpProviderClient,
    'fetchcomplete',
    {},
    Buffer.from(responseBody),
    {}
  );

  console.log('actualFiles:', JSON.stringify(actualFiles, null, 2));

  const expectedFiles = [{ name: 'file.txt', path: '' }];

  t.deepEqual(actualFiles, expectedFiles);
});

test.serial.only('list() returns files for provider with different source formatting', async (t) => {
  const responseBody = `
  <html><body>

<pre><A HREF="/parent/dir/">[To Parent Directory]</A><br><br>  1/2/2020  2:21 PM      1891826 <A HREF="test.txt">test.txt</A></body></html>
  `;

  const actualFiles = await testListWith(
    t.context.httpProviderClient,
    'fetchcomplete',
    {},
    Buffer.from(responseBody),
    {}
  );

  t.true(actualFiles.length > 0);
});

test.serial('list() strips trailing spaces from name', async (t) => {
  const responseBody = '<html><body><a href="file.txt ">asdf</a></body></html>';

  const actualFiles = await testListWith(
    t.context.httpProviderClient,
    'fetchcomplete',
    {},
    Buffer.from(responseBody),
    {}
  );

  const expectedFiles = [{ name: 'file.txt', path: '' }];

  t.deepEqual(actualFiles, expectedFiles);
});

test.serial('list() does not strip leading spaces from name', async (t) => {
  const responseBody = '<html><body><a href=" file.txt ">asdf</a></body></html>';

  const actualFiles = await testListWith(
    t.context.httpProviderClient,
    'fetchcomplete',
    {},
    Buffer.from(responseBody),
    {}
  );

  const expectedFiles = [{ name: ' file.txt', path: '' }];

  t.deepEqual(actualFiles, expectedFiles);
});

test.serial('list() returns a valid exception if the connection times out', async (t) => {
  await t.throwsAsync(
    () => testListWith(t.context.httpProviderClient, 'fetchtimeout', {}, 100),
    'Connection timed out'
  );
});

test.serial('list() returns an exception with helpful information if a fetcherror event occurs', async (t) => {
  // The QueueItem that gets returned by the 'fetcherror' event
  const queueItem = { url: 'http://localhost/asdf' };

  // The http.IncomingMessage that gets returned by the 'fetcherror' event
  let nextChunk = 'Login required';
  const response = new Readable({
    read() {
      this.push(nextChunk);
      nextChunk = null;
    }
  });

  response.statusCode = 401;
  response.req = { method: 'GET' };

  const err = await t.throwsAsync(
    () => testListWith(t.context.httpProviderClient, 'fetcherror', queueItem, response)
  );

  t.true(err.message.includes('401'));
  t.is(err.details, 'Login required');
});

test.serial('list() returns an exception if a fetchclienterror event occurs', async (t) => {
  await t.throwsAsync(
    () => testListWith(t.context.httpProviderClient, 'fetchclienterror'),
    'Connection Refused'
  );
});

test.serial('list() returns an exception if a fetch404 event occurs', async (t) => {
  const err = await t.throwsAsync(
    () => testListWith(t.context.httpProviderClient, 'fetch404', { foo: 'bar' })
  );

  t.true(err.message.includes('Received a 404 error'));
  t.deepEqual(err.details, { foo: 'bar' });
});

test.serial('download() downloads a file', async (t) => {
  const { httpProviderClient } = t.context;
  const localPath = path.join(tmpdir(), randomString());
  try {
    await httpProviderClient.download('pdrs/PDN.ID1611071307.PDR', localPath);
    t.is(await promisify(fs.access)(localPath), undefined);
  } finally {
    await promisify(fs.unlink)(localPath);
  }
});
