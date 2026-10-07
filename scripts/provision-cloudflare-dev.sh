#!/usr/bin/env bash
set -euo pipefail

dev_prefix='intern-notifs-dev'
dev_database='intern-notifs-dev-db'
dev_api_config='wrangler.dev.api.jsonc'
resume_index='intern-notifs-dev-resume-bank-v1'
queue_suffixes=(
  greenhouse
  lever
  ashby
  github
  gmail
  destination-verification
  shadow-extraction
  resume-job-import
  admission-v2
)

ensure_queue() {
  local name="$1"
  local retention="$2"
  local queue_options=(--message-retention-period-secs "$retention")
  # Admission dispatch expects immediate delivery; retention-only updates
  # preserve any delay left behind by an earlier dev experiment.
  if test "$name" = "$dev_prefix-admission-v2"; then queue_options+=(--delivery-delay-secs 0); fi
  if ! npx wrangler queues info "$name" >/dev/null 2>&1; then
    npx wrangler queues create "$name" "${queue_options[@]}"
  else
    npx wrangler queues update "$name" "${queue_options[@]}" >/dev/null
  fi
}

ensure_bucket() {
  local name="$1"
  if ! npx wrangler r2 bucket info "$name" >/dev/null 2>&1; then
    npx wrangler r2 bucket create "$name"
  fi
}

npx wrangler whoami >/dev/null

if ! npx wrangler d1 info "$dev_database" --json >/dev/null 2>&1; then
  echo "Missing $dev_database. Create it and update both wrangler.dev configs with its database ID." >&2
  exit 1
fi

ensure_bucket "$dev_prefix-documents"
ensure_bucket "$dev_prefix-shadow-extraction"

for suffix in "${queue_suffixes[@]}"; do
  retention=86400
  if test "$suffix" = 'destination-verification'; then retention=604800; fi
  ensure_queue "$dev_prefix-$suffix" "$retention"
  ensure_queue "$dev_prefix-$suffix-dlq" 1209600
done

index=$(npx wrangler vectorize list --json | jq -c --arg name "$resume_index" '.[] | select(.name == $name)')
if test -z "$index"; then
  npx wrangler vectorize create "$resume_index" \
    --preset '@cf/baai/bge-base-en-v1.5' \
    --description 'Isolated development resume bank embeddings'
  index=$(npx wrangler vectorize list --json | jq -c --arg name "$resume_index" '.[] | select(.name == $name)')
fi
jq -e '.config.dimensions == 768
  and .config.metric == "cosine"
  and .config.preset == "@cf/baai/bge-base-en-v1.5"' <<<"$index" >/dev/null

npx wrangler d1 migrations apply "$dev_database" --remote --config "$dev_api_config"

echo 'Cloudflare development resources and migrations mirror the production topology.'
