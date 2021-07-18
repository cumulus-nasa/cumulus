'use strict';

const AWS = require('aws-sdk');
const s3 = new AWS.S3();

const internalDeleteParams = [
  { regex: /.*-\d{11,}-test-data\/.*/, olderThanDays: 2 },
  { regex: /.*file-staging\/.*/, olderThanDays: 2 },
  { regex: /.*custom-staging-dir\/.*/, olderThanDays: 2 },
  { regex: /.*\/test-output\/.*/, olderThanDays: 1 },
  { regex: /.*events\/.*/, olderThanDays: 60 },
  { regex: /.*ems\/.*/, olderThanDays: 10 },
  { regex: /.*ems-distribution\/reports\/.*/, olderThanDays: 10 },
];

const protectedDeleteParams = [
  { regex: /MOD09GQ(\d|\w{10,})___006\/.*/, olderThanDays: 2 },
  { regex: /.*-\d{11,}-test-data\/.*/, olderThanDays: 2 },
  { regex: /url-path-.*\/.*/, olderThanDays: 2 },
];

const bucketDeleteParams = [
  { bucketRegex: /.*-internal/, deleteParams: internalDeleteParams },
  { bucketRegex: /.*-protected.*/, deleteParams: protectedDeleteParams },
  { bucketRegex: /.*-private/, deleteParams: protectedDeleteParams },
];

function shouldDeleteObject(object, deleteParams) {
  const objectsToDelete = deleteParams.map((params) => {
    const date = new Date();
    date.setDate(date.getDate() - params.olderThanDays);

    return object.Key.match(params.regex) && object.LastModified < date;
  });

  return objectsToDelete.filter((o) => o).length > 0;
}

async function cleanBucketByParams(bucket, deleteParams, continuationToken) {
  let objects = [];

  try {
    objects = await s3.listObjectsV2({
      Bucket: bucket,
      ContinuationToken: continuationToken,
    }).promise();
  } catch (error) {
    console.log(`Error cleaning bucket ${bucket}: ${error}`);
    return;
  }

  const objectsToDelete = objects.Contents
    .filter((o) => shouldDeleteObject(o, deleteParams))
    .map((o) => ({ Key: o.Key }));

  console.log(`Deleting ${objectsToDelete.length} objects from ${bucket}, skipping ${objects.KeyCount - objectsToDelete.length} objects.`);

  if (objectsToDelete.length > 0) {
    await s3.deleteObjects({
      Bucket: bucket,
      Delete: { Objects: objectsToDelete },
    }).promise();
  }

  if (objects.IsTruncated) {
    await cleanBucketByParams(bucket, deleteParams, objects.NextContinuationToken);
  }
}

async function cleanBuckets(buckets, regex, deleteParams) {
  const bucketsToClean = buckets.filter((b) => b.match(regex));
  return await Promise.all(bucketsToClean.map((b) => cleanBucketByParams(b, deleteParams)));
}

async function s3cleanup() {
  const buckets = await s3.listBuckets().promise();
  const bucketNames = buckets.Buckets.map((b) => b.Name);

  return await Promise.all(
    bucketDeleteParams.map((b) => cleanBuckets(bucketNames, b.bucketRegex, b.deleteParams))
  );
}

module.exports = {
  s3cleanup,
};
