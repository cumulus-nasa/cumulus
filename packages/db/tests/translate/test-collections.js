const test = require('ava');
const { removeNilProperties } = require('@cumulus/common/util');
const {
  translateApiCollectionToPostgresCollection,
  translatePostgresCollectionToApiCollection,
} = require('../../dist/translate/collections');

const {
  fakeCollectionRecordFactory,
} = require('../../dist');
test('translatePostgresCollectionToApiCollection converts Postgres collection to API', (t) => {
  const meta = { tag_key: 'tag_value' };
  const tags = ['tag1', 'tag2'];
  const collectionRecord = fakeCollectionRecordFactory({
    meta,
    tags,
    updated_at: new Date(),
    created_at: new Date(),
  });

  const expected = {
    createdAt: collectionRecord.created_at.getTime(),
    updatedAt: collectionRecord.updated_at.getTime(),
    files: collectionRecord.files,
    granuleId: collectionRecord.granule_id_validation_regex,
    granuleIdExtraction: collectionRecord.granule_id_validation_regex,
    meta: collectionRecord.meta,
    name: collectionRecord.name,
    sampleFileName: collectionRecord.sample_file_name,
    tags: collectionRecord.tags,
    version: collectionRecord.version,
  };
  const actual = translatePostgresCollectionToApiCollection(collectionRecord);
  t.deepEqual(actual, expected);
});

test('translateApiCollectionToPostgresCollection converts API collection to Postgres', (t) => {
  const apiCollection = {
    name: 'COLL',
    version: '001',
    granuleIdExtraction: '.*',
    granuleId: '.*',
    files: [
      {
        bucket: 's3-bucket',
        regex: '.*',
        sampleFileName: 'somefilename',
      },
    ],
  };

  const expectedPostgresCollection = {
    name: apiCollection.name,
    version: apiCollection.version,
    granule_id_validation_regex: apiCollection.granuleId,
    granule_id_extraction_regex: apiCollection.granuleIdExtraction,
    files: JSON.stringify(apiCollection.files),
  };

  t.deepEqual(
    removeNilProperties(translateApiCollectionToPostgresCollection(apiCollection)),
    expectedPostgresCollection
  );
});
