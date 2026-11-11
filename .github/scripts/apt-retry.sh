#!/usr/bin/env bash
# Runs a command that installs Linux packages (apt-get, `playwright install-deps`) up to three times. The runner's
# package mirrors are at times unreachable for a few minutes ("Temporary failure resolving"), which otherwise fails
# the whole job before a single test ran. apt itself also retries each download.
#
# Usage: bash .github/scripts/apt-retry.sh <command> [args...]
set -uo pipefail

echo 'Acquire::Retries "3";' | sudo tee /etc/apt/apt.conf.d/80-retries > /dev/null
for attempt in 1 2 3; do
  "$@" && exit 0
  if [ "$attempt" -lt 3 ]; then
    echo "::warning::Attempt $attempt of '$*' failed; retrying in 30 s"
    sleep 30
  fi
done
echo "::error::'$*' failed 3 times"
exit 1
