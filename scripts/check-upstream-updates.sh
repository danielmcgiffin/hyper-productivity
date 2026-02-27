#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_REMOTE="upstream"
UPSTREAM_BRANCH="master"
LOCAL_BRANCH=""
GITHUB_OUTPUT_FILE=""
FAIL_IF_BEHIND=false

usage() {
  cat <<'EOF'
Usage: check-upstream-updates.sh [options]

Options:
  --upstream-remote <name>   Upstream remote name (default: upstream)
  --upstream-branch <name>   Upstream branch name (default: master)
  --local-branch <name>      Local branch to compare (default: current branch)
  --github-output <path>     Write key/value outputs to this file
  --fail-if-behind           Exit with code 2 when local is behind upstream
  -h, --help                 Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --upstream-remote)
      UPSTREAM_REMOTE="$2"
      shift 2
      ;;
    --upstream-branch)
      UPSTREAM_BRANCH="$2"
      shift 2
      ;;
    --local-branch)
      LOCAL_BRANCH="$2"
      shift 2
      ;;
    --github-output)
      GITHUB_OUTPUT_FILE="$2"
      shift 2
      ;;
    --fail-if-behind)
      FAIL_IF_BEHIND=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$LOCAL_BRANCH" ]]; then
  LOCAL_BRANCH="$(git symbolic-ref --quiet --short HEAD || true)"
  if [[ -z "$LOCAL_BRANCH" ]]; then
    LOCAL_BRANCH="master"
  fi
fi

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  echo "Missing remote '$UPSTREAM_REMOTE'. Add it first, e.g.:" >&2
  echo "  git remote add $UPSTREAM_REMOTE <url>" >&2
  exit 1
fi

LOCAL_REF="$LOCAL_BRANCH"
UPSTREAM_REF="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"

if ! git rev-parse --verify "$LOCAL_REF" >/dev/null 2>&1; then
  echo "Local ref '$LOCAL_REF' not found." >&2
  exit 1
fi

git fetch --quiet --prune "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"

if ! git rev-parse --verify "$UPSTREAM_REF" >/dev/null 2>&1; then
  echo "Upstream ref '$UPSTREAM_REF' not found after fetch." >&2
  exit 1
fi

AHEAD_COUNT="$(git rev-list --count "${UPSTREAM_REF}..${LOCAL_REF}")"
BEHIND_COUNT="$(git rev-list --count "${LOCAL_REF}..${UPSTREAM_REF}")"
UPSTREAM_SHA="$(git rev-parse "$UPSTREAM_REF")"
LOCAL_SHA="$(git rev-parse "$LOCAL_REF")"
UPSTREAM_SUBJECT="$(git log -1 --pretty=%s "$UPSTREAM_REF")"
LOCAL_SUBJECT="$(git log -1 --pretty=%s "$LOCAL_REF")"
HAS_UPDATES="false"
if (( BEHIND_COUNT > 0 )); then
  HAS_UPDATES="true"
fi

echo "Upstream sync status:"
echo "  Local ref:    $LOCAL_REF"
echo "  Upstream ref: $UPSTREAM_REF"
echo "  Ahead:        $AHEAD_COUNT"
echo "  Behind:       $BEHIND_COUNT"
echo "  Local SHA:    $LOCAL_SHA"
echo "  Upstream SHA: $UPSTREAM_SHA"
echo "  Local msg:    $LOCAL_SUBJECT"
echo "  Upstream msg: $UPSTREAM_SUBJECT"

if (( BEHIND_COUNT > 0 )); then
  echo
  echo "Latest upstream commits not in $LOCAL_REF:"
  git --no-pager log --oneline --max-count 10 "${LOCAL_REF}..${UPSTREAM_REF}"
  echo
  echo "Suggested update commands:"
  echo "  git checkout $LOCAL_BRANCH"
  echo "  git fetch $UPSTREAM_REMOTE"
  echo "  git merge ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
  echo "  git push origin $LOCAL_BRANCH"
fi

if [[ -n "$GITHUB_OUTPUT_FILE" ]]; then
  {
    echo "ahead=$AHEAD_COUNT"
    echo "behind=$BEHIND_COUNT"
    echo "has_updates=$HAS_UPDATES"
    echo "local_ref=$LOCAL_REF"
    echo "upstream_ref=$UPSTREAM_REF"
    echo "local_sha=$LOCAL_SHA"
    echo "upstream_sha=$UPSTREAM_SHA"
    echo "local_subject=$LOCAL_SUBJECT"
    echo "upstream_subject=$UPSTREAM_SUBJECT"
  } >>"$GITHUB_OUTPUT_FILE"
fi

if $FAIL_IF_BEHIND && (( BEHIND_COUNT > 0 )); then
  exit 2
fi

