#!/usr/bin/env bash
# Decides what release.yml builds and releases. Writes `version` (empty: dry run, nothing is published) and `sha`
# (the commit to test, package and tag) to $GITHUB_OUTPUT.
#
# - Tag push (refs/tags/vX.Y.Z): releases that commit; package.json must already say X.Y.Z.
# - Run workflow with a version on the default branch: if package.json is older, bumps it (package.json,
#   package-lock.json) and the README release badge (stable versions), renames the `## [Unreleased]` changelog
#   heading to `## [X.Y.Z] - <date>`, commits "chore(release): X.Y.Z" and pushes it. If package.json already says X.Y.Z (bumped by hand), releases HEAD.
#   The tag is created with the release at the end, so a failed run leaves no tag behind and can simply be
#   started again with the same version.
# - Run workflow without a version: dry run of the current commit.
set -euo pipefail

out() { echo "$1=$2" >> "$GITHUB_OUTPUT"; }

if [[ "$GITHUB_REF" == refs/tags/v* ]]; then
  VERSION="${GITHUB_REF_NAME#v}"
else
  VERSION="${INPUT_VERSION:-}"
  VERSION="${VERSION#v}"
  VERSION="${VERSION// /}"
fi
CURRENT=$(node -p "require('./package.json').version")

if [ -z "$VERSION" ]; then
  echo "No version given: dry run of $GITHUB_SHA (tests and packages, no release)."
  out version ""
  out sha "$GITHUB_SHA"
  exit 0
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "::error::'$VERSION' is not a version like 1.2.3 or 1.2.3-beta.1"
  exit 1
fi

if [[ "$GITHUB_REF" == refs/tags/v* ]]; then
  if [ "$CURRENT" != "$VERSION" ]; then
    echo "::error::Tag $GITHUB_REF_NAME does not match package.json version $CURRENT"
    exit 1
  fi
  out version "$VERSION"
  out sha "$GITHUB_SHA"
  exit 0
fi

if [ "$GITHUB_REF" != "refs/heads/$DEFAULT_BRANCH" ]; then
  echo "::error::Releases are made from $DEFAULT_BRANCH; this run is on $GITHUB_REF_NAME"
  exit 1
fi
if [ -n "$(git ls-remote --tags origin "refs/tags/v$VERSION")" ]; then
  echo "::error::Tag v$VERSION already exists"
  exit 1
fi

if [ "$CURRENT" = "$VERSION" ]; then
  echo "package.json already says $VERSION: releasing $GITHUB_SHA as it is."
  if ! grep -q "^## \[$VERSION\]" CHANGELOG.md; then
    echo "::warning::CHANGELOG.md has no section for $VERSION"
  fi
else
  HIGHEST=$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | tail -n 1)
  if [ "$HIGHEST" != "$VERSION" ]; then
    echo "::error::$VERSION is not newer than the current version $CURRENT"
    exit 1
  fi
  UNRELEASED=$(awk '/^## \[Unreleased\]/ {p=1; next} /^## / && p {exit} p' CHANGELOG.md | tr -d '[:space:]')
  if [ -z "$UNRELEASED" ]; then
    echo "::error::CHANGELOG.md has no [Unreleased] section with changes: describe the changes of $VERSION first"
    exit 1
  fi
  # Only the version fields change, so the files keep their formatting.
  VERSION="$VERSION" node -e '
    const fs = require("fs");
    const bump = (file, count) => {
      let n = 0;
      const text = fs.readFileSync(file, "utf8").replace(/"version": "[^"]*"/g, (m) =>
        n++ < count ? `"version": "${process.env.VERSION}"` : m,
      );
      fs.writeFileSync(file, text);
    };
    bump("package.json", 1);
    bump("package-lock.json", 2); // the lockfile header and its root package
  '
  # The README badge is static (a dynamic one depends on shields.io reaching the GitHub API, and showed "repo not
  # found" at times). Pre-releases are not the latest release, so they leave it alone.
  if [[ "$VERSION" != *-* ]]; then
    sed -i -E "s#(img\.shields\.io/badge/release-v)[0-9]+\.[0-9]+\.[0-9]+-#\1$VERSION-#" README.md
    grep -q "img.shields.io/badge/release-v$VERSION-" README.md || echo "::warning::README.md has no release badge to update"
  fi
  DATE=$(date -u +%F)
  # The [Unreleased] heading becomes the release heading; the next change adds a new one.
  awk -v v="$VERSION" -v d="$DATE" '
    !done && /^## \[Unreleased\]/ { print "## [" v "] - " d; done=1; next }
    { print }
  ' CHANGELOG.md > CHANGELOG.md.new
  mv CHANGELOG.md.new CHANGELOG.md
  git config user.name "$GIT_AUTHOR_NAME"
  git config user.email "$GIT_AUTHOR_EMAIL"
  git add package.json package-lock.json CHANGELOG.md README.md
  git commit -q -m "chore(release): $VERSION"
  git push origin "HEAD:refs/heads/$DEFAULT_BRANCH"
  echo "Committed and pushed chore(release): $VERSION ($(git rev-parse --short HEAD))."
fi

out version "$VERSION"
out sha "$(git rev-parse HEAD)"
