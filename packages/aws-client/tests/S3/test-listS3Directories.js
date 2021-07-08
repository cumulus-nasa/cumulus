'use strict';

const test = require('ava');
const cryptoRandomString = require('crypto-random-string');
const S3 = require('../../S3');

test.serial('listS3Directories() returns a NoSuchBucket code if the bucket does not exist', async (t) => {
  const Bucket = cryptoRandomString({ length: 10 });
  const params = {
    Bucket,
  };

  const error = await t.throwsAsync(
    S3.listS3Directories(params)
  );

  t.is(error.code, 'NoSuchBucket');
});

test.serial('listS3Directories() returns directories in a given path if bucket is specified', async (t) => {
  const stackName = cryptoRandomString({ length: 5 });
  const generateKeys = (key) => `${key}-${cryptoRandomString({ length: 5 })}`;

  const sourceBucket = `${stackName}-${cryptoRandomString({ length: 5 })}`;
  const firstKey = generateKeys('key1');
  const secondKey = generateKeys('key2');

  await S3.createBucket(sourceBucket);
  t.teardown(async () => {
    await S3.recursivelyDeleteS3Bucket(sourceBucket);
  });

  await S3.s3PutObject({
    Bucket: sourceBucket,
    Key: firstKey,
    Body: 'random-body',
  });
  await S3.s3PutObject({
    Bucket: sourceBucket,
    Key: `${secondKey}`,
    Body: 'another-random-body',
  });
  await S3.s3PutObject({
    Bucket: sourceBucket,
    Key: `${firstKey}/1`,
    Body: 'random-body',
  });
  await S3.s3PutObject({
    Bucket: sourceBucket,
    Key: `${secondKey}/2`,
    Body: 'another-random-body',
  });
  const params = {
    Bucket: sourceBucket,
  };

  const allObjects = await S3.listS3ObjectsV2(params);
  t.is(allObjects.length, 4);

  // Ensure that only directories in top level are returned
  const directories = await S3.listS3Directories(params);
  t.is(directories.length, 2);
  t.is(directories[0].Key, firstKey);
  t.is(directories[1].Key, secondKey);
});

test.serial('listS3Directories() returns directories in a given path if bucket and prefix is specified', async (t) => {
  const stackName = cryptoRandomString({ length: 5 });
  const generateKeys = (key) => `${key}-${cryptoRandomString({ length: 5 })}`;

  const sourceBucket = `${stackName}-${cryptoRandomString({ length: 5 })}`;
  const firstKey = generateKeys('key1');
  const secondKey = generateKeys('key2');

  await S3.createBucket(sourceBucket);
  t.teardown(async () => {
    await S3.recursivelyDeleteS3Bucket(sourceBucket);
  });

  await S3.s3PutObject({
    Bucket: sourceBucket,
    Key: firstKey,
    Body: 'random-body',
  });
  await S3.s3PutObject({
    Bucket: sourceBucket,
    Key: `${secondKey}`,
    Body: 'another-random-body',
  });
  await S3.s3PutObject({
    Bucket: sourceBucket,
    Key: `${firstKey}/1/a`,
    Body: 'random-body',
  });
  await S3.s3PutObject({
    Bucket: sourceBucket,
    Key: `${firstKey}/1/b`,
    Body: 'another-random-body',
  });
  await S3.s3PutObject({
    Bucket: sourceBucket,
    Key: `${firstKey}/2`,
    Body: 'another-random-body',
  });

  const allObjects = await S3.listS3ObjectsV2({ Bucket: sourceBucket });
  t.is(allObjects.length, 5);

  const params = {
    Bucket: sourceBucket,
    Prefix: `${firstKey}/1/`,
  };
  const directories = await S3.listS3Directories(params);
  t.is(directories.length, 2);
  t.is(directories[0].Key, `${firstKey}/1/a`);
  t.is(directories[1].Key, `${firstKey}/1/b`);
});
