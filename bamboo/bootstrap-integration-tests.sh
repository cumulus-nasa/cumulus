#!/bin/bash
set -e
npm config set unsafe-perm true
npm install

. ./bamboo/set-integration-test-env-variables.sh
if [[ $PULL_REQUEST = "false" ]]; then
  echo "******Skipping integration tests as this commit is not a PR"
  exit 0
fi


if [ "$USE_NPM_PACKAGES" = "true" ]; then
  (cd example && npm install)
else
  npm run bootstrap
fi

echo "Locking stack for deployment $DEPLOYMENT"
(
  set -e

  cd example

  # Wait for the stack to be available
  LOCK_EXISTS_STATUS=$(node ./scripts/lock-stack.js true $DEPLOYMENT)

  echo "START LOCK STATUS"
  echo "Locking status $LOCK_EXISTS_STATUS"

  echo "END LOCK STATUS"

  while [ "$LOCK_EXISTS_STATUS" = 1 ]; do
    echo "Another build is using the ${DEPLOYMENT} stack."
    sleep 30

    LOCK_EXISTS_STATUS=$(node ./scripts/lock-stack.js true $DEPLOYMENT)
  done

  echo "Deploying IAM stack to $DEPLOYMENT"
  ./node_modules/.bin/kes cf deploy \
    --kes-folder iam \
    --region us-east-1 \
    --deployment "$DEPLOYMENT" \
    --template node_modules/@cumulus/deployment/iam

  echo "Deploying APP stack to $DEPLOYMENT"
  ./node_modules/.bin/kes cf deploy \
    --kes-folder app \
    --region us-east-1 \
    --deployment "$DEPLOYMENT" \
    --template node_modules/@cumulus/deployment/app

  echo "Deploying S3AccessTest lambda to $DEPLOYMENT"
  ./node_modules/.bin/kes lambda S3AccessTest deploy \
    --kes-folder app \
    --template node_modules/@cumulus/deployment/app \
    --deployment "$DEPLOYMENT" \
    --region us-west-2
)
