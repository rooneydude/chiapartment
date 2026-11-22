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
# then pushes nothing more, says so on the run's page, and leaves the
# checkout on this run's commit. That is what it did before any of the above
# was added; it never pushes something it had to guess at, and never forces.
#
# Meant for the job's own checkout, which is thrown away. In a checkout that
# is kept it leaves behind the committer's name set to the job's (as it
# always did), a copy of the merge program in the git directory, and two
# lines in info/attributes. Those name merge rules that are defined only
# while this script's own `git pull` runs; to any other git command they
# mean nothing.
set -euo pipefail

# The whole script is one function, read to the end before anything runs: the
# retry checks out what landed, and that may be another version of this file.
main() {
  local branch here
  branch="${GITHUB_REF_NAME:?GITHUB_REF_NAME must name the branch to push to}"
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

  # The snapshot is the point of the job. The rest is committed where there is
  # something to commit (a first run has no skyline yet, and the step that
  # makes one may fail); a path git knows but the run removed is staged too.
  # None of the rest may cost the run its snapshot: what cannot be staged is
  # left out, and said.
  local path
  git add data/snapshots
  for path in data/skyline.geojson data/unitmaps scraper/fixtures; do
    if [ -e "${path}" ] || git ls-files --error-unmatch -- "${path}" > /dev/null 2>&1; then
      if ! git add -- "${path}"; then
        echo "::warning::${path} could not be staged (git's message above); today's snapshot is committed without it."
      fi
    fi
  done
  if git diff --cached --quiet; then
    echo "Nothing changed."
    exit 0
  fi
  git commit -m "data: snapshot $(date -u +%FT%TZ)"

  # How two versions of a file this job writes are put together, should the
  # push be rejected: handed to the one `git pull` below and stored nowhere.
  # None of it is needed by a run nothing raced with, so none of it may stop
  # one: if it cannot be set up the step goes on to push without it.
  local program
  local -a merging=()
  if program="$(prepare_merging "${here}")"; then
    # git fills in %-letters wherever they stand in a driver line (%O the file
    # both sides started from, %A the one that landed — and the result —,
    # %B this run's, %P the file's name): a % in the path is written %%.
    merging=(-c "merge.unit-map.driver=node '${program//%/%%}' %O %A %B %P" -c 'merge.this-run.driver=cp -f %B %A')
  else
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
    if ! git "${merging[@]}" pull --rebase origin "${branch}"; then
      git rebase --abort 2> /dev/null || true # back on this run's commit, for whoever looks
      echo "::error::Today's snapshot was not pushed: the push was rejected, and replaying this run's commit on top of origin/${branch} failed (git's message above). Start a new run: a re-run of this one would start from the same commit."
      exit 1
    fi
  done

  echo "::error::Today's snapshot was not pushed: the remote rejected three pushes."
  exit 1
}

# Puts this run's copy of the merge program where it outlives a checkout of
# what landed (the git directory), and marks the two kinds of file in this
# checkout's own info/attributes. Prints where the program is. A failing
# merge rule is a conflict to git, and a rule named in the attributes but
# defined nowhere is no rule at all: git merges such a file as it would any.
prepare_merging() {
  local here="$1" git_dir attributes program
  git_dir="$(git rev-parse --absolute-git-dir)" || return 1
  attributes="$(git rev-parse --git-path info/attributes)" || return 1
  program="${git_dir}/merge-unitmap.mjs"
  case "${program}" in *"'"*) return 1 ;; esac # a path the driver line cannot quote
  cp -f "${here}/merge-unitmap.mjs" "${program}" || return 1
  mkdir -p "$(dirname "${attributes}")" || return 1
  if ! grep -qs 'merge=unit-map' "${attributes}"; then
    # (starting on a new line, whatever the file ended with)
    printf '\n%s\n%s\n' 'data/unitmaps/** merge=unit-map' 'data/skyline.geojson merge=this-run' >> "${attributes}" || return 1
  fi
  printf '%s\n' "${program}"
}

main "$@"
