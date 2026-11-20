#!/usr/bin/env bash
# Commit what the refresh wrote and push it to the branch this job runs on.
#
# Called by the "Commit results" step of .github/workflows/refresh.yml, and
# run against real throwaway repositories by scraper/test/ci-commit.test.ts.
#
# Something else may have landed on the branch while the scrape ran. The push
# is then retried on top of it instead of losing the day's data:
#
# - A merged pull request, or anything else that left this run's files alone:
#   the snapshot is a new file with a unique name, so it simply goes on top.
# - Another refresh run that was already under way. Every run rewrites the
#   unit map (it carries the time it was captured), so the two always change
#   the same file. Files this job regenerates whole are never merged line by
#   line: the later run's file replaces the earlier one's, whole.
# - Anything that cannot be put together (say, a pull request removed a file
#   this run rewrote): the step stops, pushes nothing, and says so. Running
#   the job again starts from what is on the branch by then.
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

# "This run's file, whole" for the files the job regenerates. While this
# run's commit is replayed on top of what landed, git calls the driver for a
# file both sides changed, with %A the version that landed and %B this
# run's; the result is whatever is left in %A. Kept in this checkout's own
# settings (.git/info/attributes), so no other merge is affected.
git config merge.this-run.driver 'cp -f %B %A'
attributes="$(git rev-parse --git-path info/attributes)"
mkdir -p "$(dirname "${attributes}")"
if ! grep -qs 'merge=this-run' "${attributes}"; then
  printf '%s merge=this-run\n' 'data/unitmaps/**' 'data/skyline.geojson' >> "${attributes}"
fi

for attempt in 1 2 3; do
  if git push origin "HEAD:${branch}"; then
    exit 0
  fi
  echo "Push rejected (attempt ${attempt}); rebasing onto origin/${branch} and trying again."
  if ! git pull --rebase origin "${branch}"; then
    git rebase --abort 2>/dev/null || true # leave this run's commit as it was, for whoever looks
    echo "::error::Today's snapshot could not be put on top of what landed on ${branch} during the scrape (see the conflict above). Nothing was pushed; run the job again."
    exit 1
  fi
done

echo "::error::Could not push today's snapshot after 3 attempts."
exit 1
