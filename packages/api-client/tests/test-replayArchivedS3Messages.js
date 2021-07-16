'use strict';

const test = require('ava');

const replayArchivedMessagesApi = require('../replayArchivedS3Messages');

test('postReplayArchivedMessages calls the callback with the expected object and returns the parsed response', async (t) => {
  const prefix = 'unitTestStack';
  const queueName = 'myQueue';

  const expected = {
    prefix,
    payload: {
      httpMethod: 'POST',
      resource: '/{proxy+}',
      headers: {
        'Content-Type': 'application/json',
      },
      path: `/replayArchivedS3Messages/${queueName}`,
    },
  };
  const callback = (configObject) => {
    t.deepEqual(expected, configObject);
  };

  await t.notThrowsAsync(replayArchivedMessagesApi.postReplayArchivedMessages({
    prefix,
    queueName,
    callback,
  }));
});
