#!/usr/bin/env bash
# Deploy (or, with --preview <alias>, upload a preview version of) the
# Worker + dist/ assets, and write the resulting URL to $GITHUB_OUTPUT
# as `url` so the job's environment links to it.
#
#   wrangler_deploy.sh --env ""          # production (top-level config)
#   wrangler_deploy.sh --env staging
#   wrangler_deploy.sh --env staging --preview pr-123
#
# Expects CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID in the
# environment, and COMMIT_SHA for the version message.
set -euo pipefail

env_args=()
preview=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) env_args=(--env "$2"); shift 2 ;;
    --preview) preview="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

out="$(mktemp)"
export WRANGLER_OUTPUT_FILE_PATH="$out"
msg="${COMMIT_SHA:-unknown}"

if [[ -n "$preview" ]]; then
  npx wrangler versions upload "${env_args[@]}" --preview-alias "$preview" --message "$msg"
  url="$(jq -r 'select(.type == "version-upload") | .preview_alias_url // .preview_url // empty' "$out" | tail -n1)"
else
  npx wrangler deploy "${env_args[@]}" --message "$msg"
  url="$(jq -r 'select(.type == "deploy") | .targets[]? // empty' "$out" | grep -m1 '^https://' || true)"
fi

echo "Deployed URL: ${url:-<none reported>}"
echo "url=${url}" >> "${GITHUB_OUTPUT:-/dev/null}"
