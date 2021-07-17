const fs = require('fs');
const difference = require('lodash/difference');
const {
  addCollections,
  addProviders,
  cleanupCollections,
  cleanupProviders,
  waitForCompletedExecution,
  waitForTestExecutionStart,
} = require('@cumulus/integration-tests');
const { updateCollection } = require('@cumulus/integration-tests/api/api');
const { Granule } = require('@cumulus/api/models');
const { deleteExecution } = require('@cumulus/api-client/executions');
const { getGranule, reingestGranule } = require('@cumulus/api-client/granules');
const { s3 } = require('@cumulus/aws-client/services');
const {
  s3GetObjectTagging,
  s3Join,
  s3ObjectExists,
  parseS3Uri,
} = require('@cumulus/aws-client/S3');
const { constructCollectionId } = require('@cumulus/message/Collections');
const { LambdaStep } = require('@cumulus/integration-tests/sfnStep');
const { getExecution } = require('@cumulus/api-client/executions');

const { buildAndExecuteWorkflow } = require('../../helpers/workflowUtils');
const { waitForApiStatus } = require('../../helpers/apiUtils');
const {
  loadConfig,
  templateFile,
  uploadTestDataToBucket,
  createTimestampedTestId,
  createTestDataPath,
  createTestSuffix,
  deleteFolder,
  getFilesMetadata,
} = require('../../helpers/testUtils');
const {
  setupTestGranuleForIngest,
  loadFileWithUpdatedGranuleIdPathAndCollection,
  waitForGranuleAndDelete,
} = require('../../helpers/granuleUtils');
const { isReingestExecutionForGranuleId } = require('../../helpers/workflowUtils');
const { waitForModelStatus } = require('../../helpers/apiUtils');

const workflowName = 'SyncGranule';
const providersDir = './data/providers/s3/';
const collectionsDir = './data/collections/s3_MOD09GQ_006';

describe('The Sync Granules workflow', () => {
  let collection;
  let config;
  let expectedPayload;
  let expectedS3TagSet;
  let failingExecutionArn;
  let granuleModel;
  let inputPayload;
  let lambdaStep;
  let provider;
  let reingestGranuleExecutionArn;
  let syncGranuleExecutionArn;
  let testDataFolder;
  let testSuffix;
  let workflowExecution;

  beforeAll(async () => {
    config = await loadConfig();
    lambdaStep = new LambdaStep();

    process.env.GranulesTable = `${config.stackName}-GranulesTable`;
    granuleModel = new Granule();

    const granuleRegex = '^MOD09GQ\\.A[\\d]{7}\\.[\\w]{6}\\.006\\.[\\d]{13}$';

    const s3data = [
      '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf.met',
      '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf',
    ];

    const testId = createTimestampedTestId(config.stackName, 'SyncGranuleSuccess');
    testSuffix = createTestSuffix(testId);
    testDataFolder = createTestDataPath(testId);

    const inputPayloadFilename = './spec/parallel/syncGranule/SyncGranule.input.payload.json';

    collection = { name: `MOD09GQ${testSuffix}`, version: '006' };
    provider = { id: `s3_provider${testSuffix}` };
    const newCollectionId = constructCollectionId(collection.name, collection.version);

    // populate collections, providers and test data
    await Promise.all([
      uploadTestDataToBucket(config.bucket, s3data, testDataFolder),
      addCollections(config.stackName, config.bucket, collectionsDir, testSuffix),
      addProviders(config.stackName, config.bucket, providersDir, config.bucket, testSuffix),
    ]);
    await updateCollection({
      prefix: config.stackName,
      collection,
      updateParams: { duplicateHandling: 'replace' },
    });

    const inputPayloadJson = fs.readFileSync(inputPayloadFilename, 'utf8');
    // update test data filepaths
    inputPayload = await setupTestGranuleForIngest(config.bucket, inputPayloadJson, granuleRegex, testSuffix, testDataFolder);
    inputPayload.granules[0].files[0] = Object.assign(inputPayload.granules[0].files[0], { checksum: '8d1ec5c0463e59d26adee87cdbbee816', checksumType: 'md5' });
    const newGranuleId = inputPayload.granules[0].granuleId;
    expectedS3TagSet = [{ Key: 'granuleId', Value: newGranuleId }];
    await Promise.all(inputPayload.granules[0].files.map((fileToTag) =>
      s3().putObjectTagging({ Bucket: config.bucket, Key: `${fileToTag.path}/${fileToTag.name}`, Tagging: { TagSet: expectedS3TagSet } }).promise()));

    const templatedOutputPayloadFilename = templateFile({
      inputTemplateFilename: './spec/parallel/syncGranule/SyncGranule.output.payload.template.json',
      config: {
        granules: [
          {
            files: [
              {
                bucket: config.buckets.internal.name,
                filename: `s3://${config.buckets.internal.name}/custom-staging-dir/${config.stackName}/replace-me-collectionId/replace-me-granuleId.hdf`,
                fileStagingDir: `custom-staging-dir/${config.stackName}/replace-me-collectionId`,
              },
              {
                bucket: config.buckets.internal.name,
                filename: `s3://${config.buckets.internal.name}/custom-staging-dir/${config.stackName}/replace-me-collectionId/replace-me-granuleId.hdf.met`,
                fileStagingDir: `custom-staging-dir/${config.stackName}/replace-me-collectionId`,
              },
            ],
          },
        ],
      },
    });

    expectedPayload = loadFileWithUpdatedGranuleIdPathAndCollection(
      templatedOutputPayloadFilename,
      newGranuleId,
      testDataFolder,
      newCollectionId,
      config.stackName
    );

    expectedPayload.granules[0].dataType += testSuffix;
    expectedPayload.granules[0].files[0] = Object.assign(expectedPayload.granules[0].files[0], { checksum: '8d1ec5c0463e59d26adee87cdbbee816', checksumType: 'md5' });

    workflowExecution = await buildAndExecuteWorkflow(
      config.stackName, config.bucket, workflowName, collection, provider, inputPayload
    );

    syncGranuleExecutionArn = workflowExecution.executionArn;
  });

  afterAll(async () => {
    // clean up stack state added by test
    await Promise.all(inputPayload.granules.map(
      async (granule) => {
        await waitForGranuleAndDelete(
          config.stackName,
          granule.granuleId,
          ['completed', 'failed']
        );
      }
    ));

    await Promise.all([
      deleteExecution({ prefix: config.stackName, executionArn: syncGranuleExecutionArn }),
      deleteExecution({ prefix: config.stackName, executionArn: reingestGranuleExecutionArn }),
      deleteExecution({ prefix: config.stackName, executionArn: failingExecutionArn }),
    ]);

    await Promise.all([
      deleteFolder(config.bucket, testDataFolder),
      cleanupCollections(config.stackName, config.bucket, collectionsDir, testSuffix),
      cleanupProviders(config.stackName, config.bucket, providersDir, testSuffix),
    ]);
  });

  it('has a checksum to test', () => {
    expect(inputPayload.granules[0].files[0].checksum).toBeDefined();
    expect(inputPayload.granules[0].files[0].checksumType).toBeDefined();
  });

  it('completes execution with success status', () => {
    expect(workflowExecution.status).toEqual('completed');
  });

  describe('the SyncGranule Lambda function', () => {
    let lambdaOutput;
    let files;
    let key1;
    let key2;
    let syncedTaggings;
    let existCheck = [];

    beforeAll(async () => {
      lambdaOutput = await lambdaStep.getStepOutput(workflowExecution.executionArn, 'SyncGranule');
      files = lambdaOutput.payload.granules[0].files;
      key1 = s3Join(files[0].fileStagingDir, files[0].name);
      key2 = s3Join(files[1].fileStagingDir, files[1].name);

      existCheck = await Promise.all([
        s3ObjectExists({ Bucket: files[0].bucket, Key: key1 }),
        s3ObjectExists({ Bucket: files[1].bucket, Key: key2 }),
      ]);
      syncedTaggings = await Promise.all(files.map((file) => {
        const { Bucket, Key } = parseS3Uri(file.filename);
        return s3GetObjectTagging(Bucket, Key);
      }));
    });

    it('receives payload with file objects updated to include file staging location', () => {
      const thisExpectedPayload = {
        ...expectedPayload,
        granules: [
          {
            ...expectedPayload.granules[0],
            sync_granule_duration: lambdaOutput.payload.granules[0].sync_granule_duration,
          },
        ],
      };

      expect(lambdaOutput.payload).toEqual(thisExpectedPayload);
    });

    it('receives meta.input_granules with files objects updated to include file staging location', () => {
      const thisExpectedGranules = [
        {
          ...expectedPayload.granules[0],
          sync_granule_duration: lambdaOutput.payload.granules[0].sync_granule_duration,
        },
      ];

      expect(lambdaOutput.meta.input_granules).toEqual(thisExpectedGranules);
    });

    it('receives files with custom staging directory', () => {
      files.forEach((file) => {
        expect(file.fileStagingDir).toMatch('custom-staging-dir\/.*');
      });
    });

    it('adds files to staging location', () => {
      existCheck.forEach((check) => {
        expect(check).toEqual(true);
      });
    });

    it('preserves S3 tags on provider files', () => {
      syncedTaggings.forEach((tagging) => {
        expect(tagging.TagSet).toEqual(expectedS3TagSet);
      });
    });

    it('maintains tested checksums', () => {
      expect(lambdaOutput.payload.granules[0].files[0].checksum).toBeDefined();
      expect(lambdaOutput.payload.granules[0].files[0].checksumType).toBeDefined();
    });
  });

  describe('the reporting lambda has received the CloudWatch step function event and', () => {
    it('the execution record is added to DynamoDB', async () => {
      const record = await waitForApiStatus(
        getExecution,
        {
          prefix: config.stackName,
          arn: workflowExecution.executionArn,
        },
        'completed'
      );
      expect(record.status).toEqual('completed');
    });
  });

  describe('when a reingest granule is triggered via the API', () => {
    let oldExecution;
    let oldUpdatedAt;
    let reingestResponse;
    let syncGranuleTaskOutput;
    let granule;

    beforeAll(async () => {
      granule = await getGranule({
        prefix: config.stackName,
        granuleId: inputPayload.granules[0].granuleId,
      });

      oldUpdatedAt = granule.updatedAt;
      oldExecution = granule.execution;
      const reingestGranuleResponse = await reingestGranule({
        prefix: config.stackName,
        granuleId: inputPayload.granules[0].granuleId,
      });
      reingestResponse = JSON.parse(reingestGranuleResponse.body);
    });

    it('executes successfully', () => {
      expect(reingestResponse.status).toEqual('SUCCESS');
    });

    it('does not return a warning that data may be overwritten when duplicateHandling is "replace"', () => {
      expect(reingestResponse.warning).toBeFalsy();
    });

    it('overwrites granule files', async () => {
      // Await reingest completion
      const reingestGranuleExecution = await waitForTestExecutionStart({
        workflowName,
        stackName: config.stackName,
        bucket: config.bucket,
        findExecutionFn: isReingestExecutionForGranuleId,
        findExecutionFnParams: { granuleId: inputPayload.granules[0].granuleId },
        startTask: 'SyncGranule',
      });

      reingestGranuleExecutionArn = reingestGranuleExecution.executionArn;

      console.log(`Wait for completed execution ${reingestGranuleExecutionArn}`);

      await waitForCompletedExecution(reingestGranuleExecutionArn);

      syncGranuleTaskOutput = await lambdaStep.getStepOutput(
        reingestGranuleExecutionArn,
        'SyncGranule'
      );

      syncGranuleTaskOutput.payload.granules[0].files.forEach((f) => {
        expect(f.duplicate_found).toBeTrue();
      });

      await waitForModelStatus(
        granuleModel,
        { granuleId: inputPayload.granules[0].granuleId },
        'completed'
      );

      const updatedGranule = await getGranule({
        prefix: config.stackName,
        granuleId: inputPayload.granules[0].granuleId,
      });
      expect(updatedGranule.status).toEqual('completed');
      expect(updatedGranule.updatedAt).toBeGreaterThan(oldUpdatedAt);
      expect(updatedGranule.execution).not.toEqual(oldExecution);

      // the updated granule has the same files
      const oldFileNames = granule.files.map((f) => f.filename);
      const newFileNames = updatedGranule.files.map((f) => f.filename);
      expect(difference(oldFileNames, newFileNames).length).toBe(0);

      const currentFiles = await getFilesMetadata(updatedGranule.files);
      currentFiles.forEach((cf) => {
        expect(cf.LastModified).toBeGreaterThan(reingestGranuleExecution.startDate);
      });
    });
  });

  describe('when a bad checksum is provided', () => {
    let lambdaOutput;
    let failingExecution;

    beforeAll(async () => {
      inputPayload.granules[0].files[0].checksum = 'badCheckSum01';
      failingExecution = await buildAndExecuteWorkflow(
        config.stackName, config.bucket, workflowName, collection, provider, inputPayload
      );
      failingExecutionArn = failingExecution.executionArn;

      lambdaOutput = await lambdaStep.getStepOutput(failingExecution.executionArn, 'SyncGranule', 'failure');
    });

    it('completes execution with failure status', () => {
      expect(failingExecution.status).toEqual('failed');
    });

    it('raises an error', () => {
      expect(lambdaOutput.error).toEqual('InvalidChecksum');
    });
  });
});
