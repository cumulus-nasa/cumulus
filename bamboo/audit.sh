#!/bin/bash
set -ex
. ./bamboo/set-bamboo-env-variables.sh
. ./bamboo/abort-if-not-pr.sh

commit_message_contains_skip_audit_flag=false
commit_matches_version_tag=false


if [[ $(git log --pretty='format:%Creset%s' -1) =~ '[skip-audit]' ]]; then
  commit_message_contains_skip_audit_flag=true;
fi
if [[ $(git describe --exact-match HEAD 2>/dev/null |sed -n '1p') =~ ^v[0-9]+.* ]]; then
  commit_matches_version_tag=true;
fi

if [[ $commit_message_contains_skip_audit_flag = false && $commit_matches_version_tag = false && $SKIP_AUDIT != true ]]; then
  npm install --no-audit
  npm run audit;
else
  >&2 echo "******Skipping audit due to commit message/version tag/env var being present"
fi
