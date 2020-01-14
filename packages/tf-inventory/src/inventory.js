'use strict';

const aws = require('@cumulus/common/aws');
const mergeWith = require('lodash.mergewith');
const difference = require('lodash.difference');
const stateFile = require('./stateFile');
const awsServices = require('@cumulus/aws-client/services');

/**
 * Merge 2 resource objects by key
 * So { ecs: [1, 2, 3] } and { ecs: [4, 5] }
 * would become { ecs: [1, 2, 3, 4, 5] }
 * This assumes x and y are objects of lists
 *
 * @param {Object} x - resource object
 * @param {Object} y - resource object
 * @returns {Objects} - resource object of x and y combined
 */
function mergeResourceLists(x, y) {
  return mergeWith(x, y, (xVal, yVal) => {
    if (!xVal) {
      return yVal;
    }

    if (!yVal) {
      return xVal;
    }

    return xVal.concat(yVal);
  });
}

/**
 * For 2 resource objects of lists, return an object where each
 * key has items that are only in the first list
 * For example:
 * { ecs: [1, 2, 3] } and { ecs: [1, 2, 4] }
 * would return { ecs: [3] }
 *
 * @param {Object} x - resource object
 * @param {Object} y - resource object
 * @returns {Object}
 */
function resourceDiff(x, y) {
  const keys = Object.keys(x);
  const val = {};

  keys.forEach((k) => {
    val[k] = difference(x[k], y[k]);
  });

  return val;
}

/**
 * Go through each state file and get resources. Return Object containing
 * resources from all state files.
 *
 * @param {Array<string>} stateFiles - List of state file paths in the form
 * bucket/key
 * @returns {Object} - Object of resources from all state files
 */
async function listTfResources(stateFiles) {
  const resourcePromises = stateFiles.map((sf) => stateFile.listResourcesForFile(sf));

  const resources = await Promise.all(resourcePromises);

  return resources.reduce(mergeResourceLists);
}

async function listAwsResources() {
  const ecsClusters = await aws.ecs().listClusters().promise();

  let ec2Instances = await aws.ec2().describeInstances().promise();
  ec2Instances = [].concat(...ec2Instances.Reservations.map((e) => e.Instances));
  ec2Instances = ec2Instances.map((inst) => inst.InstanceId);

  let esDomainNames = await awsServices.es().listDomainNames().promise();
  esDomainNames = esDomainNames.DomainNames.map((e) => e.DomainName);

  return {
    ecsClusters: ecsClusters.clusterArns,
    ec2Instances,
    esDomainNames
  };
}


async function reconcileResources() {
  const stateFiles = await stateFile.listTfStateFiles();

  const tfResources = await listTfResources(stateFiles);
  const awsResources = await listAwsResources();

  return resourceDiff(awsResources, tfResources);
}

module.exports = {
  reconcileResources,
  listTfResources
};
