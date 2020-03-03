'use strict';

const { LambdaStep } = require('@cumulus/integration-tests/sfnStep');
const { deleteGranule } = require('@cumulus/integration-tests/api/granules');

const {
  api: apiTestUtils,
  addCollections,
  addProviders,
  buildAndExecuteWorkflow,
  cleanupCollections,
  cleanupProviders,
  waitForCompletedExecution
} = require('@cumulus/integration-tests');

const {
  loadConfig,
  createTimestampedTestId,
  createTestSuffix
} = require('../../helpers/testUtils');

const workflowName = 'DiscoverGranules';
jasmine.DEFAULT_TIMEOUT_INTERVAL = 2000000;

const updateCollectionDuplicateFlag = async (flag, collection, config) => {
  await apiTestUtils.updateCollection({
    prefix: config.stackName,
    collection,
    updateParams: {
      duplicateHandling: flag
    }
  });
};

const awaitIngestExecutions = async (workflowExecution, lambdaStep) => {
  const lambdaOutput = await lambdaStep.getStepOutput(
    workflowExecution.executionArn, 'QueueGranules'
  );
  const ingestExecutions = lambdaOutput.payload.running.map((e) => waitForCompletedExecution(e));
  return Promise.all(ingestExecutions);
};

describe('The Discover Granules workflow with http Protocol', () => {
  const providersDir = './data/providers/http/';
  const collectionsDir = './data/collections/http_testcollection_001/';

  let collection;
  let config;
  let lambdaStep;
  let provider;
  let testId;
  let testSuffix;

  beforeAll(async () => {
    lambdaStep = new LambdaStep();
    config = await loadConfig();

    process.env.ExecutionsTable = `${config.stackName}-ExecutionsTable`;
    testId = createTimestampedTestId(config.stackName, 'DiscoverGranulesDuplicate');
    testSuffix = createTestSuffix(testId);
    collection = { name: `http_testcollection${testSuffix}`, version: '001' };
    provider = { id: `http_provider${testSuffix}` };

    await Promise.all([
      addCollections(config.stackName, config.bucket, collectionsDir, testSuffix),
      addProviders(config.stackName, config.bucket, providersDir, null, testSuffix)
    ]);

    collection = JSON.parse((await apiTestUtils.getCollection({
      prefix: config.stackName,
      collectionName: collection.name,
      collectionVersion: collection.version
    })).body);
  });

  afterAll(async () => {
    await Promise.all([
      cleanupCollections(config.stackName, config.bucket, collectionsDir, testSuffix),
      cleanupProviders(config.stackName, config.bucket, providersDir, testSuffix)
    ]);
  });


  describe('when the collection configured with duplicateHandling set to "skip" it:', () => {
    let ingestStatus;
    let httpWorkflowExecution;
    let originalHttpWorkflowExecution;
    beforeAll(async () => {
      await updateCollectionDuplicateFlag('replace', collection, config);

      originalHttpWorkflowExecution = await buildAndExecuteWorkflow(config.stackName,
        config.bucket, workflowName, collection, provider);

      ingestStatus = await awaitIngestExecutions(originalHttpWorkflowExecution, lambdaStep);

      deleteGranule({ prefix: config.stackName, granuleId: 'granule-1' });

      await updateCollectionDuplicateFlag('skip', collection, config);

      httpWorkflowExecution = await buildAndExecuteWorkflow(config.stackName,
        config.bucket, workflowName, collection, provider);
    });

    it('executes initial ingest successfully', () => {
      expect(originalHttpWorkflowExecution.status).toEqual('SUCCEEDED');
      expect(ingestStatus.every((e) => e === 'SUCCEEDED')).toEqual(true);
    });

    it('recieves an event with duplicateHandling set to skip', async () => {
      const lambdaInput = await lambdaStep.getStepInput(
        httpWorkflowExecution.executionArn, 'DiscoverGranules'
      );
      expect(lambdaInput.meta.collection.duplicateHandling).toEqual('skip');
    });

    it('executes successfully', () => {
      expect(httpWorkflowExecution.status).toEqual('SUCCEEDED');
    });

    it('discovers granules, but skips the granules as duplicates', async () => {
      const lambdaOutput = await lambdaStep.getStepOutput(
        httpWorkflowExecution.executionArn, 'DiscoverGranules'
      );
      expect(lambdaOutput.payload.granules.length).toEqual(1);
    });

    it('queues only one granule', async () => {
      const lambdaOutput = await lambdaStep.getStepOutput(
        httpWorkflowExecution.executionArn, 'QueueGranules'
      );
      expect(lambdaOutput.payload.running.length).toEqual(1);
    });
  });

  describe('when the collection configured with duplicateHandling set to "error" it:', () => {
    let ingestStatus;
    let httpWorkflowExecution;
    let originalHttpWorkflowExecution;
    beforeAll(async () => {
      await updateCollectionDuplicateFlag('replace', collection, config);

      originalHttpWorkflowExecution = await buildAndExecuteWorkflow(config.stackName,
        config.bucket, workflowName, collection, provider);

      ingestStatus = await awaitIngestExecutions(originalHttpWorkflowExecution, lambdaStep);

      await updateCollectionDuplicateFlag('error', collection, config);

      httpWorkflowExecution = await buildAndExecuteWorkflow(config.stackName,
        config.bucket, workflowName, collection, provider);
    });

    it('executes initial ingest successfully', () => {
      expect(originalHttpWorkflowExecution.status).toEqual('SUCCEEDED');
      expect(ingestStatus.every((e) => e === 'SUCCEEDED')).toEqual(true);
    });

    it('recieves an event with duplicateHandling set to error', async () => {
      const lambdaInput = await lambdaStep.getStepInput(
        httpWorkflowExecution.executionArn, 'DiscoverGranules'
      );
      expect(lambdaInput.meta.collection.duplicateHandling).toEqual('error');
    });

    it('fails', () => {
      expect(httpWorkflowExecution.status).toEqual('FAILED');
    });

    it('has the expected error', async () => {
      const lambdaOutput = await lambdaStep.getStepOutput(
        httpWorkflowExecution.executionArn, 'DiscoverGranules', 'failure'
      );
      const expectedSubString = 'Duplicate granule found';
      expect(JSON.parse(lambdaOutput.cause).errorMessage).toContain(expectedSubString);
    });
  });
});
