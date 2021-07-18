'use strict';

const { runReaper } = require('./reap-kinesis');
const { s3cleanup } = require('./cleanups3');

async function handler() {
  await Promise.all([
    runReaper(),
    s3cleanup(),
  ]);
}

exports.handler = handler;
