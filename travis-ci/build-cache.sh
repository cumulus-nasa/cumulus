#!/bin/sh

set -evx

# Determine what cache to use (based on all of the package.json files)
MD5SUM=$(cat $(git ls-files | grep yarn.lock | sort) | md5sum | awk '{print $1}')
CACHE_FILENAME="${MD5SUM}.tar.gz"
KEY="travis-ci-cache/${CACHE_FILENAME}"

# Determine if the cache already exists
DATE=$(date -R)
STRING_TO_SIGN_HEAD="HEAD


${DATE}
/${CACHE_BUCKET}/${KEY}"
SIGNATURE=$(/bin/echo -n "$STRING_TO_SIGN_HEAD" | openssl sha1 -hmac ${CACHE_AWS_SECRET_ACCESS_KEY} -binary | base64)

CACHE_EXISTS_STATUS_CODE=$(curl \
  -sS \
  -o /dev/null \
  -w '%{http_code}' \
  --head \
  -H "Host: ${CACHE_BUCKET}.s3.amazonaws.com" \
  -H "Date: ${DATE}" \
  -H "Authorization: AWS ${CACHE_AWS_ACCESS_KEY_ID}:${SIGNATURE}" \
  https://${CACHE_BUCKET}.s3.amazonaws.com/${KEY}
)

if [ "$CACHE_EXISTS_STATUS_CODE" = "200" ]; then
  # If the cache exists then do nothing
  echo "Cache already exists: s3://${CACHE_BUCKET}/${KEY}"
else
  # If the cache does not exist then create it and upload it to S3
  echo "Creating cache"
  yarn install
  yarn bootstrap-no-build

  tar -czf "$CACHE_FILENAME" -C $(yarn cache dir) .

  CACHE_SIZE=$(du -sh "$CACHE_FILENAME" | awk '{ print $1 }')
  echo "Cache size: $CACHE_SIZE"

  echo "Uploading cache"
  STRING_TO_SIGN_PUT="PUT


${DATE}
/${CACHE_BUCKET}/${KEY}"
  SIGNATURE=$(/bin/echo -n "$STRING_TO_SIGN_PUT" | openssl sha1 -hmac ${CACHE_AWS_SECRET_ACCESS_KEY} -binary | base64)

  curl \
    -sS \
    -X PUT \
    -T "$CACHE_FILENAME" \
    -H "Host: ${CACHE_BUCKET}.s3.amazonaws.com" \
    -H "Date: ${DATE}" \
    -H "Authorization: AWS ${CACHE_AWS_ACCESS_KEY_ID}:${SIGNATURE}" \
    https://${CACHE_BUCKET}.s3.amazonaws.com/${KEY}
fi
