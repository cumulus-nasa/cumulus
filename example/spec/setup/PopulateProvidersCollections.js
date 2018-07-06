const { addProviders, addCollections, addRules } = require('@cumulus/integration-tests');
const { loadConfig } = require('../helpers/testUtils');
const config = loadConfig();

jasmine.DEFAULT_TIMEOUT_INTERVAL = 550000;

const collectionsDirectory = './data/collections';
const providersDirectory = './data/providers';
const rulesDirectory = './data/rules';

describe('Populating providers, collections and rules to database', () => {
  let collections;
  let providers;
  let rules;

  beforeAll(async () => {
    const { stackName, bucketName } = config;

    try {
      providers = await addProviders(stackName, bucketName, providersDirectory);
      collections = await addCollections(stackName, bucketName, collectionsDirectory);
      rules = await addRules(config, rulesDirectory);
    }
    catch (e) {
      console.log(JSON.stringify(e));
      throw e;
    }
  });

  it('providers, collections and rules are added successfully', async () => {
    expect(providers).toBe(4, 'Number of providers incorrect.');
    expect(collections).toBe(4, 'Number of collections incorrect.');
    expect(rules).toBe(1, 'Number of rules incorrect.');
  });
});
