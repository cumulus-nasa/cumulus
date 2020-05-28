'use strict';

const { fakeGranuleFactoryV2 } = require('@cumulus/api/lib/testUtils');
const Granule = require('@cumulus/api/models/granules');
const granules = require('@cumulus/api-client/granules');
const { ecs } = require('@cumulus/aws-client/services');
const {
  api: apiTestUtils,
  getClusterArn
} = require('@cumulus/integration-tests');
const { loadConfig } = require('../../helpers/testUtils');

describe('POST /granules/bulkDelete with a successful bulk delete operation', () => {
  let postBulkDeleteResponse;
  let postBulkDeleteBody;
  let config;
  let clusterArn;
  let taskArn;
  let beforeAllSucceeded = false;

  const granule = fakeGranuleFactoryV2({ published: false });

  beforeAll(async () => {
    config = await loadConfig();
    process.env.stackName = config.stackName;
    process.env.system_bucket = config.bucket;

    // Figure out what cluster we're using
    clusterArn = await getClusterArn(config.stackName);
    if (!clusterArn) throw new Error('Unable to find ECS cluster');

    process.env.GranulesTable = `${config.stackName}-GranulesTable`;
    const granulesModel = new Granule();
    await granulesModel.create(granule);

    postBulkDeleteResponse = await granules.bulkDeleteGranules({
      prefix: config.stackName,
      body: {
        ids: [granule.granuleId]
      }
    });
    postBulkDeleteBody = JSON.parse(postBulkDeleteResponse.body);

    // Query the AsyncOperation API to get the task ARN
    const getAsyncOperationResponse = await apiTestUtils.getAsyncOperation({
      prefix: config.stackName,
      id: postBulkDeleteBody.asyncOperationId
    });
    ({ taskArn } = JSON.parse(getAsyncOperationResponse.body));

    beforeAllSucceeded = true;
  });

  afterAll(async () => {
    const granulesModel = new Granule();
    await granulesModel.delete({ granuleId: granule.granuleId });
  });

  it('returns a status code of 202', () => {
    expect(beforeAllSucceeded).toBeTrue();
    expect(postBulkDeleteResponse.statusCode).toEqual(202);
  });

  it('returns an Async Operation Id', () => {
    expect(beforeAllSucceeded).toBeTrue();
    expect(postBulkDeleteBody.asyncOperationId).toMatch(/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/);
  });

  it('creates an AsyncOperation', async () => {
    expect(beforeAllSucceeded).toBeTrue();

    const getAsyncOperationResponse = await apiTestUtils.getAsyncOperation({
      prefix: config.stackName,
      id: postBulkDeleteBody.asyncOperationId
    });

    expect(getAsyncOperationResponse.statusCode).toEqual(200);

    const getAsyncOperationBody = JSON.parse(getAsyncOperationResponse.body);

    expect(getAsyncOperationBody.id).toEqual(postBulkDeleteBody.asyncOperationId);
  });

  it('runs an ECS task', async () => {
    expect(beforeAllSucceeded).toBeTrue();

    // Verify that the task ARN exists in that cluster
    const describeTasksResponse = await ecs().describeTasks({
      cluster: clusterArn,
      tasks: [taskArn]
    }).promise();

    expect(describeTasksResponse.tasks.length).toEqual(1);
  });

  it('eventually generates the correct output', async () => {
    expect(beforeAllSucceeded).toBeTrue();

    await ecs().waitFor(
      'tasksStopped',
      {
        cluster: clusterArn,
        tasks: [taskArn]
      }
    ).promise();

    const getAsyncOperationResponse = await apiTestUtils.getAsyncOperation({
      prefix: config.stackName,
      id: postBulkDeleteBody.asyncOperationId
    });

    const getAsyncOperationBody = JSON.parse(getAsyncOperationResponse.body);

    expect(getAsyncOperationResponse.statusCode).toEqual(200);
    expect(getAsyncOperationBody.status).toEqual('SUCCEEDED');

    let output;
    try {
      output = JSON.parse(getAsyncOperationBody.output);
    } catch (err) {
      throw new SyntaxError(`getAsyncOperationBody.output is not valid JSON: ${getAsyncOperationBody.output}`);
    }

    expect(output).toEqual({ deletedGranules: [granule.granuleId] });
  });
});
