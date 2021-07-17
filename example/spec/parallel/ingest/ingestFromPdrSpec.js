'use strict';

/**
 * End to end ingest from discovering a PDR
 *
 * Kick off discover and queue pdrs which:
 * Discovers 1 PDR
 * Queues that PDR
 * Kicks off the ParsePDR workflow
 *
 * Parse PDR workflow:
 * parses pdr
 * queues a granule
 * pdr status check
 * This will kick off the ingest workflow
 *
 * Ingest workflow:
 * runs sync granule - saves file to file staging location
 * performs the fake processing step - generates CMR metadata
 * Moves the file to the final location
 * Does not post to CMR (that is in a separate test)
 */

const flatten = require('lodash/flatten');
const cryptoRandomString = require('crypto-random-string');

const { deleteS3Object, s3ObjectExists } = require('@cumulus/aws-client/S3');
const { s3 } = require('@cumulus/aws-client/services');
const { LambdaStep } = require('@cumulus/integration-tests/sfnStep');
const { getPdr } = require('@cumulus/api-client/pdrs');
const { deleteExecution } = require('@cumulus/api-client/executions');

const {
  addCollections,
  addProviders,
  api: apiTestUtils,
  executionsApi: executionsApiTestUtils,
  cleanupProviders,
  cleanupCollections,
  waitForCompletedExecution,
} = require('@cumulus/integration-tests');

const { getExecution } = require('@cumulus/api-client/executions');
const { waitForApiStatus } = require('../../helpers/apiUtils');

const {
  createTestDataPath,
  createTestSuffix,
  createTimestampedTestId,
  deleteFolder,
  getExecutionUrl,
  loadConfig,
  updateAndUploadTestFileToBucket,
  updateAndUploadTestDataToBucket,
} = require('../../helpers/testUtils');
const { buildAndExecuteWorkflow } = require('../../helpers/workflowUtils');
const {
  loadFileWithUpdatedGranuleIdPathAndCollection,
  waitForGranuleAndDelete,
} = require('../../helpers/granuleUtils');

const lambdaStep = new LambdaStep();
const workflowName = 'DiscoverAndQueuePdrs';
const origPdrFilename = 'MOD09GQ_1granule_v3.PDR';
const granuleDateString = '2016360104606';
const granuleIdReplacement = cryptoRandomString({ length: 13, type: 'numeric' });

const s3data = [
  '@cumulus/test-data/pdrs/MOD09GQ_1granule_v3.PDR',
];

const unmodifiedS3Data = [
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf.met',
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf',
];
const testDataGranuleId = 'MOD09GQ.A2016358.h13v04.006.2016360104606'.replace(granuleDateString, granuleIdReplacement);

describe('Ingesting from PDR', () => {
  const providersDir = './data/providers/s3/';
  const collectionsDir = './data/collections/s3_MOD09GQ_006';

  let beforeAllFailed;
  let config;
  let parsePdrExecutionArn;
  let pdrFilename;
  let provider;
  let testDataFolder;
  let testSuffix;
  let workflowExecution;
  let addedCollections;
  let ingestGranuleExecution;

  beforeAll(async () => {
    try {
      config = await loadConfig();

      const testId = createTimestampedTestId(config.stackName, 'IngestFromPdr');
      testSuffix = createTestSuffix(testId);
      testDataFolder = createTestDataPath(testId);

      pdrFilename = `${testSuffix.slice(1)}_${origPdrFilename}`;

      provider = { id: `s3_provider${testSuffix}` };

      // populate collections, providers and test data
      [addedCollections] = await Promise.all(
        flatten([
          addCollections(config.stackName, config.bucket, collectionsDir, testSuffix, testId),
          updateAndUploadTestDataToBucket(
            config.bucket,
            s3data,
            testDataFolder,
            [
              { old: 'cumulus-test-data/pdrs', new: testDataFolder },
              { old: 'DATA_TYPE = MOD09GQ;', new: `DATA_TYPE = MOD09GQ${testSuffix};` },
              { old: granuleDateString, new: granuleIdReplacement },
            ]
          ),
          unmodifiedS3Data.map((file) => updateAndUploadTestFileToBucket({
            file,
            bucket: config.bucket,
            prefix: testDataFolder,
            targetReplacementRegex: granuleDateString,
            targetReplacementString: granuleIdReplacement,
          })),
          addProviders(config.stackName, config.bucket, providersDir, config.bucket, testSuffix),
        ])
      );

      // Rename the PDR to avoid race conditions
      await s3().copyObject({
        Bucket: config.bucket,
        CopySource: `${config.bucket}/${testDataFolder}/${origPdrFilename}`,
        Key: `${testDataFolder}/${pdrFilename}`,
      }).promise();

      await deleteS3Object(config.bucket, `${testDataFolder}/${origPdrFilename}`);
    } catch (error) {
      beforeAllFailed = error;
    }
  });

  afterAll(async () => {
    // clean up stack state added by test
    await waitForGranuleAndDelete(
      config.stackName,
      testDataGranuleId,
      'completed'
    );
    await apiTestUtils.deletePdr({
      prefix: config.stackName,
      pdr: pdrFilename,
    });
    // The order of execution deletes matters. Parents must be deleted before children.
    await deleteExecution({ prefix: config.stackName, executionArn: parsePdrExecutionArn });
    await deleteExecution({ prefix: config.stackName, executionArn: workflowExecution.executionArn });
    await Promise.all([
      deleteFolder(config.bucket, testDataFolder),
      cleanupCollections(config.stackName, config.bucket, collectionsDir, testSuffix),
      cleanupProviders(config.stackName, config.bucket, providersDir, testSuffix),
    ]);
  });

  describe('The Discover and Queue PDRs workflow', () => {
    let queuePdrsOutput;

    beforeAll(async () => {
      try {
        workflowExecution = await buildAndExecuteWorkflow(
          config.stackName,
          config.bucket,
          workflowName,
          { name: addedCollections[0].name, version: addedCollections[0].version },
          provider,
          undefined,
          { provider_path: testDataFolder }
        );

        queuePdrsOutput = await lambdaStep.getStepOutput(
          workflowExecution.executionArn,
          'QueuePdrs'
        );
      } catch (error) {
        beforeAllFailed = error;
      }
    });

    it('executes successfully', () => {
      if (beforeAllFailed) fail(beforeAllFailed);
      else {
        expect(workflowExecution.status).toEqual('completed');
      }
    });

    describe('the DiscoverPdrs Lambda', () => {
      let lambdaOutput;

      beforeAll(async () => {
        try {
          lambdaOutput = await lambdaStep.getStepOutput(workflowExecution.executionArn, 'DiscoverPdrs');
        } catch (error) {
          beforeAllFailed = error;
        }
      });

      it('has expected path and name output', () => {
        if (beforeAllFailed) fail(beforeAllFailed);
        else {
          expect(lambdaOutput.payload.pdrs[0].path).toEqual(testDataFolder);
          expect(lambdaOutput.payload.pdrs[0].name).toEqual(pdrFilename);
        }
      });
    });

    describe('the QueuePdrs Lambda', () => {
      if (beforeAllFailed) fail(beforeAllFailed);
      else {
        it('has expected output', () => {
          expect(queuePdrsOutput.payload.pdrs_queued).toEqual(1);
          expect(queuePdrsOutput.payload.running.length).toEqual(1);
        });
      }
    });

    /**
     * The DiscoverAndQueuePdrs workflow kicks off a ParsePdr workflow, so check that the
     * ParsePdr workflow completes successfully. Above, we checked that there is
     * one running task, which is the ParsePdr workflow. The payload has the arn of the
     * running workflow, so use that to get the status.
     */
    describe('The ParsePdr workflow', () => {
      let parsePdrExecutionStatus;
      let parseLambdaOutput;
      let queueGranulesOutput;
      let expectedParsePdrOutput;
      let ingestGranuleWorkflowArn;

      const outputPayloadFilename = './spec/parallel/ingest/resources/ParsePdr.output.json';
      const collectionId = 'MOD09GQ___006';

      beforeAll(() => {
        parsePdrExecutionArn = queuePdrsOutput.payload.running[0];

        try {
          expectedParsePdrOutput = loadFileWithUpdatedGranuleIdPathAndCollection(
            outputPayloadFilename,
            testDataGranuleId,
            testDataFolder,
            collectionId
          );
          expectedParsePdrOutput.granules[0].dataType += testSuffix;
          expectedParsePdrOutput.granules[0].granuleId =
            expectedParsePdrOutput.granules[0].granuleId.replace(
              granuleDateString,
              granuleIdReplacement
            );
          expectedParsePdrOutput.granules[0].files = expectedParsePdrOutput.granules[0].files.map((file) => {
            file.name = file.name.replace(granuleDateString, granuleIdReplacement);
            return file;
          });
          expectedParsePdrOutput.pdr.name = pdrFilename;
        } catch (error) {
          beforeAllFailed = error;
        }
      });

      afterAll(async () => {
        // wait for child executions to complete
        await Promise.all(
          queueGranulesOutput.payload.running
            .map((arn) => waitForCompletedExecution(arn))
        );
      });

      it('executes successfully', async () => {
        if (beforeAllFailed) fail(beforeAllFailed);
        else {
          console.log(`Wait for execution ${parsePdrExecutionArn}`);
          parsePdrExecutionStatus = await waitForCompletedExecution(parsePdrExecutionArn);
          expect(parsePdrExecutionStatus).toEqual('SUCCEEDED');
        }
      });

      describe('ParsePdr lambda function', () => {
        if (beforeAllFailed) fail(beforeAllFailed);
        else {
          it('successfully parses a granule from the PDR', async () => {
            parseLambdaOutput = await lambdaStep.getStepOutput(
              parsePdrExecutionArn,
              'ParsePdr'
            );
            expect(parseLambdaOutput.payload.granules).toEqual(expectedParsePdrOutput.granules);
          });
        }
      });

      describe('QueueGranules lambda function', () => {
        it('has expected pdr and arns output', async () => {
          if (beforeAllFailed) fail(beforeAllFailed);
          else {
            queueGranulesOutput = await lambdaStep.getStepOutput(
              parsePdrExecutionArn,
              'QueueGranules'
            );

            expect(queueGranulesOutput.payload.running.length).toEqual(1);

            expect(queueGranulesOutput.payload.pdr.path).toEqual(expectedParsePdrOutput.pdr.path);
            expect(queueGranulesOutput.payload.pdr.name).toEqual(expectedParsePdrOutput.pdr.name);
          }
        });
      });

      describe('PdrStatusCheck lambda function', () => {
        let lambdaOutput;

        beforeAll(async () => {
          lambdaOutput = await lambdaStep.getStepOutput(
            parsePdrExecutionArn,
            'PdrStatusCheck'
          );
        });

        it('has expected output', () => {
          if (beforeAllFailed) fail(beforeAllFailed);
          else {
            const payload = lambdaOutput.payload;
            expect(payload.running.concat(payload.completed, payload.failed).length).toEqual(1);

            expect(payload.pdr.path).toEqual(expectedParsePdrOutput.pdr.path);
            expect(payload.pdr.name).toEqual(expectedParsePdrOutput.pdr.name);
          }
        });
      });

      describe('PdrStatusReport lambda function', () => {
        let lambdaOutput;
        beforeAll(async () => {
          try {
            lambdaOutput = await lambdaStep.getStepOutput(parsePdrExecutionArn, 'SfSqsReport');
          } catch (error) {
            beforeAllFailed = error;
          }
        });

        // SfSnsReport lambda is used in the workflow multiple times, apparently, only the first output
        it('has expected output message', () => {
          if (beforeAllFailed) fail(beforeAllFailed);
          else if (lambdaOutput) {
            // Sometimes PDR ingestion completes before this step is reached, so it is never invoked
            // and there is no Lambda output to check.
            expect(lambdaOutput.payload.pdr.path).toEqual(expectedParsePdrOutput.pdr.path);
            expect(lambdaOutput.payload.pdr.name).toEqual(expectedParsePdrOutput.pdr.name);
          }
        });
      });

      /**
       * The parse pdr workflow kicks off a granule ingest workflow, so check that the
       * granule ingest workflow completes successfully. Above, we checked that there is
       * one running task, which is the sync granule workflow. The payload has the arn of the
       * running workflow, so use that to get the status.
       */
      describe('IngestGranule workflow', () => {
        let ingestGranuleExecutionStatus;

        beforeAll(async () => {
          try {
            // wait for IngestGranule execution to complete
            ingestGranuleWorkflowArn = queueGranulesOutput.payload.running[0];
            console.log(`Waiting for workflow to complete: ${ingestGranuleWorkflowArn}`);
            ingestGranuleExecutionStatus = await waitForCompletedExecution(ingestGranuleWorkflowArn);
          } catch (error) {
            beforeAllFailed = error;
          }
        });

        afterAll(async () => {
          // cleanup
          await Promise.all(
            queueGranulesOutput.payload.running
              .map((arn) => waitForCompletedExecution(arn))
          );
        });

        it('executes successfully', () => {
          if (beforeAllFailed) fail(beforeAllFailed);
          else {
            expect(ingestGranuleExecutionStatus).toEqual('SUCCEEDED');
          }
        });

        describe('SyncGranule lambda function', () => {
          let syncGranuleLambdaOutput;

          it('outputs 1 granule and pdr', async () => {
            if (beforeAllFailed) fail(beforeAllFailed);
            else {
              syncGranuleLambdaOutput = await lambdaStep.getStepOutput(
                ingestGranuleWorkflowArn,
                'SyncGranule'
              );
              expect(syncGranuleLambdaOutput.payload.granules.length).toEqual(1);
              expect(syncGranuleLambdaOutput.payload.pdr).toEqual(syncGranuleLambdaOutput.payload.pdr);
            }
          });
        });
      });

      /** This test relies on the previous 'IngestGranule workflow' to complete */
      describe('When accessing an execution via the API that was triggered from a parent step function', () => {
        afterAll(async () => {
          await deleteExecution({ prefix: config.stackName, executionArn: ingestGranuleWorkflowArn });
        });

        it('displays a link to the parent', async () => {
          if (beforeAllFailed) fail(beforeAllFailed);
          else {
            await waitForApiStatus(
              getExecution,
              {
                prefix: config.stackName,
                arn: workflowExecution.executionArn,
              },
              'completed'
            );

            ingestGranuleExecution = await getExecution({
              prefix: config.stackName,
              arn: ingestGranuleWorkflowArn,
            });

            expect(ingestGranuleExecution.parentArn).toEqual(parsePdrExecutionArn);
          }
        });
      });

      describe('When accessing an execution via the API that was not triggered from a parent step function', () => {
        it('does not display a parent link', async () => {
          if (beforeAllFailed) fail(beforeAllFailed);
          else {
            const parsePdrExecution = await getExecution({
              prefix: config.stackName,
              arn: workflowExecution.executionArn,
            });

            expect(parsePdrExecution.parentArn).toBeUndefined();
          }
        });
      });

      describe('When a workflow is configured to make a choice based on the output of a Cumulus task', () => {
        let executionStatus;

        beforeAll(async () => {
          let executionStatusResponse;
          try {
            executionStatusResponse = await executionsApiTestUtils.getExecutionStatus({
              prefix: config.stackName,
              arn: parsePdrExecutionArn,
            });
            console.log(`Execution status request status: ${executionStatusResponse.status}`);
            executionStatus = JSON.parse(executionStatusResponse.body);
          } catch (error) {
            console.log(`Error parsing JSON ${executionStatusResponse}`);
            beforeAllFailed = error;
            throw error;
          }
        });

        it('branches according to the CMA output', () => {
          if (beforeAllFailed) fail(beforeAllFailed);
          else {
            expect(executionStatus.executionHistory).toBeTruthy();
            const events = executionStatus.executionHistory.events;

            // the output of the CheckStatus is used to determine the task of choice
            const checkStatusTaskName = 'CheckStatus';
            const successStepName = 'WorkflowSucceeded';
            const pdrStatusReportTaskName = 'PdrStatusReport';

            let choiceVerified = false;
            for (let i = 0; i < events.length; i += 1) {
              const currentEvent = events[i];
              if (currentEvent.type === 'TaskStateExited' &&
                currentEvent.name === checkStatusTaskName) {
                const output = JSON.parse(currentEvent.output);
                const isFinished = output.payload.isFinished;

                // get the next task executed
                let nextTask;
                while (!nextTask && i < events.length - 1) {
                  i += 1;
                  const nextEvent = events[i];
                  if ((
                    nextEvent.type === 'TaskStateEntered' ||
                    nextEvent.type === 'SucceedStateEntered'
                  ) && nextEvent.name) {
                    nextTask = nextEvent.name;
                  }
                }

                expect(nextTask).toBeTruthy();

                if (isFinished === true) {
                  expect(nextTask).toEqual(successStepName);
                } else {
                  expect(nextTask).toEqual(pdrStatusReportTaskName);
                }
                choiceVerified = true;
              }
            }
            expect(choiceVerified).toBeTrue();
          }
        });
      });
    });

    describe('the reporting lambda has received the CloudWatch step function event and', () => {
      it('the execution record is added to DynamoDB', async () => {
        if (beforeAllFailed) fail(beforeAllFailed);
        else {
          const record = await waitForApiStatus(
            getExecution,
            {
              prefix: config.stackName,
              arn: workflowExecution.executionArn,
            },
            'completed'
          );
          expect(record.status).toEqual('completed');
        }
      });

      it('the pdr record is added to the API', async () => {
        if (beforeAllFailed) fail(beforeAllFailed);
        else {
          const record = await waitForApiStatus(
            getPdr,
            {
              prefix: config.stackName,
              pdrName: pdrFilename,
            },
            ['completed']
          );
          expect(record.execution).toEqual(getExecutionUrl(parsePdrExecutionArn));
          expect(record.status).toEqual('completed');
        }
      });
    });

    /** This test relies on the previous 'ParsePdr workflow' to complete */
    describe('When accessing an execution via the API that was triggered from a parent step function', () => {
      it('displays a link to the parent', async () => {
        if (beforeAllFailed) fail(beforeAllFailed);
        else {
          parsePdrExecutionArn = queuePdrsOutput.payload.running[0];
          const parsePdrExecution = await executionsApiTestUtils.getExecution({
            prefix: config.stackName,
            arn: parsePdrExecutionArn,
          });

          expect(parsePdrExecution.parentArn).toEqual(workflowExecution.executionArn);
        }
      });
    });

    describe('When accessing an execution via the API that was not triggered from a parent step function', () => {
      it('does not display a parent link', async () => {
        if (beforeAllFailed) fail(beforeAllFailed);
        else {
          const queuePdrsExecution = await executionsApiTestUtils.getExecution({
            prefix: config.stackName,
            arn: workflowExecution.executionArn,
          });

          expect(queuePdrsExecution.parentArn).toBeUndefined();
        }
      });
    });

    describe('An SNS message', () => {
      let executionCompletedKey;
      let pdrRunningMessageKey;
      let pdrCompletedMessageKey;

      beforeAll(() => {
        try {
          const parsePdrExecutionName = parsePdrExecutionArn.split(':').pop();

          executionCompletedKey = `${config.stackName}/test-output/${parsePdrExecutionName}.output`;

          pdrRunningMessageKey = `${config.stackName}/test-output/${pdrFilename}-running.output`;
          pdrCompletedMessageKey = `${config.stackName}/test-output/${pdrFilename}-completed.output`;
        } catch (error) {
          beforeAllFailed = error;
        }
      });

      afterAll(async () => {
        await Promise.all([
          deleteS3Object(config.bucket, executionCompletedKey),
          deleteS3Object(config.bucket, pdrRunningMessageKey),
          deleteS3Object(config.bucket, pdrCompletedMessageKey),
        ]);
      });

      it('is published for a running PDR', async () => {
        if (beforeAllFailed) fail(beforeAllFailed);
        else {
          const pdrExists = await s3ObjectExists({
            Bucket: config.bucket,
            Key: pdrRunningMessageKey,
          });
          expect(pdrExists).toEqual(true);
        }
      });

      it('is published for an execution on a successful workflow completion', async () => {
        if (beforeAllFailed) fail(beforeAllFailed);
        else {
          const executionExists = await s3ObjectExists({
            Bucket: config.bucket,
            Key: executionCompletedKey,
          });
          expect(executionExists).toEqual(true);
        }
      });

      it('is published for a PDR on a successful workflow completion', async () => {
        if (beforeAllFailed) fail(beforeAllFailed);
        else {
          const pdrExists = await s3ObjectExists({
            Bucket: config.bucket,
            Key: pdrCompletedMessageKey,
          });
          expect(pdrExists).toEqual(true);
        }
      });
    });
  });
});
