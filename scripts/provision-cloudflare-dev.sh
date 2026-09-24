#!/usr/bin/env bash
set -euo pipefail

resume_queue='intern-notifs-dev-resume-job-import'
resume_dlq='intern-notifs-dev-resume-job-import-dlq'
resume_index='intern-notifs-dev-resume-bank-v1'

ensure_queue() {
  local name="$1"
  local retention="$2"
  if ! npx wrangler queues info "$name" >/dev/null 2>&1; then
    npx wrangler queues create "$name" --message-retention-period-secs "$retention"
  fi
}

ensure_queue "$resume_queue" 86400
ensure_queue "$resume_dlq" 1209600

index=$(npx wrangler vectorize list --json | jq -c --arg name "$resume_index" '.[] | select(.name == $name)')
if test -z "$index"; then
  npx wrangler vectorize create "$resume_index" \
    --preset '@cf/baai/bge-base-en-v1.5' \
    --description 'Isolated development resume bank embeddings'
  index=$(npx wrangler vectorize list --json | jq -c --arg name "$resume_index" '.[] | select(.name == $name)')
fi
jq -e '.config == {"dimensions":768,"metric":"cosine"}' <<<"$index" >/dev/null

echo 'Cloudflare development resume resources are ready.'
