'use strict';

const test = require('ava');
const sinon = require('sinon');
const rewire = require('rewire');

const cmrUtils = rewire('../../cmr-utils');

const { BucketsConfig, log } = require('@cumulus/common');

const { randomId } = require('@cumulus/common/test-utils');

test.beforeEach((t) => {
  t.context.granuleId = randomId('granuleId');
  t.context.distEndpoint = randomId('https://example.com/');
  t.context.published = true;
});

test('reconcileCMRMetadata does not call updateCMRMetadata if no metadatafile present', async (t) => {
  const updatedFiles = [
    { filename: 'anotherfile' },
    { filename: 'cmrmeta.cmr' }
  ];
  const {
    granuleId,
    distEndpoint,
    published
  } = t.context;
  const fakeUpdateCMRMetadata = sinon.fake.resolves(true);
  const restoreUpdateCMRMetadata = cmrUtils.__set__('updateCMRMetadata', fakeUpdateCMRMetadata);

  const cmrClient = {};

  const results = await cmrUtils.reconcileCMRMetadata({
    cmrClient,
    granuleId,
    updatedFiles,
    distEndpoint,
    published
  });

  t.falsy(results);
  t.false(fakeUpdateCMRMetadata.called);

  sinon.restore();
  restoreUpdateCMRMetadata();
});

test('reconcileCMRMetadata calls updateCMRMetadata if metadatafile present', async (t) => {
  const updatedFiles = [{ filename: 'anotherfile' }, { filename: 'cmrmeta.cmr.xml' }];
  const {
    granuleId,
    distEndpoint,
    published
  } = t.context;

  const fakeUpdateCMRMetadata = sinon.fake.resolves(true);
  const restoreUpdateCMRMetadata = cmrUtils.__set__('updateCMRMetadata', fakeUpdateCMRMetadata);

  const cmrClient = {};

  const params = {
    cmrClient,
    granuleId,
    updatedFiles,
    distEndpoint,
    published
  };

  const results = await cmrUtils.reconcileCMRMetadata(params);

  t.true(results);
  t.true(
    fakeUpdateCMRMetadata.calledOnceWith({
      cmrClient,
      granuleId,
      cmrFile: updatedFiles[1],
      files: updatedFiles,
      distEndpoint,
      published
    })
  );

  sinon.restore();
  restoreUpdateCMRMetadata();
});

test('reconcileCMRMetadata logs an error if multiple metadatafiles present.', async (t) => {
  const updatedFiles = [{ filename: 'anotherfile.cmr.json' }, { filename: 'cmrmeta.cmr.xml' }];
  const {
    granuleId,
    distEndpoint,
    published
  } = t.context;
  const mockLog = sinon.spy(log, 'error');
  const fakeUpdateCMRMetadata = sinon.fake.resolves(true);
  const restoreUpdateCMRMetadata = cmrUtils.__set__('updateCMRMetadata', fakeUpdateCMRMetadata);

  const cmrClient = {};

  const results = await cmrUtils.reconcileCMRMetadata({
    cmrClient,
    granuleId,
    updatedFiles,
    distEndpoint,
    published
  });

  t.falsy(results);
  t.false(fakeUpdateCMRMetadata.called);
  t.true(mockLog.calledOnceWith('More than one cmr metadata file found.'));

  sinon.restore();
  restoreUpdateCMRMetadata();
});


test('reconcileCMRMetadata calls updateEcho10XMLMetadata but not publishECHO10XML2CMR if xml metadata present and publish is false', async (t) => {
  // arrange
  const updatedFiles = [{ filename: 'anotherfile' }, { filename: 'cmrmeta.cmr.xml' }];
  const { granuleId, distEndpoint } = t.context;
  const published = false;
  const fakeBuckets = { private: { type: 'private', name: 'private' } };
  const fakeBucketsConfigJsonObject = sinon.fake.returns(fakeBuckets);
  const restoreBucketsConfigDefaults = cmrUtils.__set__('bucketsConfigJsonObject', fakeBucketsConfigJsonObject);

  const fakeUpdateCMRMetadata = sinon.fake.resolves(true);
  const restoreUpdateEcho10XMLMetadata = cmrUtils.__set__('updateEcho10XMLMetadata', fakeUpdateCMRMetadata);

  const fakePublishECHO10XML2CMR = sinon.fake.resolves({});
  const restorePublishECHO10XML2CMR = cmrUtils.__set__('publishECHO10XML2CMR', fakePublishECHO10XML2CMR);

  const cmrClient = {};

  // act
  await cmrUtils.reconcileCMRMetadata({
    cmrClient,
    granuleId,
    updatedFiles,
    distEndpoint,
    published
  });

  const paramsIntoUpdateEcho10XML = {
    cmrFile: updatedFiles[1],
    files: updatedFiles,
    distEndpoint,
    cmrGranuleUrlType: 'distribution',
    buckets: new BucketsConfig(fakeBuckets)
  };

  // assert
  t.deepEqual(paramsIntoUpdateEcho10XML, fakeUpdateCMRMetadata.firstCall.args[0]);
  t.true(fakeUpdateCMRMetadata.calledOnce);
  t.true(fakePublishECHO10XML2CMR.notCalled);

  // cleanup
  sinon.restore();
  restoreUpdateEcho10XMLMetadata();
  restorePublishECHO10XML2CMR();
  restoreBucketsConfigDefaults();
});

test('reconcileCMRMetadata calls updateEcho10XMLMetadata and publishECHO10XML2CMR if xml metadata present and publish is true', async (t) => {
  const updatedFiles = [{ filename: 'anotherfile' }, { filename: 'cmrmeta.cmr.xml' }];
  const {
    granuleId,
    distEndpoint,
    published
  } = t.context;

  const fakeMetadataObject = { fake: 'metadata' };

  const fakeUpdateCMRMetadata = sinon.fake.resolves(fakeMetadataObject);
  const restoreUpdateEcho10XMLMetadata = cmrUtils.__set__('updateEcho10XMLMetadata', fakeUpdateCMRMetadata);

  const fakePublishECHO10XML2CMR = sinon.fake.resolves({});
  const restorePublishECHO10XML2CMR = cmrUtils.__set__('publishECHO10XML2CMR', fakePublishECHO10XML2CMR);

  const fakeBuckets = { private: { type: 'private', name: 'private' } };
  const fakeBucketsConfigJsonObject = sinon.fake.returns(fakeBuckets);
  const restoreBucketsConfigDefaults = cmrUtils.__set__('bucketsConfigJsonObject', fakeBucketsConfigJsonObject);


  const bucket = randomId('bucket');
  const stackName = randomId('stack');
  process.env.system_bucket = bucket;
  process.env.stackName = stackName;
  const expectedMetadata = {
    filename: 'cmrmeta.cmr.xml',
    metadataObject: fakeMetadataObject,
    granuleId
  };

  const cmrClient = {};

  await cmrUtils.reconcileCMRMetadata({
    cmrClient,
    granuleId,
    updatedFiles,
    distEndpoint,
    published
  });

  const paramsIntoUpdateEcho10XML = {
    cmrFile: updatedFiles[1],
    files: updatedFiles,
    distEndpoint,
    cmrGranuleUrlType: 'distribution',
    buckets: new BucketsConfig(fakeBuckets)
  };

  t.deepEqual(paramsIntoUpdateEcho10XML, fakeUpdateCMRMetadata.firstCall.args[0]);
  t.true(fakeUpdateCMRMetadata.calledOnce);
  t.true(fakePublishECHO10XML2CMR.calledOnceWith(expectedMetadata, cmrClient));

  sinon.restore();
  restoreUpdateEcho10XMLMetadata();
  restorePublishECHO10XML2CMR();
  restoreBucketsConfigDefaults();
});

test('reconcileCMRMetadata calls updateUMMGMetadata and publishUMMGJSON2CMR if if json metadata present and publish true', async (t) => {
  // arrange
  const jsonCMRFile = { filename: 'cmrmeta.cmr.json' };
  const updatedFiles = [{ filename: 'anotherfile' }, jsonCMRFile];
  const {
    granuleId,
    distEndpoint,
    published
  } = t.context;

  const defaultBucketsConfig = { private: { type: 'private', name: 'private' } };
  const fakeBucketsConfigJsonObject = sinon.fake.returns(defaultBucketsConfig);
  const restoreBucketsConfigDefaults = cmrUtils.__set__('bucketsConfigJsonObject', fakeBucketsConfigJsonObject);

  const fakeUpdateUMMGMetadata = sinon.fake.resolves({ fake: 'metadata' });
  const restoreUpdateUMMGMetadata = cmrUtils.__set__('updateUMMGMetadata', fakeUpdateUMMGMetadata);

  const fakePublishUMMGJSON2CMR = sinon.fake.resolves({ });
  const restorePublishUMMGJSON2CMR = cmrUtils.__set__('publishUMMGJSON2CMR', fakePublishUMMGJSON2CMR);

  const publishObject = {
    filename: jsonCMRFile.filename,
    metadataObject: { fake: 'metadata' },
    granuleId
  };

  const buckets = new BucketsConfig(defaultBucketsConfig);
  const systemBucket = randomId('systembucket');
  const stackName = randomId('stackname');
  process.env.system_bucket = systemBucket;
  process.env.stackName = stackName;

  const cmrClient = {};

  // act
  await cmrUtils.reconcileCMRMetadata({
    cmrClient,
    granuleId,
    updatedFiles,
    distEndpoint,
    published
  });

  const paramsIntoUpdateUMMG = {
    cmrFile: updatedFiles[1],
    files: updatedFiles,
    distEndpoint,
    cmrGranuleUrlType: 'distribution',
    buckets
  };

  // assert
  t.deepEqual(paramsIntoUpdateUMMG, fakeUpdateUMMGMetadata.firstCall.args[0]);
  t.true(fakeUpdateUMMGMetadata.calledOnce);
  t.true(
    fakePublishUMMGJSON2CMR.calledOnceWithExactly(publishObject, cmrClient)
  );

  // cleanup
  sinon.restore();
  restoreUpdateUMMGMetadata();
  restorePublishUMMGJSON2CMR();
  restoreBucketsConfigDefaults();
});

test('updateCMRMetadata file throws error if incorrect cmrfile provided', async (t) => {
  const updatedFiles = [{ filename: 'anotherfile' }, { filename: 'cmrmeta.cmr.json' }];
  const badCMRFile = { filename: 'notreallycmrfile' };
  const {
    granuleId,
    distEndpoint,
    published
  } = t.context;
  const updateCMRMetadata = cmrUtils.__get__('updateCMRMetadata');

  const cmrClient = {};

  await t.throwsAsync(
    () => updateCMRMetadata({
      cmrClient,
      granuleId,
      cmrFile: badCMRFile,
      files: updatedFiles,
      distEndpoint,
      published,
      inBuckets: 'fakebucket'
    }),
    {
      name: 'CMRMetaFileNotFound',
      message: 'Invalid CMR filetype passed to updateCMRMetadata'
    }
  );
});

test('publishUMMGJSON2CMR calls ingestUMMGranule with ummgMetadata via valid CMR object', async (t) => {
  const cmrPublishObject = {
    filename: 'cmrfilename',
    metadataObject: {
      fake: 'metadata',
      GranuleUR: 'fakeGranuleID'
    },
    granuleId: 'fakeGranuleID'
  };

  const publishUMMGJSON2CMR = cmrUtils.__get__('publishUMMGJSON2CMR');

  let ingestUMMGranuleCalled = false;

  const cmrClient = {
    async ingestUMMGranule(...args) {
      ingestUMMGranuleCalled = true;

      t.deepEqual(args, [cmrPublishObject.metadataObject]);

      return { result: { 'concept-id': 'fakeID' } };
    }
  };

  await publishUMMGJSON2CMR(cmrPublishObject, cmrClient);

  t.true(ingestUMMGranuleCalled);
});
