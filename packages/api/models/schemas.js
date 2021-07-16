'use strict';

module.exports.accessToken = {
  title: 'Access Token Object',
  description: 'Cumulus API AccessToken Table schema',
  type: 'object',
  required: ['accessToken', 'expirationTime'],
  additionalProperties: false,
  properties: {
    accessToken: {
      title: 'Access Token',
      description: 'The access token returned by the OAuth provider',
      type: 'string',
    },
    createdAt: { type: 'integer' },
    expirationTime: {
      description: 'The expiration time of the access token in milliseconds',
      type: 'integer',
    },
    refreshToken: {
      title: 'Refresh Token',
      description: 'The refresh token returned by the OAuth provider',
      type: 'string',
    },
    updatedAt: { type: 'integer' },
    username: {
      title: 'Username',
      description: 'The username associated with the access token. For valid request authorization, the username must match a record in the Users table',
      type: 'string',
    },
    tokenInfo: {
      title: 'Token Info',
      description: 'The information associated with the access token, such as user profile information',
      type: 'object',
      additionalProperties: true,
    },
  },
};

// Async Operation record definition
module.exports.asyncOperation = {
  title: 'AsyncOperation Object',
  description: 'Cumulus API AsyncOperation Table schema',
  type: 'object',
  required: ['createdAt', 'id', 'status', 'updatedAt', 'description', 'operationType'],
  additionalProperties: false,
  properties: {
    createdAt: { type: 'integer' },
    id: { type: 'string' },
    description: { type: 'string' },
    operationType: {
      type: 'string',
      enum: ['Data Migration', 'Dead-Letter Processing', 'Migration Count Report', 'ES Index', 'Bulk Granules', 'Bulk Granule Delete', 'Bulk Granule Reingest', 'Kinesis Replay', 'Reconciliation Report'],
    },
    output: {
      description: 'The result of the operation, stored as JSON',
      type: 'string',
    },
    status: {
      type: 'string',
      enum: ['RUNNING', 'SUCCEEDED', 'RUNNER_FAILED', 'TASK_FAILED'],
    },
    taskArn: { type: 'string' },
    updatedAt: { type: 'integer' },
  },
};

// Collection Record Definition
module.exports.collection = {
  title: 'Collection Object',
  description: 'Cumulus-api Collection Table schema',
  type: 'object',
  properties: {
    name: {
      title: 'Name',
      description: 'Collection short_name registered with the CMR',
      type: 'string',
    },
    version: {
      title: 'Version',
      description: 'The version registered with the CMR.',
      type: 'string',
    },
    dataType: {
      title: 'DataType',
      description: 'This field is deprecated and unused',
      type: 'string',
    },
    process: {
      title: 'Process',
      description: 'Name of the docker process to be used, e.g. modis, aster',
      type: 'string',
    },
    url_path: {
      title: 'Url Path',
      description: 'The folder (url) used to save granules on S3 buckets',
      type: 'string',
    },
    duplicateHandling: {
      title: 'Duplicate Granule Handling',
      description: 'How to handle duplicate granules',
      type: 'string',
      enum: ['error', 'skip', 'replace', 'version'],
      default: 'error',
    },
    granuleId: {
      title: 'GranuleId Validation Regex',
      description: 'The regular expression used to validate the granule ID '
        + 'extracted from filenames according to the `granuleIdExtraction`',
      type: 'string',
    },
    granuleIdExtraction: {
      title: 'GranuleId Extraction Regex',
      description: 'The regular expression used to extract the granule ID from filenames. '
        + 'The first capturing group extracted from the filename by the regex'
        + 'will be used as the granule ID.',
      type: 'string',
    },
    reportToEms: {
      title: 'Report to EMS',
      description: 'Indicates whether the collection will be reported to EMS',
      type: 'boolean',
      default: true,
    },
    sampleFileName: {
      title: 'Sample Filename',
      description: 'Is used to validate to test granule ID '
        + 'validation and extraction regexes against',
      type: 'string',
    },
    ignoreFilesConfigForDiscovery: {
      title: 'Ignore Files Configuration During Discovery',
      description: "When true, ignore this collection's files config list for"
        + ' determining which files to ingest for a granule, and ingest all of'
        + ' them.  When false, ingest only files that match a regex in one of'
        + " this collection's files config list.  When this property is"
        + ' specified on a task, it overrides the value set on a collection.'
        + ' Defaults to false.',
      type: 'boolean',
    },
    files: {
      title: 'Files',
      description: 'List of file definitions',
      type: 'array',
      items: {
        type: 'object',
        properties: {
          regex: {
            title: 'Regex',
            description: 'Regular expression used to identify the file',
            type: 'string',
          },
          sampleFileName: {
            title: 'Sample Filename',
            description: 'Filename used to validate the provided regular expression',
            type: 'string',
          },
          bucket: {
            title: 'Bucket',
            description: 'Bucket name used to store the file',
            type: 'string',
          },
          url_path: {
            title: 'Url Path',
            description: 'Folder used to save the granule in the bucket. '
              + 'Defaults to the collection url_path',
            type: 'string',
          },
          type: {
            title: 'File Type',
            description: 'CNM file type.  Cumulus uses this for CMR submission.  Non-CNM file types will be treated as "data" type',
            type: 'string',
          },
          checksumFor: {
            title: 'Checksum-For Regex',
            description: 'Regex to identify the base file for which this files serves as a sidecar checksum file. Should be identical to the \'regex\' property of the base file',
            type: 'string',
          },
          lzards: {
            title: 'LZARDS configuration',
            type: 'object',
            properties: {
              backup: {
                title: 'LZARDS backup flag',
                description: 'Boolean configuration value to determine if file type should be backed up by backup components.  Defaults to false',
                type: 'boolean',
              },
            },
          },
          reportToEms: {
            title: 'Report to EMS',
            description: 'Indicates whether the granule with this file type will be reported to EMS when the collection level configuration is true.',
            type: 'boolean',
            default: true,
          },
        },
        required: [
          'regex',
          'sampleFileName',
          'bucket',
        ],
      },
    },
    createdAt: {
      type: 'integer',
      readonly: true,
    },
    updatedAt: {
      type: 'integer',
    },
    meta: {
      title: 'Optional MetaData for the Collection',
      type: 'object',
      additionalProperties: true,
    },
    tags: {
      title: 'Optional tags for search',
      type: 'array',
      items: {
        type: 'string',
      },
    },
  },
  required: [
    'name',
    'version',
    'granuleId',
    'granuleIdExtraction',
    'sampleFileName',
    'files',
    'createdAt',
    'updatedAt',
  ],
};

module.exports.file = {
  type: 'object',
  required: [
    'granuleId',
    'bucket',
    'key',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    granuleId: { type: 'string' },
    bucket: { type: 'string' },
    key: { type: 'string' },
    createdAt: { type: 'integer' },
    updatedAt: { type: 'integer' },
  },
};

// Granule Record Schema
module.exports.granule = {
  title: 'Granule Object',
  type: 'object',
  properties: {
    granuleId: {
      title: 'Granule ID',
      type: 'string',
      readonly: true,
    },
    pdrName: {
      title: 'PDR associated with the granule',
      type: 'string',
      readonly: true,
    },
    collectionId: {
      title: 'Collection associated with the granule',
      type: 'string',
      readonly: true,
    },
    status: {
      title: 'Ingest status of the granule',
      enum: ['running', 'completed', 'failed'],
      type: 'string',
      readonly: true,
    },
    execution: {
      title: 'Step Function Execution link',
      type: 'string',
      readonly: true,
    },
    cmrLink: {
      type: 'string',
      readonly: true,
    },
    published: {
      type: 'boolean',
      default: false,
      description: 'shows whether the granule is published to CMR',
      readonly: true,
    },
    duration: {
      title: 'Ingest duration',
      type: 'number',
      readonly: true,
    },
    files: {
      title: 'Files',
      description: 'List of file definitions',
      type: 'array',
      items: {
        type: 'object',
        properties: {
          bucket: { type: 'string' },
          checksumType: { type: 'string' },
          checksum: { type: 'string' },
          key: { type: 'string' },
          size: { type: 'integer' },
          fileName: { type: 'string' },
          source: { type: 'string' },
          type: { type: 'string' },
        },
      },
    },
    error: {
      type: 'object',
      additionalProperties: true,
    },
    productVolume: {
      type: 'number',
      readonly: true,
    },
    timeToPreprocess: {
      type: 'number',
      readonly: true,
    },
    beginningDateTime: {
      type: 'string',
      readonly: true,
    },
    endingDateTime: {
      type: 'string',
      readonly: true,
    },
    processingStartDateTime: {
      type: 'string',
      readonly: true,
    },
    processingEndDateTime: {
      type: 'string',
      readonly: true,
    },
    lastUpdateDateTime: {
      type: 'string',
      readonly: true,
    },
    timeToArchive: {
      type: 'number',
      readonly: true,
    },
    productionDateTime: {
      type: 'string',
      readonly: true,
    },
    timestamp: { type: 'integer' },
    createdAt: { type: 'integer' },
    updatedAt: { type: 'integer' },
    dataType: { type: 'string' },
    version: { type: 'string' },
    provider: { type: 'string' },
    queryFields: {
      description: 'fields for query and metrics purpose',
      type: 'object',
      additionalProperties: true,
    },
  },
  required: [
    'granuleId',
    'collectionId',
    'status',
    'execution',
    'createdAt',
    'updatedAt',
  ],
};

// Reconciliation Report record
module.exports.reconciliationReport = {
  title: 'ReconciliationReport Object',
  description: 'Cumulus API ReconciliationReports Table schema',
  type: 'object',
  required: ['name', 'type', 'status', 'createdAt', 'updatedAt'],
  properties: {
    name: { type: 'string' },
    type: {
      type: 'string',
      enum: ['Granule Inventory', 'Granule Not Found', 'Internal', 'Inventory'],
    },
    status: {
      type: 'string',
      enum: ['Generated', 'Pending', 'Failed'],
    },
    location: { type: 'string' },
    error: {
      type: 'object',
      additionalProperties: true,
    },
    createdAt: { type: 'integer' },
    updatedAt: { type: 'integer' },
  },
};

// Ingest Rule Record Schema
module.exports.rule = {
  title: 'Ingest Rule Record Object',
  type: 'object',
  properties: {
    name: {
      title: 'name',
      type: 'string',
    },
    workflow: {
      title: 'Workflow Name',
      type: 'string',
    },
    provider: {
      title: 'Provider ID',
      type: 'string',
    },
    collection: {
      title: 'Collection Name and Version',
      type: 'object',
      properties: {
        name: {
          title: 'Collection Name',
          type: 'string',
        },
        version: {
          title: 'Collection Version',
          type: 'string',
        },
      },
      required: ['name', 'version'],
    },
    meta: {
      title: 'Optional MetaData for the Rule',
      type: 'object',
      properties: {
        retries: {
          description: 'Number of retries on errors, for sqs-type rule only. Default to 3.',
          type: 'number',
        },
        visibilityTimeout: {
          description: 'VisibilityTimeout in seconds for the inflight messages, for sqs-type rule only.  Default to the visibility timeout of the SQS queue when the rule is created.',
          type: 'number',
        },
      },
      additionalProperties: true,
    },
    payload: {
      title: 'Optional input payload to be used in onetime and scheduled rules',
    },
    queueUrl: {
      title: 'Optional queue URL used to schedule executions for this rule',
      type: 'string',
    },
    rule: {
      title: 'Ingest Rule',
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['onetime', 'scheduled', 'sns', 'kinesis', 'sqs'],
        },
        // Value is multi-use.   For a kinesis rule this is the target stream arn, for
        // a scheduled event it's the schedule pattern (e.g. cron), for a one-time rule.
        value: {
          type: 'string',
        },
        // Kinesis scheduled event arn
        arn: {
          type: 'string',
          readonly: true,
        },
        // Kinesis scheduled log event arn
        logEventArn: {
          type: 'string',
          readonly: true,
        },
      },
      required: ['type'],
    },
    state: {
      title: 'Rule state',
      type: 'string',
      enum: ['ENABLED', 'DISABLED'],
    },
    createdAt: {
      type: 'integer',
      readonly: true,
    },
    updatedAt: {
      type: 'integer',
    },
    tags: {
      title: 'Optional tags for search',
      type: 'array',
      items: {
        type: 'string',
      },
    },
    executionNamePrefix: {
      title: 'Execution name prefix',
      type: 'string',
    },
  },
  required: [
    'name', 'workflow', 'rule', 'state', 'createdAt', 'updatedAt',
  ],
};

// PDR Record Schema
module.exports.pdr = {
  title: 'PDR Record Object',
  type: 'object',
  properties: {
    pdrName: {
      title: 'PDR Name',
      type: 'string',
      readonly: true,
    },
    collectionId: {
      title: 'Collection Name',
      type: 'string',
      readonly: true,
    },
    provider: {
      title: 'Provider Name',
      type: 'string',
      readonly: true,
    },
    status: {
      type: 'string',
      enum: ['running', 'failed', 'completed'],
      readonly: true,
    },
    progress: {
      type: 'number',
      readonly: true,
    },
    execution: {
      type: 'string',
      readonly: true,
    },
    PANSent: {
      type: 'boolean',
      readonly: true,
    },
    PANmessage: {
      type: 'string',
      readonly: true,
    },
    stats: {
      type: 'object',
      readonly: true,
      properties: {
        total: {
          type: 'number',
        },
        completed: {
          type: 'number',
        },
        failed: {
          type: 'number',
        },
        processing: {
          type: 'number',
        },
      },
    },
    address: {
      type: 'string',
      readonly: true,
    },
    originalUrl: {
      type: 'string',
      readonly: true,
    },
    timestamp: { type: 'integer' },
    duration: { type: 'number' },
    createdAt: {
      type: 'integer',
      readonly: true,
    },
    updatedAt: { type: 'integer' },
  },
  required: [
    'pdrName',
    'provider',
    'collectionId',
    'status',
    'createdAt',
  ],
};

// Provider Schema => the model keeps information about each ingest location
module.exports.provider = {
  title: 'Provider Object',
  description: 'Keep the information about each ingest endpoint',
  type: 'object',
  properties: {
    id: {
      title: 'Provider Name',
      type: 'string',
    },
    globalConnectionLimit: {
      title: 'Concurrent Connection Limit',
      type: 'integer',
    },
    protocol: {
      title: 'Protocol',
      type: 'string',
      enum: ['http', 'https', 'ftp', 'sftp', 's3'],
      default: 'http',
    },
    host: {
      title: 'Host',
      type: 'string',
    },
    basicAuthRedirectHost: {
      title: 'Allowed host for redirect if data is protected by HTTP basic-auth',
      type: 'string',
    },
    port: {
      title: 'Port',
      type: 'number',
    },
    username: {
      type: 'string',
    },
    password: {
      type: 'string',
    },
    encrypted: {
      type: 'boolean',
      readonly: true,
    },
    createdAt: {
      type: 'integer',
      readonly: true,
    },
    updatedAt: {
      type: 'integer',
      readonly: true,
    },
    privateKey: {
      type: 'string',
      description: 'filename assumed to be in s3://bucketInternal/stackName/crypto',
    },
    cmKeyId: {
      type: 'string',
      description: 'AWS KMS Customer Master Key arn or alias',
    },
    certificateUri: {
      type: 'string',
      description: 'Optional SSL Certificate S3 URI for custom or self-signed SSL (TLS) certificate',
    },
  },
  required: [
    'id',
    'protocol',
    'host',
    'createdAt',
  ],
};

// Execution Schema => the model keeps information about each step function execution
module.exports.execution = {
  title: 'Execution Object',
  description: 'Keep the information about each step function execution',
  type: 'object',
  properties: {
    arn: {
      title: 'Execution arn (this field is unique)',
      type: 'string',
    },
    name: {
      title: 'Execution name',
      type: 'string',
    },
    execution: {
      title: 'The execution page url on AWS console',
      type: 'string',
    },
    error: {
      title: 'The error details in case of a failed execution',
      type: 'object',
      additionalProperties: true,
    },
    tasks: {
      type: 'object',
      additionalProperties: true,
    },
    type: {
      title: 'The workflow name, e.g. IngestGranule',
      type: 'string',
    },
    status: {
      title: 'the execution status',
      enum: ['running', 'completed', 'failed', 'unknown'],
      type: 'string',
    },
    createdAt: {
      type: 'integer',
      readonly: true,
    },
    updatedAt: { type: 'integer' },
    timestamp: {
      type: 'number',
      readonly: true,
    },
    originalPayload: {
      title: 'The original payload for this workflow',
      type: 'object',
      additionalProperties: true,
    },
    finalPayload: {
      title: 'The final payload of this workflow',
      type: 'object',
      additionalProperties: true,
    },
    collectionId: { type: 'string' },
    duration: { type: 'number' },
    parentArn: { type: 'string' },
    asyncOperationId: { type: 'string' },
    cumulusVersion: { type: 'string' },
  },
  required: [
    'arn',
    'name',
    'status',
    'createdAt',
    'updatedAt',
  ],
};
