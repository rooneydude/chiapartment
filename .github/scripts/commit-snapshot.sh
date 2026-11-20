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
# - Anything else that cannot be put together (a pull request removed or
#   broke a file this run rewrote; a recorded response changed on both
#   sides): the prices are not held up by it. The snapshot alone goes on
#   top of what landed, this run's other files are left out, and a warning
#   on the run's page names them.
#
# The step fails, having pushed nothing, only when the snapshot itself cannot
# go on top (one of the same name is already there, or the remote refuses).
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
    echo "::warning::The merging of unit maps could not be set up. Nothing is lost by that unless something lands on ${branch} during this push and changed a unit map too; this run's unit map would then be left out."
  fi

  # Three pushes, and between them whatever it takes to go on top of what landed.
  local attempt mine others
  for attempt in 1 2 3; do
    if git push origin "HEAD:${branch}"; then
      exit 0
    fi
    if [ "${attempt}" -eq 3 ]; then
      echo "Push rejected (attempt 3)."
      break
    fi
    echo "Push rejected (attempt ${attempt}); rebasing onto origin/${branch} and trying again."
    if git pull --rebase origin "${branch}"; then
      continue
    fi
    git rebase --abort 2> /dev/null || true
    mine="$(git rev-parse HEAD)"
    others="$(git diff --name-only "${mine}^" "${mine}" -- . ':(exclude)data/snapshots' | tr '\n' ' ')" || others=""
    others="${others% }"
    if snapshot_alone "${mine}" "${branch}"; then
      echo "::warning::Today's prices are being pushed on their own. This run's other files (${others:-none}) could not be put together with what landed on ${branch} during the scrape (see git's message above); they stay as they landed."
    else
      git reset -q --hard "${mine}" 2> /dev/null || true # this run's commit, as it was, for whoever looks
      echo "::error::Today's snapshot could not be put on top of what landed on ${branch} during the scrape (see git's message above). Nothing was pushed. Start a new run: a re-run of this one would start from the same commit."
      exit 1
    fi
  done

  echo "::error::Could not push today's snapshot after 3 attempts."
  exit 1
}

# How the two kinds of file are put together when both sides changed one.
# While this run's commit is replayed on top of what landed, git calls the
# driver with %O the file both started from, %A the one that landed and %B
# this run's; whatever is left in %A is the result, and a failing driver is
# a conflict. The settings live in this checkout only (its git config and
# info/attributes), and the merge program is copied into the git directory
# first, so it is this run's copy that runs whatever landed.
prepare_merging() {
  local here="$1" git_dir attributes program
  git_dir="$(git rev-parse --absolute-git-dir)" || return 1
  attributes="$(git rev-parse --git-path info/attributes)" || return 1
  program="${git_dir}/merge-unitmap.mjs"
  case "${program}" in *"'"*) return 1 ;; esac # a path the driver line cannot quote
  cp -f "${here}/merge-unitmap.mjs" "${program}" || return 1
  # git fills in %-letters wherever they stand in a driver line: a % in the path is written %%.
  git config merge.unit-map.driver "node '${program//%/%%}' %O %A %B" || return 1
  git config merge.this-run.driver 'cp -f %B %A' || return 1
  mkdir -p "$(dirname "${attributes}")" || return 1
  if ! grep -qs 'merge=unit-map' "${attributes}"; then
    # (starting on a new line, whatever the file ended with)
    printf '\n%s\n%s\n' 'data/unitmaps/** merge=unit-map' 'data/skyline.geojson merge=this-run' >> "${attributes}" || return 1
  fi
}

# Replace this run's commit by one that adds its snapshot, and nothing else,
# to what is on the branch now. Refuses (and changes nothing that matters)
# when the run added no snapshot, or when a snapshot of the same name is
# already on the branch: a snapshot, once recorded, is never rewritten.
snapshot_alone() {
  local mine="$1" branch="$2" path
  local -a added=()
  while IFS= read -r path; do
    if [ -n "${path}" ]; then added+=("${path}"); fi
  done < <(git diff --name-only --diff-filter=A "${mine}^" "${mine}" -- data/snapshots)
  [ "${#added[@]}" -gt 0 ] || return 1
  git fetch -q origin "${branch}" || return 1
  for path in "${added[@]}"; do
    if git cat-file -e "FETCH_HEAD:${path}" 2> /dev/null; then return 1; fi
  done
  git reset -q --hard FETCH_HEAD || return 1
  git checkout -q "${mine}" -- "${added[@]}" || return 1
  git commit -q -m "$(git log -1 --format=%s "${mine}")" || return 1
}

main "$@"
