locals {
  api_worker_bundle       = "${path.module}/../../cloudflare/dist/api/api-worker.js"
  ingestion_worker_bundle = "${path.module}/../../cloudflare/dist/ingestion/ingestion-worker.js"
  ingestion_worker_name   = "${var.worker_name}-ingestion"
  catalog_providers       = toset(["greenhouse", "lever", "ashby", "github"])
  asynchronous_queues     = setunion(local.catalog_providers, toset(["gmail", "destination-verification", "shadow-extraction", "resume-job-import"]))

  # Sized from the 2026-09-15 drain measurements: published boards per sweep x
  # per-message wall clock / cadence, doubled for the validation, notification,
  # and D1 work that the recorded fetch duration does not cover. Greenhouse
  # enqueues ~218 messages per half-hour sweep at ~23s each, which the previous
  # concurrency of 2 could not retire inside the cadence. Keep in step with
  # wrangler.ingestion.jsonc; see docs/240-dispatch-backlog-cadence.md.
  # destination-verification is back to its original limits: raised on
  # 2026-09-17 to drain a backlog, then reverted when admission became durable
  # and scheduled re-checks were removed, which is what that backlog was for.
  consumer_max_concurrency = {
    greenhouse               = 6
    lever                    = 2
    ashby                    = 2
    github                   = 2
    gmail                    = 1
    destination-verification = 1
    shadow-extraction        = 1
    resume-job-import        = 1
  }

  api_plain_bindings = concat(
    [
      { name = "PUBLIC_API_URL", type = "plain_text", text = var.public_api_url },
      { name = "CATALOG_R2_READ_ENABLED", type = "plain_text", text = "true" },
      { name = "AUTH_DEV_MODE", type = "plain_text", text = tostring(var.auth_dev_mode) },
      { name = "EMPLOYER_PORTAL_ENABLED", type = "plain_text", text = tostring(var.employer_portal_enabled) },
      { name = "GMAIL_ENABLED", type = "plain_text", text = tostring(var.gmail_enabled) },
      { name = "RESUME_TUNER_ENABLED", type = "plain_text", text = tostring(var.resume_tuner_enabled) },
      { name = "IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED", type = "plain_text", text = tostring(var.identity_unconfirmed_publication_enabled) },
      { name = "IDENTITY_INTEGRITY_ENFORCEMENT_ENABLED", type = "plain_text", text = tostring(var.identity_integrity_enforcement_enabled) },
      { name = "TRUSTED_COMMUNITY_CATALOG_ENABLED", type = "plain_text", text = tostring(var.trusted_community_catalog_enabled) },
      { name = "IDENTITY_CONFIRMED_COVERAGE_FLOOR", type = "plain_text", text = tostring(var.identity_confirmed_coverage_floor) },
      { name = "DEPLOYMENT_ROLE", type = "plain_text", text = "api" },
    ],
    var.auth_from_email == null ? [] : [{ name = "AUTH_FROM_EMAIL", type = "plain_text", text = var.auth_from_email }],
    var.gmail_client_id == null ? [] : [{ name = "GMAIL_CLIENT_ID", type = "plain_text", text = var.gmail_client_id }],
    var.gmail_redirect_uri == null ? [] : [{ name = "GMAIL_REDIRECT_URI", type = "plain_text", text = var.gmail_redirect_uri }],
  )

  ingestion_plain_bindings = concat(
    [
      { name = "PUBLIC_API_URL", type = "plain_text", text = var.public_api_url },
      { name = "EMPLOYER_PORTAL_ENABLED", type = "plain_text", text = tostring(var.employer_portal_enabled) },
      { name = "GMAIL_ENABLED", type = "plain_text", text = tostring(var.gmail_enabled) },
      { name = "RESUME_TUNER_ENABLED", type = "plain_text", text = tostring(var.resume_tuner_enabled) },
      { name = "IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED", type = "plain_text", text = tostring(var.identity_unconfirmed_publication_enabled) },
      { name = "IDENTITY_INTEGRITY_ENFORCEMENT_ENABLED", type = "plain_text", text = tostring(var.identity_integrity_enforcement_enabled) },
      { name = "TRUSTED_COMMUNITY_CATALOG_ENABLED", type = "plain_text", text = tostring(var.trusted_community_catalog_enabled) },
      { name = "IDENTITY_CONFIRMED_COVERAGE_FLOOR", type = "plain_text", text = tostring(var.identity_confirmed_coverage_floor) },
      { name = "LLM_METADATA_PUBLICATION_POLICY_JSON", type = "plain_text", text = var.llm_metadata_publication_policy_json },
      { name = "SHADOW_EXTRACTION_ENABLED", type = "plain_text", text = tostring(var.shadow_extraction_enabled) },
      { name = "SHADOW_EXTRACTION_MONTHLY_FORECAST_CENTS", type = "plain_text", text = tostring(var.shadow_extraction_monthly_forecast_cents) },
      { name = "SHADOW_EXTRACTION_MONTHLY_HEADROOM_CENTS", type = "plain_text", text = tostring(var.shadow_extraction_monthly_headroom_cents) },
      { name = "CLOUDFLARE_ACCOUNT_ID", type = "plain_text", text = var.cloudflare_account_id },
      { name = "WORKER_NAME", type = "plain_text", text = local.ingestion_worker_name },
      { name = "GMAIL_QUEUE_ID", type = "plain_text", text = cloudflare_queue.work["gmail"].queue_id },
      { name = "DESTINATION_VERIFICATION_QUEUE_ID", type = "plain_text", text = cloudflare_queue.work["destination-verification"].queue_id },
      { name = "SHADOW_EXTRACTION_QUEUE_ID", type = "plain_text", text = cloudflare_queue.work["shadow-extraction"].queue_id },
      { name = "SHADOW_EXTRACTION_QUEUE_NAME", type = "plain_text", text = cloudflare_queue.work["shadow-extraction"].queue_name },
      { name = "DEPLOYMENT_ROLE", type = "plain_text", text = "ingestion" },
      { name = "ADMISSION_QUEUE_AGE_ALERT_HOURS", type = "plain_text", text = tostring(var.admission_queue_age_alert_hours) },
      { name = "ADMISSION_STALE_ALERT_THRESHOLD", type = "plain_text", text = tostring(var.admission_stale_alert_threshold) },
    ],
    [for provider in local.catalog_providers : { name = "${upper(provider)}_QUEUE_ID", type = "plain_text", text = cloudflare_queue.work[provider].queue_id }],
    var.auth_from_email == null ? [] : [{ name = "AUTH_FROM_EMAIL", type = "plain_text", text = var.auth_from_email }],
    var.admission_support_recipient == null ? [] : [{ name = "ADMISSION_SUPPORT_RECIPIENT", type = "plain_text", text = var.admission_support_recipient }],
    var.digest_to_email == null ? [] : [{ name = "DIGEST_TO_EMAIL", type = "plain_text", text = var.digest_to_email }],
    var.ntfy_topic == null ? [] : [{ name = "NTFY_TOPIC", type = "plain_text", text = var.ntfy_topic }],
    var.ntfy_endpoint == null ? [] : [{ name = "NTFY_ENDPOINT", type = "plain_text", text = var.ntfy_endpoint }],
    var.gmail_client_id == null ? [] : [{ name = "GMAIL_CLIENT_ID", type = "plain_text", text = var.gmail_client_id }],
    var.gmail_redirect_uri == null ? [] : [{ name = "GMAIL_REDIRECT_URI", type = "plain_text", text = var.gmail_redirect_uri }],
  )
}

resource "cloudflare_d1_database" "application" {
  account_id            = var.cloudflare_account_id
  name                  = "${var.worker_name}-db"
  primary_location_hint = "wnam"
  read_replication      = { mode = "disabled" }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [primary_location_hint]
  }
}

resource "cloudflare_r2_bucket" "documents" {
  account_id    = var.cloudflare_account_id
  name          = "${var.worker_name}-documents"
  location      = "WNAM"
  storage_class = "Standard"
}

# Private, bounded operational artifacts only. Retention is configured with the
# R2 lifecycle API because the provider version used here has no lifecycle-rule
# resource; docs/shadow-extraction.md records the required 30-day rule.
resource "cloudflare_r2_bucket" "shadow_extraction" {
  account_id    = var.cloudflare_account_id
  name          = "${var.worker_name}-shadow-extraction"
  location      = "WNAM"
  storage_class = "Standard"
}

resource "cloudflare_queue" "work" {
  for_each   = local.asynchronous_queues
  account_id = var.cloudflare_account_id
  queue_name = "${var.worker_name}-${each.key}"
  settings = {
    message_retention_period = each.key == "destination-verification" ? 604800 : 86400
    delivery_paused          = false
  }
}

resource "cloudflare_queue" "dead_letter" {
  for_each   = local.asynchronous_queues
  account_id = var.cloudflare_account_id
  queue_name = "${var.worker_name}-${each.key}-dlq"
  settings   = { message_retention_period = 1209600 }
}

resource "cloudflare_workers_script" "ingestion" {
  account_id          = var.cloudflare_account_id
  script_name         = local.ingestion_worker_name
  main_module         = "ingestion-worker.js"
  content_file        = local.ingestion_worker_bundle
  content_sha256      = filesha256(local.ingestion_worker_bundle)
  compatibility_date  = "2026-09-08"
  compatibility_flags = ["nodejs_compat"]
  keep_bindings       = ["secret_text"]

  bindings = concat(
    [
      { name = "DB", type = "d1", id = cloudflare_d1_database.application.id },
      { name = "DOCUMENTS", type = "r2_bucket", bucket_name = cloudflare_r2_bucket.documents.name },
      { name = "SHADOW_EXTRACTION_ARTIFACTS", type = "r2_bucket", bucket_name = cloudflare_r2_bucket.shadow_extraction.name },
      { name = "DESTINATION_BROWSER", type = "browser" },
      { name = "D1_TRAFFIC_CONTROLLER", type = "durable_object_namespace", class_name = "D1TrafficController" },
      { name = "VERSION_METADATA", type = "version_metadata" },
    ],
    [for queue in local.asynchronous_queues : { name = "${upper(replace(queue, "-", "_"))}_QUEUE", type = "queue", queue_name = cloudflare_queue.work[queue].queue_name }],
    [for queue in local.asynchronous_queues : { name = "${upper(replace(queue, "-", "_"))}_DLQ", type = "queue", queue_name = cloudflare_queue.dead_letter[queue].queue_name }],
    local.ingestion_plain_bindings,
  )

  migrations = {
    old_tag            = ""
    new_tag            = "v1-d1-traffic-controller"
    new_sqlite_classes = ["D1TrafficController"]
  }

  limits = { cpu_ms = 120000, subrequests = 50000 }
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs               = { enabled = true, invocation_logs = true, head_sampling_rate = 1, persist = true }
    traces             = { enabled = false, head_sampling_rate = 1, persist = true }
  }
}

resource "cloudflare_workers_script_subdomain" "ingestion" {
  account_id       = var.cloudflare_account_id
  script_name      = cloudflare_workers_script.ingestion.script_name
  enabled          = false
  previews_enabled = false
}

resource "cloudflare_workers_script" "application" {
  account_id          = var.cloudflare_account_id
  script_name         = var.worker_name
  main_module         = "api-worker.js"
  content_file        = local.api_worker_bundle
  content_sha256      = filesha256(local.api_worker_bundle)
  compatibility_date  = "2026-09-08"
  compatibility_flags = ["nodejs_compat"]
  keep_bindings       = ["secret_text"]

  bindings = concat(
    [
      { name = "DB", type = "d1", id = cloudflare_d1_database.application.id },
      { name = "DOCUMENTS", type = "r2_bucket", bucket_name = cloudflare_r2_bucket.documents.name },
      { name = "AI", type = "ai" },
      { name = "RESUME_EMBEDDINGS", type = "vectorize", index_name = var.resume_embedding_index_name },
      { name = "RESUME_PDF_COMPILER", type = "durable_object_namespace", class_name = "ResumePdfCompilerV2" },
      { name = "GMAIL_QUEUE", type = "queue", queue_name = cloudflare_queue.work["gmail"].queue_name },
      { name = "RESUME_JOB_IMPORT_QUEUE", type = "queue", queue_name = cloudflare_queue.work["resume-job-import"].queue_name },
      { name = "INGESTION", type = "service", service = cloudflare_workers_script.ingestion.script_name },
      { name = "VERSION_METADATA", type = "version_metadata" },
    ],
    local.api_plain_bindings,
  )

  migrations = {
    old_tag            = ""
    new_tag            = "v4-resume-pdf-compiler-v2"
    new_sqlite_classes = ["ResumePdfCompilerV2"]
  }

  limits = { cpu_ms = 30000, subrequests = 10000 }
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs               = { enabled = true, invocation_logs = true, head_sampling_rate = 1, persist = true }
    traces             = { enabled = false, head_sampling_rate = 1, persist = true }
  }
}

resource "cloudflare_workers_script_subdomain" "application" {
  account_id       = var.cloudflare_account_id
  script_name      = cloudflare_workers_script.application.script_name
  enabled          = true
  previews_enabled = true
}

resource "cloudflare_queue_consumer" "ingestion" {
  for_each          = cloudflare_queue.work
  account_id        = var.cloudflare_account_id
  queue_id          = each.value.queue_id
  type              = "worker"
  script_name       = cloudflare_workers_script.ingestion.script_name
  dead_letter_queue = cloudflare_queue.dead_letter[each.key].queue_name
  settings = {
    batch_size       = each.key == "destination-verification" ? 5 : 1
    max_concurrency  = lookup(local.consumer_max_concurrency, each.key, 1)
    max_retries      = each.key == "gmail" ? 5 : 2
    max_wait_time_ms = contains(["destination-verification", "shadow-extraction"], each.key) ? 60000 : 5000
    retry_delay      = each.key == "shadow-extraction" ? 300 : null
  }
}

resource "cloudflare_workers_cron_trigger" "ingestion" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.ingestion.script_name
  schedules = [
    { cron = "*/5 * * * *" }, { cron = "7-57/10 * * * *" }, { cron = "9-59/10 * * * *" },
    { cron = "12,42 * * * *" }, { cron = "22,52 * * * *" }, { cron = "2,32 * * * *" },
    { cron = "0 * * * *" }, { cron = "42 8 * * *" }, { cron = "17 9 * * *" },
  ]
}

resource "cloudflare_workers_custom_domain" "api" {
  count      = var.api_hostname == null ? 0 : 1
  account_id = var.cloudflare_account_id
  service    = cloudflare_workers_script.application.script_name
  hostname   = var.api_hostname
  zone_id    = var.zone_id
  lifecycle {
    precondition {
      condition     = var.zone_id != null
      error_message = "zone_id is required when api_hostname is set."
    }
  }
}

# Preserve the existing resource instances while transferring their Worker
# ownership. Without these moves, OpenTofu treats the address changes as
# unrelated destroy/create operations before it evaluates the script change.
moved {
  from = cloudflare_queue_consumer.application
  to   = cloudflare_queue_consumer.ingestion
}

moved {
  from = cloudflare_workers_cron_trigger.application
  to   = cloudflare_workers_cron_trigger.ingestion
}
