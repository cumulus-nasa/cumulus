'use strict';

const test = require('ava');

const { getCmrHost, getSearchUrl, getBucketAccessUrl } = require('../getUrl');

test('getCmrHost uses provided logical CMR environment', (t) => {
  t.is(getCmrHost({ cmrEnvironment: 'OPS' }), 'https://cmr.earthdata.nasa.gov');
  t.is(getCmrHost({ cmrEnvironment: 'UAT' }), 'https://cmr.uat.earthdata.nasa.gov');
  t.is(getCmrHost({ cmrEnvironment: 'SIT' }), 'https://cmr.sit.earthdata.nasa.gov');
});

test('getCmrHost uses custom CMR host', (t) => {
  t.is(getCmrHost({ cmrHost: 'http://custom-host' }), 'http://custom-host');
});

test('getCmrHost throws error if provided environment is incorrect', (t) => {
  t.throws(() => getCmrHost({ cmrEnvironment: 'foo' }));
  t.throws(() => getCmrHost());
});

test.serial('getCmrHost uses process.env.CMR_ENVIRONMENT logical name, if provided', (t) => {
  process.env.CMR_ENVIRONMENT = 'OPS';
  t.teardown(() => delete process.env.CMR_ENVIRONMENT);
  t.is(getCmrHost(), 'https://cmr.earthdata.nasa.gov');
});

test.serial('getCmrHost uses process.env.CMR_HOST custom host, if provided', (t) => {
  process.env.CMR_HOST = 'http://cmr-host';
  t.teardown(() => delete process.env.CMR_HOST);
  t.is(getCmrHost(), 'http://cmr-host');
});

test.serial('getSearchUrl returns value according to cmrEnvironment param', (t) => {
  t.is(getSearchUrl({ cmrEnv: 'OPS' }), 'https://cmr.earthdata.nasa.gov/search/');
  t.is(getSearchUrl({ cmrEnv: 'SIT' }), 'https://cmr.sit.earthdata.nasa.gov/search/');
  t.is(getSearchUrl({ cmrEnv: 'UAT' }), 'https://cmr.uat.earthdata.nasa.gov/search/');
});

test.serial('getSearchUrl pulls cmrEnvironment from environment variables', (t) => {
  process.env.CMR_ENVIRONMENT = 'SIT';
  t.is(getSearchUrl(), 'https://cmr.sit.earthdata.nasa.gov/search/');

  process.env.CMR_ENVIRONMENT = 'UAT';
  t.is(getSearchUrl(), 'https://cmr.uat.earthdata.nasa.gov/search/');

  process.env.CMR_ENVIRONMENT = 'OPS';
  t.is(getSearchUrl(), 'https://cmr.earthdata.nasa.gov/search/');

  t.teardown(() => delete process.env.CMR_ENVIRONMENT);
});

test.serial('getSearchUrl uses cmrEnv from parameter over env variable', (t) => {
  process.env.CMR_ENVIRONMENT = 'SIT';
  t.is(getSearchUrl({ cmrEnv: 'OPS' }), 'https://cmr.earthdata.nasa.gov/search/');
  t.teardown(() => delete process.env.CMR_ENVIRONMENT);
});

test('getBucketAccessUrl returns correct url for UAT invornment.', (t) => {
  t.is(getBucketAccessUrl({ cmrEnv: 'OPS' }), 'https://cmr.earthdata.nasa.gov/access-control/s3-buckets/');
  t.is(getBucketAccessUrl({ cmrEnv: 'SIT' }), 'https://cmr.sit.earthdata.nasa.gov/access-control/s3-buckets/');
  t.is(getBucketAccessUrl({ cmrEnv: 'UAT' }), 'https://cmr.uat.earthdata.nasa.gov/access-control/s3-buckets/');
});
