'use strict';

const pWaitFor = require('p-wait-for');
const {
  buildAndExecuteWorkflow,
  getExecutionInputObject,
  loadCollection,
  loadProvider,
  waitForCompletedExecution,
} = require('@cumulus/integration-tests');
const { LambdaStep } = require('@cumulus/integration-tests/sfnStep');
const {
  createCollection, deleteCollection,
} = require('@cumulus/api-client/collections');
const { getExecution, deleteExecution } = require('@cumulus/api-client/executions');
const {
  createProvider, deleteProvider,
} = require('@cumulus/api-client/providers');
const { deleteGranule } = require('@cumulus/api-client/granules');
const {
  createTimestampedTestId,
  deleteFolder,
  loadConfig,
  updateAndUploadTestDataToBucket,
} = require('../../helpers/testUtils');

describe('The DiscoverGranules workflow', () => {
  let beforeAllCompleted = false;
  let bucket;
  let collection;
  let expectedGranuleId;
  let parentExecutionArn;
  let provider;
  let providerPath;
  let queueGranulesOutput;
  let stackName;
  let workflowExecution;

  beforeAll(async () => {
    ({ stackName, bucket } = await loadConfig());

    process.env.stackName = stackName;
    process.env.system_bucket = bucket;

    process.env.ProvidersTable = `${stackName}-ProvidersTable`;

    const testId = createTimestampedTestId(stackName, 'DiscoverGranuleS3Success');
    expectedGranuleId = 'MOD09GQ.A2016358.h13v04.006.2016360104606';

    // Create the provider
    provider = await loadProvider({
      filename: './data/providers/s3/s3_provider.json',
      postfix: testId,
      s3Host: bucket,
    });
    await createProvider({ prefix: stackName, provider });

    // Create the collection
    collection = await loadCollection({
      filename: './data/collections/s3_MOD09GQ_006/s3_MOD09GQ_006.json',
      postfix: testId,
    });

    await createCollection({ prefix: stackName, collection });

    providerPath = `cumulus-test-data/${testId}`;

    // Upload the granule to be discovered
    await updateAndUploadTestDataToBucket(
      bucket,
      [
        '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf.met',
        '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf',
        '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606_ndvi.jpg',
      ],
      providerPath
    );

    // Execute the DiscoverGranules workflow
    workflowExecution = await buildAndExecuteWorkflow(
      stackName,
      bucket,
      'DiscoverGranules',
      collection,
      provider,
      undefined,
      { provider_path: providerPath }
    );

    // Get the output of the QueueGranules task. Doing it here because there are
    // two tests that need it.
    queueGranulesOutput = await (new LambdaStep()).getStepOutput(
      workflowExecution.executionArn,
      'QueueGranules'
    );

    beforeAllCompleted = true;
  });

  afterAll(async () => {
    await deleteGranule({ prefix: stackName, granuleId: expectedGranuleId });
    // The order of execution deletes matters. Parents must be deleted before children.
    await deleteExecution({ prefix: stackName, executionArn: parentExecutionArn });
    await deleteExecution({ prefix: stackName, executionArn: workflowExecution.executionArn });
    await Promise.all([
      deleteFolder(bucket, providerPath),
      deleteCollection({
        prefix: stackName,
        collectionName: collection.name,
        collectionVersion: collection.version,
      }),
      deleteProvider({
        prefix: stackName,
        provider: provider.id,
      }),
    ]);
  });

  it('executes successfully', () => {
    if (!beforeAllCompleted) fail('beforeAll() failed');
    else expect(workflowExecution.status).toEqual('SUCCEEDED');
  });

  it('can be fetched from the API', async () => {
    if (!beforeAllCompleted) fail('beforeAll() failed');
    else {
      await expectAsync(
        pWaitFor(
          async () => {
            const { status } = await getExecution({
              prefix: stackName,
              arn: workflowExecution.executionArn,
            });

            return status === 'completed';
          },
          { interval: 2000, timeout: 60000 }
        )
      ).toBeResolved();
    }
  });

  it('results in a successful IngestGranule workflow execution', async () => {
    if (!beforeAllCompleted) fail('beforeAll() failed');
    else {
      const ingestGranuleExecutionStatus = await waitForCompletedExecution(
        queueGranulesOutput.payload.running[0]
      );
      expect(ingestGranuleExecutionStatus).toEqual('SUCCEEDED');
    }
  });

  describe('DiscoverGranules task', () => {
    let discoverGranulesOutput;

    afterAll(async () => {
      await Promise.all(discoverGranulesOutput.payload.granules.map(
        (granule) => deleteGranule({
          prefix: stackName,
          granuleId: granule.granuleId,
        })
      ));
    });

    it('outputs the list of discovered granules', async () => {
      if (!beforeAllCompleted) fail('beforeAll() failed');
      else {
        discoverGranulesOutput = await (new LambdaStep()).getStepOutput(
          workflowExecution.executionArn,
          'DiscoverGranules'
        );

        expect(discoverGranulesOutput.payload.granules.length).toEqual(1);
        const granule = discoverGranulesOutput.payload.granules[0];
        expect(granule.granuleId).toEqual(expectedGranuleId);
        expect(granule.dataType).toEqual(collection.name);
        expect(granule.version).toEqual(collection.version);
        expect(granule.files.length).toEqual(3);
      }
    });
  });

  describe('QueueGranules task', () => {
    it('has queued the granule', () => {
      if (!beforeAllCompleted) fail('beforeAll() failed');
      else expect(queueGranulesOutput.payload.running.length).toEqual(1);
    });

    it('passes through childWorkflowMeta to the IngestGranule execution', async () => {
      parentExecutionArn = queueGranulesOutput.payload.running[0];
      const executionInput = await getExecutionInputObject(queueGranulesOutput.payload.running[0]);
      expect(executionInput.meta.staticValue).toEqual('aStaticValue');
      expect(executionInput.meta.interpolatedValueStackName).toEqual(queueGranulesOutput.meta.stack);
    });
  });
});
