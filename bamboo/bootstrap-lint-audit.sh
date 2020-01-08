#!/bin/bash
set -e
# This script runs before lint.sh, audit.sh in the agent container
. ./bamboo/abort-if-not-pr.sh
. ./bamboo/set-bamboo-env-variables.sh


 if [[ $USE_CACHED_BOOTSTRAP == true ]]; then ## Change into cached cumulus, pull down /cumulus ref and run there
    echo "*** Using cached bootstrap"
    cd /cumulus/
    git fetch --all
    git checkout "$GIT_SHA"
  fi

npm install -g npm
ln -s /dev/stdout ./lerna-debug.log
