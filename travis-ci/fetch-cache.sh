#!/bin/sh

set -e

# Determine what cache to use (based on all of the package.json files)
MD5SUM=$(cat $(git ls-files | grep package-lock.json | sort) | md5sum | awk '{print $1}')
CACHE_FILENAME="${MD5SUM}.tar.gz"
KEY="travis-ci-cache/${CACHE_FILENAME}"

echo "Fetching cache from s3://${CACHE_BUCKET}/${KEY}"

# Determine if the cache exists
DATE=$(date -R)
STRING_TO_SIGN_HEAD="HEAD

${DATE}
/${CACHE_BUCKET}/${KEY}"
SIGNATURE=$(/bin/echo -n "$STRING_TO_SIGN_HEAD" | openssl sha1 -hmac ${CACHE_AWS_SECRET_ACCESS_KEY} -binary | base64)

# CACHE_EXISTS_STATUS_CODE=$(curl \
#   -sS \
#   -o /dev/null \
#   -w '%{http_code}' \
#   --head \
#   -H "Host: ${CACHE_BUCKET}.s3.amazonaws.com" \
#   -H "Date: ${DATE}" \
#   -H "Authorization: AWS ${CACHE_AWS_ACCESS_KEY_ID}:${SIGNATURE}" \
#   https://${CACHE_BUCKET}.s3.amazonaws.com/${KEY}
# )

aws s3 ls "s3://${CACHE_BUCKET}/${KEY}" >/dev/null
CACHE_EXISTS_STATUS_CODE="$?"

if [ "$CACHE_EXISTS_STATUS_CODE" -eq "0" ]; then
  # If the cache exists, download it from S3
  echo "Fetching cache"

#   STRING_TO_SIGN_GET="GET


# ${DATE}
# /${CACHE_BUCKET}/${KEY}"
#   SIGNATURE=$(/bin/echo -n "$STRING_TO_SIGN_GET" | openssl sha1 -hmac ${CACHE_AWS_SECRET_ACCESS_KEY} -binary | base64)

#   curl \
#     -sS \
#     -O \
#     -H "Host: ${CACHE_BUCKET}.s3.amazonaws.com" \
#     -H "Date: ${DATE}" \
#     -H "Authorization: AWS ${CACHE_AWS_ACCESS_KEY_ID}:${SIGNATURE}" \
#     https://${CACHE_BUCKET}.s3.amazonaws.com/${KEY} || \
#   curl \
#     -sS \
#     -O \
#     -H "Host: ${CACHE_BUCKET}.s3.amazonaws.com" \
#     -H "Date: ${DATE}" \
#     -H "Authorization: AWS ${CACHE_AWS_ACCESS_KEY_ID}:${SIGNATURE}" \
#     https://${CACHE_BUCKET}.s3.amazonaws.com/${KEY}
#   tar -xzf "$CACHE_FILENAME"
#   rm "$CACHE_FILENAME"
else
  echo "No cache found" >&2
  exit 1
fi
