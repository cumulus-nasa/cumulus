'use strict';

const router = require('express-promise-router')();

const { defaultErrorHandler } = require('./middleware');

const collections = require('../endpoints/collections');
const granules = require('../endpoints/granules');
const granuleCsv = require('../endpoints/granule-csv');
const providers = require('../endpoints/providers');
const pdrs = require('../endpoints/pdrs');
const rules = require('../endpoints/rules');
const executionStatus = require('../endpoints/execution-status');
const executions = require('../endpoints/executions');
const asyncOperations = require('../endpoints/async-operations');
const instanceMeta = require('../endpoints/instance-meta');
const logs = require('../endpoints/logs');
const orca = require('../endpoints/orca');
const reconcilliationReports = require('../endpoints/reconciliation-reports');
const replays = require('../endpoints/replays');
const schemas = require('../endpoints/schemas');
const stats = require('../endpoints/stats');
const version = require('../endpoints/version');
const workflows = require('../endpoints/workflows');
const dashboard = require('../endpoints/dashboard');
const elasticsearch = require('../endpoints/elasticsearch');
const migrationCounts = require('../endpoints/migrationCounts');
const deadLetterArchive = require('../endpoints/dead-letter-archive');
const { launchpadProtectedAuth } = require('./launchpadAuth');
const launchpadSaml = require('../endpoints/launchpadSaml');
const replayArchivedS3Messages = require('../endpoints/replayArchivedS3Messages');

let token = require('../endpoints/token');
let { ensureAuthorized } = require('./auth');
if (process.env.FAKE_AUTH === 'true') {
  token = require('./testAuth'); // eslint-disable-line global-require
  ensureAuthorized = token.ensureAuthorized;
}

// replay archived S3 messages endpoint
router.use('/replayArchivedS3Messages', ensureAuthorized, replayArchivedS3Messages);

// dead letters endpoint
router.use('/deadLetterArchive', ensureAuthorized, deadLetterArchive);

//migrationCounts endpoint
router.use('/migrationCounts', ensureAuthorized, migrationCounts);

// collections endpoints
router.use('/collections', ensureAuthorized, collections.router);

// granules endpoints
router.use('/granules', ensureAuthorized, granules);

// granule csv endpoints
router.use('/granule-csv', ensureAuthorized, granuleCsv);

// provider endpoints
router.use('/providers', ensureAuthorized, providers);

// pdr endpoints
router.use('/pdrs', ensureAuthorized, pdrs);

// rules endpoints
router.use('/rules', ensureAuthorized, rules.router);

// executions endpoints
router.use('/executions/status', ensureAuthorized, executionStatus);
router.use('/executions', ensureAuthorized, executions);

// async operation endpoint
router.use('/asyncOperations', ensureAuthorized, asyncOperations.router);

// instance meta endpoint
router.use('/instanceMeta', ensureAuthorized, instanceMeta);

// logs endpoint
router.use('/logs', ensureAuthorized, logs);

// orca endpoint
router.use('/orca', ensureAuthorized, orca);

// reconciliationReports endpoint
router.use('/reconciliationReports', ensureAuthorized, reconcilliationReports);

// replays endpoint
router.use('/replays', ensureAuthorized, replays);

// schemas endpoint
router.use('/schemas', ensureAuthorized, schemas);

// stats endpoint
router.use('/stats', ensureAuthorized, stats);

// version endpoint
// this endpoint is not behind authentication
router.use('/version', version);

// workflows endpoint
router.use('/workflows', ensureAuthorized, workflows);

// OAuth Token endpoints
if (launchpadProtectedAuth()) {
  // SAML SSO
  router.get('/saml/login', launchpadSaml.login);
  router.post('/saml/auth', launchpadSaml.auth);
  router.get('/token', launchpadSaml.samlToken);
  // disabled for now
  router.post('/refresh', launchpadSaml.refreshEndpoint);
} else {
  router.get('/token', token.tokenEndpoint);
  router.post('/refresh', token.refreshEndpoint);
}
router.delete('/token/:token', token.deleteTokenEndpoint);
router.delete('/tokenDelete/:token', token.deleteTokenEndpoint);

router.use('/dashboard', dashboard);

router.use('/elasticsearch', ensureAuthorized, elasticsearch.router);

// Catch and send the error message down (instead of just 500: internal server error)
router.use(defaultErrorHandler);

module.exports = router;
