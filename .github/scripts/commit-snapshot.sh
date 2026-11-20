#!/usr/bin/env bash
# Commit what the refresh wrote and push it to the branch this job runs on.
#
# Called by the "Commit results" step of .github/workflows/refresh.yml, and
# run against real throwaway repositories by scraper/test/ci-commit.test.ts
# (nothing to commit, a plain push, a push that loses a race, a remote that
# refuses).
#
# Something else may have landed on the branch while the scrape ran: a merge,
# another run. Snapshot files have unique names, so a rebase never conflicts —
# the push is retried instead of losing the day's data.
set -euo pipefail

branch="${GITHUB_REF_NAME:?GITHUB_REF_NAME must name the branch to push to}"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

git add data/snapshots data/skyline.geojson data/unitmaps scraper/fixtures 2>/dev/null || git add data/snapshots
if git diff --cached --quiet; then
  echo "Nothing changed."
  exit 0
fi
git commit -m "data: snapshot $(date -u +%FT%TZ)"

for attempt in 1 2 3; do
  if git push origin "HEAD:${branch}"; then
    exit 0
  fi
  echo "Push rejected (attempt ${attempt}); rebasing onto origin/${branch} and trying again."
  git pull --rebase origin "${branch}"
done

echo "::error::Could not push today's snapshot after 3 attempts."
exit 1
