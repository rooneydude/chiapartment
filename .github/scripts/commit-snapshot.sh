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
#   the same file, and a line-by-line merge of it conflicts — or, worse,
#   succeeds with a file neither run wrote. The two files are put together
#   by what they mean instead:
#     unit maps  accumulate: each run adds the positions it saw to the ones
#                it was handed. The result keeps what both runs learned
#                (merge-unitmap.mjs, next to this script).
#     skyline    is regenerated whole: this run's file replaces the other.
# - Anything that cannot be put together (a pull request removed a file this
#   run rewrote; a unit map that is no longer readable): the step stops,
#   pushes nothing, and says so. Running the job again starts from what is
#   on the branch by then.
set -euo pipefail

branch="${GITHUB_REF_NAME:?GITHUB_REF_NAME must name the branch to push to}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# The snapshot is the point of the job; the rest is committed where it exists
# (a first run has no skyline yet, and the step that makes one may fail).
git add data/snapshots
for path in data/skyline.geojson data/unitmaps scraper/fixtures; do
  if [ -e "${path}" ]; then git add "${path}"; fi
done
if git diff --cached --quiet; then
  echo "Nothing changed."
  exit 0
fi
git commit -m "data: snapshot $(date -u +%FT%TZ)"

# How the two kinds of file are put together when both sides changed one.
# While this run's commit is replayed on top of what landed, git calls the
# driver with %O the file both started from, %A the one that landed and %B
# this run's; whatever is left in %A is the result, and a failing driver is
# a conflict. The settings live in this checkout only (.git/config and
# .git/info/attributes), and the merge program is copied there first, so it
# is this run's copy that runs whatever landed.
git_dir="$(git rev-parse --absolute-git-dir)"
case "${git_dir}" in
  *"'"*) ;; # a path the driver line below cannot quote: leave git to report a conflict
  *)
    cp -f "${here}/merge-unitmap.mjs" "${git_dir}/merge-unitmap.mjs"
    git config merge.unit-map.driver "node '${git_dir}/merge-unitmap.mjs' %O %A %B"
    git config merge.this-run.driver 'cp -f %B %A'
    mkdir -p "${git_dir}/info"
    if ! grep -qs 'merge=unit-map' "${git_dir}/info/attributes"; then
      # (starting on a new line, whatever the file ended with)
      printf '\n%s\n%s\n' 'data/unitmaps/** merge=unit-map' 'data/skyline.geojson merge=this-run' >> "${git_dir}/info/attributes"
    fi
    ;;
esac

for attempt in 1 2 3; do
  if git push origin "HEAD:${branch}"; then
    exit 0
  fi
  echo "Push rejected (attempt ${attempt}); rebasing onto origin/${branch} and trying again."
  if ! git pull --rebase origin "${branch}"; then
    git rebase --abort 2>/dev/null || true # leave this run's commit as it was, for whoever looks
    echo "::error::Today's snapshot could not be put on top of what landed on ${branch} during the scrape (see git's message above). Nothing was pushed; run the job again."
    exit 1
  fi
done

echo "::error::Could not push today's snapshot after 3 attempts."
exit 1
