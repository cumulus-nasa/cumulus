#!/bin/bash
set -ex

NONCACHE_WORKING_DIR=$(pwd)
CURRENT_WORKING_DIR=NONCACHE_WORKING_DIR

if [[ $USE_CACHED_BOOTSTRAP == true ]]; then
  echo "*** Using cached bootstrap build dir"
  CURRENT_WORKING_DIR=/cumulus
  cd $CURRENT_WORKING_DIR
  git fetch --all
  git checkout "$GIT_SHA"
else
  npm install
fi

# Bootstrap to install/link packages
npm run bootstrap-no-build-no-scripts-ci

# Testing
cd packages/checksum

# Compile TS files
npm run tsc

# Get a list of TS compiled files
npm run tsc:listEmittedFiles --silent | grep TSFILE | awk '{print $2}' | sed "s,$CURRENT_WORKING_DIR/,,g" >> .ts-build-cache-files
cat .ts-build-cache-files

# Testing
cd ../..

# Generate TS build cache artifact
tar cf ts-build-cache.tgz -T .ts-build-cache-files

if [[ $USE_CACHED_BOOTSTRAP == true ]]; then
  cp ts-build-cache.tgz "$NONCACHE_WORKING_DIR"
fi
