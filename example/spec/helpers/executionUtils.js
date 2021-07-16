const { getExecution, deleteExecution } = require('@cumulus/api-client/executions');

const { waitForApiStatus } = require('./apiUtils');

const waitForExecutionAndDelete = async (prefix, arn, status) => {
  await waitForApiStatus(
    getExecution,
    {
      prefix,
      arn,
    },
    status
  );
  await deleteExecution({
    prefix,
    executionArn: arn,
  });
};

module.exports = {
  waitForExecutionAndDelete,
};
