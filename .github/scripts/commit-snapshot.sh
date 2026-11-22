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
#                (merge-unitmap.mjs, next to this script). Where the two
#                cannot be merged — the one that landed is unreadable, say —
#                the one that landed stays, with a warning: positions are a
#                bonus and never hold up the prices.
#     skyline    is regenerated whole: this run's file replaces the other.
#
# Anything else that does not go together with what landed — a pull request
# removed a file this run rewrote, a recorded response was changed on both
# sides, a snapshot of the same name is already there — stops the step. It
# then pushes nothing, says so on the run's page, and leaves the checkout on
# this run's commit. That is what it did before any of the above was added;
# it never pushes something it had to guess at, and never forces a push.
set -euo pipefail

# The whole script is one function, read to the end before anything runs: the
# retry checks out what landed, and that may be another version of this file.
main() {
  local branch here
  branch="${GITHUB_REF_NAME:?GITHUB_REF_NAME must name the branch to push to}"
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

  # The snapshot is the point of the job; the rest is committed where there is
  # something to commit (a first run has no skyline yet, and the step that
  # makes one may fail). A path git knows but the run removed is staged too.
  local path
  git add data/snapshots
  for path in data/skyline.geojson data/unitmaps scraper/fixtures; do
    if [ -e "${path}" ] || git ls-files --error-unmatch -- "${path}" > /dev/null 2>&1; then
      git add -- "${path}"
    fi
  done
  if git diff --cached --quiet; then
    echo "Nothing changed."
    exit 0
  fi
  git commit -m "data: snapshot $(date -u +%FT%TZ)"

  # None of what this sets up is needed by a run nothing raced with, so none
  # of it may stop one: if it cannot be completed the step goes on to push.
  if ! prepare_merging "${here}"; then
    echo "::warning::The merging of unit maps could not be set up. That only matters if another refresh run lands on ${branch} during this push: git would then merge the two unit maps line by line, or the step would stop on the conflict."
  fi

  # Three pushes; between them, this run's commit is replayed on what landed.
  local attempt
  for attempt in 1 2 3; do
    if git push origin "HEAD:${branch}"; then
      exit 0
    fi
    if [ "${attempt}" -eq 3 ]; then
      echo "Push rejected (attempt 3)."
      break
    fi
    echo "Push rejected (attempt ${attempt}); rebasing onto origin/${branch} and trying again."
    if ! git pull --rebase origin "${branch}"; then
      git rebase --abort 2> /dev/null || true # back on this run's commit, for whoever looks
      echo "::error::Today's snapshot could not be put on top of what landed on ${branch} during the scrape (see git's message above). Nothing was pushed. Start a new run: a re-run of this one would start from the same commit."
      exit 1
    fi
  done

  echo "::error::Could not push today's snapshot after 3 attempts."
  exit 1
}

# How the two kinds of file are put together when both sides changed one.
# While this run's commit is replayed on top of what landed, git calls the
# driver with %O the file both started from, %A the one that landed, %B this
# run's and %P the file's name; whatever is left in %A is the result, and a
# failing driver is a conflict. The settings live in this checkout only (its
# git config and info/attributes), and the merge program is copied into the
# git directory first, so it is this run's copy that runs whatever landed.
prepare_merging() {
  local here="$1" git_dir attributes program
  git_dir="$(git rev-parse --absolute-git-dir)" || return 1
  attributes="$(git rev-parse --git-path info/attributes)" || return 1
  program="${git_dir}/merge-unitmap.mjs"
  case "${program}" in *"'"*) return 1 ;; esac # a path the driver line cannot quote
  cp -f "${here}/merge-unitmap.mjs" "${program}" || return 1
  # git fills in %-letters wherever they stand in a driver line: a % in the path is written %%.
  git config merge.unit-map.driver "node '${program//%/%%}' %O %A %B %P" || return 1
  git config merge.this-run.driver 'cp -f %B %A' || return 1
  mkdir -p "$(dirname "${attributes}")" || return 1
  if ! grep -qs 'merge=unit-map' "${attributes}"; then
    # (starting on a new line, whatever the file ended with)
    printf '\n%s\n%s\n' 'data/unitmaps/** merge=unit-map' 'data/skyline.geojson merge=this-run' >> "${attributes}" || return 1
  fi
}

main "$@"
