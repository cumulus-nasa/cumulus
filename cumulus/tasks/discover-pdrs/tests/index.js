'use strict';

const test = require('ava');
const path = require('path');
const fs = require('fs-extra');
const { FTPError, RemoteResourceError } = require('@cumulus/common/errors');
const { cloneDeep } = require('lodash');

const { discoverPdrs } = require('../index');
const input = require('./fixtures/input.json');

const { recursivelyDeleteS3Bucket, s3 } = require('@cumulus/common/aws');
const {
  findTestDataDirectory,
  findTmpTestDataDirectory,
  randomString,
  validateConfig,
  validateOutput
} = require('@cumulus/common/test-utils');

test('test pdr discovery with FTP assuming all PDRs are new', async (t) => {
  const event = cloneDeep(input);
  event.config.bucket = randomString();
  event.config.collection.provider_path = '/pdrs';
  event.config.useList = true;
  event.config.provider = {
    id: 'MODAPS',
    protocol: 'ftp',
    host: 'localhost',
    username: 'testuser',
    password: 'testpass'
  };

  await validateConfig(t, event.config);

  await s3().createBucket({ Bucket: event.config.bucket }).promise();

  try {
    const output = await discoverPdrs(event);
    await validateOutput(t, output);
    t.is(output.pdrs.length, 4);
  }
  catch (err) {
    if (err instanceof RemoteResourceError) {
      t.pass('ignoring this test. Test server seems to be down');
    }
    else t.fail(err);
  }
  finally {
    await recursivelyDeleteS3Bucket(event.config.bucket);
  }
});

test('test pdr discovery with FTP invalid user/pass', async (t) => {
  const provider = {
    id: 'MODAPS',
    protocol: 'ftp',
    host: 'localhost',
    username: 'testuser1',
    password: 'testpass'
  };

  const newPayload = cloneDeep(input);
  newPayload.config.provider = provider;
  newPayload.input = {};

  await validateConfig(t, newPayload.config);

  return discoverPdrs(newPayload, {})
    .then(t.fail)
    .catch((e) => {
      if (e instanceof RemoteResourceError) {
        t.pass('ignoring this test. Test server seems to be down');
      }
      else {
        t.true(e instanceof FTPError);
        t.true(e.message.includes('Login incorrect'));
      }
    });
});

test('test pdr discovery with FTP connection refused', async (t) => {
  const provider = {
    id: 'MODAPS',
    protocol: 'ftp',
    host: 'localhost',
    port: 30, // using port that doesn't exist to nonresponsiveness
    username: 'testuser1',
    password: 'testpass'
  };

  const newPayload = cloneDeep(input);
  newPayload.config.provider = provider;
  newPayload.input = {};

  await validateConfig(t, newPayload.config);

  return discoverPdrs(newPayload, {})
    .then(t.fail)
    .catch((e) => {
      t.true(e instanceof RemoteResourceError);
    });
});

test('test pdr discovery with FTP assuming some PDRs are new', async (t) => {
  const provider = {
    id: 'MODAPS',
    protocol: 'ftp',
    host: 'localhost',
    username: 'testuser',
    password: 'testpass'
  };

  const newPayload = cloneDeep(input);
  newPayload.config.useList = true;
  newPayload.config.provider = provider;
  newPayload.config.collection.provider_path = '/pdrs';
  newPayload.input = {};

  const internalBucketName = randomString();
  newPayload.config.bucket = internalBucketName;

  await validateConfig(t, newPayload.config);

  return s3().createBucket({ Bucket: internalBucketName }).promise()
    .then(() => {
      const Key = [
        newPayload.config.stack,
        newPayload.config.collection.provider_path.replace(/^\//, ''),
        'PDN.ID1611071307.PDR'
      ].join('/');

      return s3().putObject({
        Bucket: internalBucketName,
        Key,
        Body: 'PDN.ID1611071307.PDR'
      }).promise();
    })
    .then(() => discoverPdrs(newPayload, {}))
    .then((output) => {
      t.is(output.pdrs.length, 3);
      return validateOutput(t, output);
    })
    .then(() => recursivelyDeleteS3Bucket(internalBucketName))
    .catch((e) => {
      if (e instanceof RemoteResourceError) {
        t.pass('ignoring this test. Test server seems to be down');
        return recursivelyDeleteS3Bucket(internalBucketName);
      }
      return recursivelyDeleteS3Bucket(internalBucketName).then(t.fail);
    });
});

test('test pdr discovery with HTTP assuming some PDRs are new', async (t) => {
  const internalBucketName = randomString();
  const providerPath = randomString();

  // Figure out the directory paths that we're working with
  const testDataDirectory = path.join(await findTestDataDirectory(), 'pdrs');
  const providerPathDirectory = path.join(await findTmpTestDataDirectory(), providerPath);

  // Create providerPathDirectory and internal bucket
  await Promise.all([
    fs.ensureDir(providerPathDirectory),
    s3().createBucket({ Bucket: internalBucketName }).promise()
  ]);

  try {
    // Copy the PDRs to the HTTP directory
    const pdrFilenames = await fs.readdir(testDataDirectory);

    const oldPdr = pdrFilenames[0];
    const newPdrs = pdrFilenames.slice(1);

    await Promise.all(pdrFilenames.map((pdrFilename) => fs.copy(
      path.join(testDataDirectory, pdrFilename),
      path.join(providerPathDirectory, pdrFilename))));

    // Build the event
    const event = cloneDeep(input);
    event.config.bucket = internalBucketName;
    event.config.provider = {
      id: 'MODAPS',
      protocol: 'http',
      host: 'http://localhost:8080'
    };
    event.config.collection.provider_path = providerPath;
    event.input = {};

    // Mark one of the PDRs as not new
    await s3().putObject({
      Bucket: internalBucketName,
      // 'pdrs' is the default 'folder' value in the Discover contructor
      Key: `${event.config.stack}/pdrs/${oldPdr}`,
      Body: 'Pretend this is a PDR'
    }).promise();

    await validateConfig(t, event.config);
    let output;
    try {
      output = await discoverPdrs(event, {});

      await validateOutput(t, output);

      t.is(output.pdrs.length, 3);
      const names = output.pdrs.map((p) => p.name);
      newPdrs.forEach((pdr) => t.true(names.includes(pdr)));
    }
    catch (e) {
      if (e instanceof RemoteResourceError) {
        t.pass('Ignoring this test. Test server seems to be down');
      }
      else t.fail(e);
    }
  }
  finally {
    // Clean up
    await Promise.all([
      recursivelyDeleteS3Bucket(internalBucketName),
      fs.remove(providerPathDirectory)
    ]);
  }
});

test('test pdr discovery with SFTP assuming some PDRs are new', async (t) => {
  const internalBucketName = randomString();
  const providerPath = randomString();

  // Figure out the directory paths that we're working with
  const testDataDirectory = path.join(await findTestDataDirectory(), 'pdrs');
  const providerPathDirectory = path.join(await findTmpTestDataDirectory(), providerPath);

  // Create providerPathDirectory and internal bucket
  await Promise.all([
    fs.ensureDir(providerPathDirectory),
    s3().createBucket({ Bucket: internalBucketName }).promise()
  ]);

  try {
    // Copy the PDRs to the SFTP directory
    const pdrFilenames = await fs.readdir(testDataDirectory);

    const oldPdr = pdrFilenames[0];
    const newPdrs = pdrFilenames.slice(1);

    await Promise.all(pdrFilenames.map((pdrFilename) => fs.copy(
      path.join(testDataDirectory, pdrFilename),
      path.join(providerPathDirectory, pdrFilename))));

    // Build the event
    const event = cloneDeep(input);
    event.config.bucket = internalBucketName;
    event.config.provider = {
      id: 'MODAPS',
      protocol: 'sftp',
      host: 'localhost',
      port: 2222,
      username: 'user',
      password: 'password'
    };
    // The test-data prefix is required because of the way that the sftp
    // container is configured in docker-compose.yml.
    event.config.collection.provider_path = `test-data/${providerPath}`;
    event.input = {};

    // Mark one of the PDRs as not new
    await s3().putObject({
      Bucket: internalBucketName,
      // 'pdrs' is the default 'folder' value in the Discover contructor
      Key: `${event.config.stack}/pdrs/${oldPdr}`,
      Body: 'Pretend this is a PDR'
    }).promise();

    await validateConfig(t, event.config);
    let output;
    try {
      output = await discoverPdrs(event, {});

      await validateOutput(t, output);

      t.is(output.pdrs.length, 3);
      const names = output.pdrs.map((p) => p.name);
      newPdrs.forEach((pdr) => t.true(names.includes(pdr)));
    }
    catch (e) {
      if (e instanceof RemoteResourceError) {
        t.pass('Ignoring this test. Test server seems to be down');
      }
      else t.fail(e);
    }
  }
  finally {
    // Clean up
    await Promise.all([
      recursivelyDeleteS3Bucket(internalBucketName),
      fs.remove(providerPathDirectory)
    ]);
  }
});
