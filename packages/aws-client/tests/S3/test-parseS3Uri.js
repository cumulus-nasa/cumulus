'use strict';

const test = require('ava');
const { parseS3Uri } = require('../../S3');

[
  ['s3://bucket', { Bucket: 'bucket', Key: undefined }],
  ['s3://bucket/key/asdf', { Bucket: 'bucket', Key: 'key/asdf' }],
  ['s3://bucket/key', { Bucket: 'bucket', Key: 'key' }],
  ['s3://bucket/key/', { Bucket: 'bucket', Key: 'key/' }],
  ['s3://bucket/', { Bucket: 'bucket', Key: '' }]
].forEach(([input, expected]) => {
  test(`parseS3Uri('${input}') produces the expected output`, (t) => {
    t.deepEqual(parseS3Uri(input), expected);
  });
});

[
  'http://asdf',
  'asdf'
].forEach((input) => {
  test(`parseS3Uri('${input}') throws a TypeError for an invalid S3 URI`, (t) => {
    t.throws(
      () => parseS3Uri(input),
      { instanceOf: TypeError }
    );
  });
});
