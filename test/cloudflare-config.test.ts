import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATALOG_DELIVERY_MAX_ATTEMPTS } from '../src/source-poll-cadence.js';
import { INGESTION_WORK_QUEUES } from '../cloudflare/ingestion-health-alert.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function quotedValuesBetween(source: string, start: string, end: string): string[] {
  const startAt = source.indexOf(start);
  if (startAt < 0) throw new Error(`Missing configuration marker: ${start}`);
  const valuesStart = startAt + start.length;
  const endAt = source.indexOf(end, valuesStart);
  if (endAt < 0) throw new Error(`Missing configuration marker: ${end}`);
  return [...source.slice(valuesStart, endAt).matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
}

type WorkerConfig = {
  ai?: { binding: string };
  browser?: { binding: string };
  containers?: Array<{ class_name: string; image: string; instance_type?: string; max_instances?: number }>;
  durable_objects?: { bindings: Array<{ name: string; class_name: string; script_name?: string }> };
  migrations?: Array<{ tag: string; new_sqlite_classes?: string[] }>;
  observability?: {
    enabled?: boolean;
    head_sampling_rate?: number;
    logs?: { enabled?: boolean; invocation_logs?: boolean; head_sampling_rate?: number; persist?: boolean };
  };
  queues?: {
    producers?: Array<{ binding: string; queue: string }>;
    consumers?: Array<{
      queue: string;
      max_batch_size: number;
      max_batch_timeout?: number;
      retry_delay?: number;
      max_retries: number;
      max_concurrency?: number;
      dead_letter_queue: string;
    }>;
  };
  services?: Array<{ binding: string; service: string }>;
  vectorize?: Array<{ binding: string; index_name: string }>;
  triggers?: { crons: string[] };
  vars: Record<string, string>;
  workers_dev?: boolean;
  preview_urls?: boolean;
};

describe('Cloudflare deployment configuration', () => {
  const api = JSON.parse(read('wrangler.api.jsonc')) as WorkerConfig;
  const ingestion = JSON.parse(read('wrangler.ingestion.jsonc')) as WorkerConfig;
  const devApi = JSON.parse(read('wrangler.dev.api.jsonc')) as WorkerConfig;
  const devIngestion = JSON.parse(read('wrangler.dev.ingestion.jsonc')) as WorkerConfig;

  it('keeps Wrangler and OpenTofu cron schedules synchronized', () => {
    const wranglerCrons = ingestion.triggers?.crons ?? [];
    const terraform = read('infra/cloudflare/main.tf');
    const cronResource = terraform.slice(terraform.indexOf('resource "cloudflare_workers_cron_trigger" "ingestion"'));
    const terraformCrons = quotedValuesBetween(cronResource, 'schedules = [', ']');

    expect(new Set(terraformCrons)).toEqual(new Set(wranglerCrons));
    expect(terraformCrons).toHaveLength(wranglerCrons.length);
  });

  it('assigns every cron and queue consumer to ingestion only', () => {
    expect(api.queues?.consumers ?? []).toEqual([]);
    expect(api.triggers).toBeUndefined();
    expect(api.queues?.producers?.map(({ binding }) => binding)).toEqual(['GMAIL_QUEUE', 'RESUME_JOB_IMPORT_QUEUE']);
    expect(ingestion.queues?.consumers?.map(({ queue }) => queue)).toEqual([
      'intern-notifs-greenhouse', 'intern-notifs-lever', 'intern-notifs-ashby', 'intern-notifs-github', 'intern-notifs-gmail', 'intern-notifs-destination-verification',
      'intern-notifs-shadow-extraction', 'intern-notifs-resume-job-import', 'intern-notifs-admission-v2',
    ]);
    expect(ingestion.triggers?.crons).toHaveLength(11);
    expect(ingestion.triggers?.crons).toContain('6-56/10 * * * *');
    expect(ingestion.triggers?.crons).toContain('1-51/10 * * * *');
    expect(ingestion.workers_dev).toBe(false);
    expect(ingestion.preview_urls).toBe(false);
  });

  it('disables API invocation logs while keeping structured logs and ingestion at full sampling', () => {
    const expectedObservability = (invocationLogs: boolean) => ({
      enabled: true,
      head_sampling_rate: 1,
      logs: { enabled: true, invocation_logs: invocationLogs, head_sampling_rate: 1, persist: true },
    });
    expect(api.observability).toEqual(expectedObservability(false));
    expect(devApi.observability).toEqual(expectedObservability(false));
    expect(ingestion.observability).toEqual(expectedObservability(true));
    expect(devIngestion.observability).toEqual(expectedObservability(true));
    // OpenTofu is the deployed authority; keep its observability blocks in step.
    const terraform = read('infra/cloudflare/main.tf');
    expect(terraform).toContain('logs               = { enabled = true, invocation_logs = false, head_sampling_rate = 1, persist = true }');
    expect(terraform).toContain('logs               = { enabled = true, invocation_logs = true, head_sampling_rate = 1, persist = true }');
  });

  it('disables API preview URLs in production and dev while keeping the public workers.dev endpoint', () => {
    expect(api.workers_dev).toBe(true);
    expect(api.preview_urls).toBe(false);
    expect(devApi.workers_dev).toBe(true);
    expect(devApi.preview_urls).toBe(false);
    const terraform = read('infra/cloudflare/main.tf');
    const block = terraform.slice(terraform.indexOf('resource "cloudflare_workers_script_subdomain" "application"'));
    const subdomain = block.slice(0, block.indexOf('}'));
    expect(subdomain).toContain('enabled          = true');
    expect(subdomain).toContain('previews_enabled = false');
  });

  it('alerts on every ingestion work queue the Worker consumes', () => {
    // The failure-ledger signal names its work queues explicitly. Destination
    // verification is excluded there because it already alerts through the DLQ
    // and admission-incident signals, so compare against every other consumer.
    const consumers = (ingestion.queues?.consumers ?? []).map(({ queue }) => queue)
      .filter((queue) => queue !== 'intern-notifs-destination-verification');
    expect([...INGESTION_WORK_QUEUES].sort()).toEqual([...consumers].sort());
  });

  it('keeps destination verification bindings and delivery settings synchronized', () => {
    const terraform = read('infra/cloudflare/main.tf');
    const producerBindings = new Map(ingestion.queues?.producers?.map((binding) => [binding.binding, binding.queue]));
    const consumer = ingestion.queues?.consumers?.find(({ queue }) => queue === 'intern-notifs-destination-verification');

    expect(producerBindings.get('DESTINATION_VERIFICATION_QUEUE')).toBe('intern-notifs-destination-verification');
    expect(producerBindings.get('DESTINATION_VERIFICATION_DLQ')).toBe('intern-notifs-destination-verification-dlq');
    expect(ingestion.browser?.binding).toBe('DESTINATION_BROWSER');
    expect(ingestion.vars.DESTINATION_VERIFICATION_QUEUE_ID).toBe('9b48a594d06a441e8b8ed45de0c430af');
    expect(consumer).toEqual({
      queue: 'intern-notifs-destination-verification',
      max_batch_size: 5,
      max_batch_timeout: 60,
      max_concurrency: 1,
      max_retries: 2,
      dead_letter_queue: 'intern-notifs-destination-verification-dlq',
    });

    expect(terraform).toContain('message_retention_period = each.key == "destination-verification" ? 604800 : 86400');
    expect(terraform).toContain('name = "${upper(replace(queue, "-", "_"))}_QUEUE"');
    expect(terraform).toContain('name = "${upper(replace(queue, "-", "_"))}_DLQ"');
    expect(terraform).toContain('{ name = "DESTINATION_BROWSER", type = "browser" }');
    expect(terraform).toContain('{ name = "DESTINATION_VERIFICATION_QUEUE_ID", type = "plain_text"');
    // `tofu fmt` owns the alignment of this block, so match the assignment, not
    // its padding.
    expect(terraform).toMatch(/batch_size\s+= each\.key == "destination-verification" \? 5 : 1/);
    expect(terraform).toContain('max_retries      = each.key == "gmail" ? 5 : 2');
    expect(terraform).toContain('max_wait_time_ms = contains(["destination-verification", "shadow-extraction"], each.key) ? 60000 : 5000');
  });

  it('keeps the admission queue-age alert threshold synchronized across Wrangler and OpenTofu', () => {
    const terraform = read('infra/cloudflare/main.tf');

    expect(ingestion.vars.ADMISSION_QUEUE_AGE_ALERT_HOURS).toBe('120');
    expect(terraform).toContain('{ name = "ADMISSION_QUEUE_AGE_ALERT_HOURS", type = "plain_text", text = tostring(var.admission_queue_age_alert_hours) }');
  });

  it('keeps every work-queue consumer concurrency synchronized in Wrangler and OpenTofu', () => {
    const terraform = read('infra/cloudflare/main.tf');
    const block = terraform.match(/consumer_max_concurrency = \{([^}]*)\}/s)?.[1] ?? '';
    const declared = Object.fromEntries([...block.matchAll(/([\w-]+)\s*=\s*(\d+)/g)]
      .map(([, provider, value]) => [provider, Number(value)]));

    expect(Object.keys(declared).sort()).toEqual([
      'admission-v2', 'ashby', 'destination-verification', 'github', 'gmail', 'greenhouse', 'lever', 'resume-job-import', 'shadow-extraction',
    ]);
    for (const consumer of ingestion.queues?.consumers ?? []) {
      expect(consumer.max_concurrency).toBe(declared[consumer.queue.replace('intern-notifs-', '')]);
    }
    expect(terraform).toContain('max_concurrency  = lookup(local.consumer_max_concurrency, each.key, 1)');
  });

  it('keeps the catalog deferral threshold synchronized with the queue retry budget', () => {
    // CATALOG_DELIVERY_MAX_ATTEMPTS acks a source-scoped failure on its final
    // delivery. If a catalog queue's max_retries changes without the constant,
    // the threshold either fires early or never fires and DLQ growth returns.
    // This suite reads Wrangler; OpenTofu is the deployed authority and its
    // catalog retry value is pinned by the max_retries assertion in the
    // destination-verification configuration test above.
    const catalogQueues = ['intern-notifs-greenhouse', 'intern-notifs-lever', 'intern-notifs-ashby', 'intern-notifs-github'];
    const matched = (ingestion.queues?.consumers ?? []).filter(({ queue }) => catalogQueues.includes(queue));
    // Assert the matched set first so a renamed or removed catalog consumer
    // fails loudly instead of letting the loop below pass vacuously.
    expect(matched.map(({ queue }) => queue).sort()).toEqual([...catalogQueues].sort());
    for (const consumer of matched) {
      expect(consumer.max_retries + 1).toBe(CATALOG_DELIVERY_MAX_ATTEMPTS);
    }
  });

  it('keeps behavior-critical API variables synchronized across Wrangler and OpenTofu', () => {
    const terraform = read('infra/cloudflare/main.tf');
    expect(api.vars.EMPLOYER_PORTAL_ENABLED).toBe('true');
    expect(terraform).toContain('{ name = "EMPLOYER_PORTAL_ENABLED", type = "plain_text", text = tostring(var.employer_portal_enabled) }');
    expect(read('infra/cloudflare/variables.tf')).toContain('variable "employer_portal_enabled"');
    expect(api.vars.IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED).toBe('true');
    expect(ingestion.vars.IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED).toBe('true');
    expect(api.vars.IDENTITY_INTEGRITY_ENFORCEMENT_ENABLED).toBe('false');
    expect(ingestion.vars.IDENTITY_INTEGRITY_ENFORCEMENT_ENABLED).toBe('false');
    expect(terraform).toContain('{ name = "IDENTITY_INTEGRITY_ENFORCEMENT_ENABLED", type = "plain_text", text = tostring(var.identity_integrity_enforcement_enabled) }');
    expect(api.vars.IDENTITY_CONFIRMED_COVERAGE_FLOOR).toBe('0');
    expect(ingestion.vars.IDENTITY_CONFIRMED_COVERAGE_FLOOR).toBe('0');
    expect(terraform).toContain('{ name = "IDENTITY_CONFIRMED_COVERAGE_FLOOR", type = "plain_text", text = tostring(var.identity_confirmed_coverage_floor) }');
    expect(read('infra/cloudflare/variables.tf')).toMatch(/variable "identity_confirmed_coverage_floor"[\s\S]*?default\s+= 0/);
    expect(terraform).toContain('name = "ADMISSION_SUPPORT_RECIPIENT", type = "plain_text", text = var.admission_support_recipient');
    expect(read('infra/cloudflare/variables.tf')).toContain('variable "admission_support_recipient"');
  });

  it('deploys the resume PDF compiler with matching runtime and OpenTofu ownership', () => {
    const terraform = read('infra/cloudflare/main.tf');
    const deployment = read('.github/workflows/deploy-cloudflare.yml');
    const compilerImage = read('cloudflare/resume-compiler/Dockerfile');
    expect(api.durable_objects?.bindings).toContainEqual({ name: 'RESUME_PDF_COMPILER', class_name: 'ResumePdfCompilerV2' });
    expect(api.durable_objects?.bindings).toContainEqual({ name: 'D1_TRAFFIC_CONTROLLER', class_name: 'D1TrafficController', script_name: 'intern-notifs-ingestion' });
    expect(api.migrations).toContainEqual({ tag: 'v4-resume-pdf-compiler-v2', new_sqlite_classes: ['ResumePdfCompilerV2'] });
    expect(api.containers).toContainEqual({ class_name: 'ResumePdfCompilerV2', image: './cloudflare/resume-compiler/Dockerfile', instance_type: 'basic', max_instances: 2 });
    expect(terraform).toContain('{ name = "RESUME_PDF_COMPILER", type = "durable_object_namespace", class_name = "ResumePdfCompilerV2" }');
    expect(terraform).toContain('{ name = "D1_TRAFFIC_CONTROLLER", type = "durable_object_namespace", class_name = "D1TrafficController", script_name = cloudflare_workers_script.ingestion.script_name }');
    expect(terraform.match(/workers_message = "Release \$\{var\.deploy_sha\}"/gu)).toHaveLength(2);
    expect(terraform.match(/workers_tag\s+= var\.deploy_sha/gu)).toHaveLength(2);
    expect(terraform).not.toMatch(/\bmigrations\s*=\s*\{/);
    expect(deployment).toContain('TF_VAR_deploy_sha: ${{ github.event_name == \'workflow_run\' && github.event.workflow_run.head_sha || inputs.sha }}');
    expect(deployment).toContain('TF_VAR_resume_tuner_enabled: "true"');
    expect(deployment).toContain('wrangler vectorize create "$TF_VAR_resume_embedding_index_name"');
    expect(deployment).toContain('.config.preset == "@cf/baai/bge-base-en-v1.5"');
    expect(deployment).toContain('reconcile_worker cloudflare_workers_script.ingestion intern-notifs-ingestion');
    expect(deployment).toContain('reconcile_worker cloudflare_workers_script.application intern-notifs');
    expect(deployment).not.toContain('Bootstrap Worker migrations with Wrangler');
    expect(deployment.indexOf('Back up pre-deploy state')).toBeLessThan(deployment.indexOf('Create and validate saved plan'));
    expect(deployment.indexOf('Ensure the resume embedding index exists')).toBeLessThan(deployment.indexOf('Create and validate saved plan'));
    expect(deployment).toContain('wrangler d1 migrations apply intern-notifs-db --remote --config wrangler.api.jsonc');
    expect(deployment.indexOf('Create and validate saved plan')).toBeLessThan(deployment.indexOf('Apply production D1 migrations'));
    expect(deployment.indexOf('Apply production D1 migrations')).toBeLessThan(deployment.indexOf('Apply exact saved plan'));
    expect(deployment).toContain("jq 'del(.vars)' wrangler.api.jsonc");
    expect(deployment).toContain('npx wrangler deploy --config "$config" --keep-vars');
    expect(deployment).toContain('--tag "$DEPLOY_SHA"');
    expect(deployment).toContain('--message "Container rollout for $DEPLOY_SHA"');
    expect(deployment).toContain('name: Capture expected Worker code identities');
    expect(deployment).toContain('.annotations["workers/tag"] == $sha\' "$RUNNER_TEMP/api-expected-version.json"');
    expect(deployment).toContain('.annotations["workers/tag"] == $sha\' "$RUNNER_TEMP/ingestion-expected-version.json"');
    expect(deployment).toContain('EXPECTED_API_ETAG=');
    expect(deployment).toContain('EXPECTED_INGESTION_ETAG=');
    expect(deployment).toContain('EXPECTED_API_VERSION=');
    expect(deployment).toContain('EXPECTED_INGESTION_VERSION=');
    expect(deployment).toContain('wrangler versions secret put OPERATIONS_SHARED_SECRET');
    expect(deployment).toContain('--tag "$DEPLOY_SHA" --message "Release $DEPLOY_SHA"');
    expect(deployment).toContain('wrangler versions deploy "${secret_version}@100%"');
    expect(deployment).not.toContain('wrangler secret put OPERATIONS_SHARED_SECRET');
    expect(deployment).not.toContain('name: Require converged state');
    // The convergence gate must run after every Worker mutation so the audit sees
    // the tagged container rollout and any restored secret, not an earlier state.
    expect(deployment.indexOf('Apply exact saved plan')).toBeLessThan(deployment.indexOf('Publish and roll out the resume PDF compiler container'));
    expect(deployment.indexOf('Publish and roll out the resume PDF compiler container')).toBeLessThan(deployment.indexOf('Capture expected Worker code identities'));
    expect(deployment.indexOf('Capture expected Worker code identities')).toBeLessThan(deployment.indexOf('Restore operations binding if its deployment check rejects the key'));
    expect(deployment.indexOf('Restore operations binding if its deployment check rejects the key')).toBeLessThan(deployment.indexOf('Final convergence gate'));
    expect(deployment.indexOf('Final convergence gate')).toBeLessThan(deployment.indexOf('Smoke-test and monitor production'));
    expect(deployment).toContain('scripts/cloudflare-live-audit.ts');
    expect(deployment).toContain('--api-expected-etag "$EXPECTED_API_ETAG"');
    expect(deployment).toContain('--ingestion-expected-etag "$EXPECTED_INGESTION_ETAG"');
    expect(deployment).toContain('test "$drift" = 0');
    const localDeploy = read('scripts/deploy-cloudflare.ts');
    expect(localDeploy).toContain('resolveDeploySha(git.stdout.trim(), process.env.DEPLOY_SHA, process.env.TF_VAR_deploy_sha)');
    expect(localDeploy).toContain('process.env.TF_VAR_deploy_sha = sha');
    expect(localDeploy).toContain('expectedDeploySha: deploySha');
    expect(localDeploy).toContain("annotations['workers/tag'] !== deploySha");
    expect(localDeploy).toContain('captureExpectedWorkerIdentity(workers.api, deploySha)');
    expect(localDeploy).toContain('captureExpectedWorkerIdentity(workers.ingestion, deploySha)');
    expect(localDeploy).toContain('auditLiveVersions(plan, {');
    expect(localDeploy).toContain('expectedEtag: expected.api.etag');
    expect(localDeploy).toContain('expectedEtag: expected.ingestion.etag');
    expect(localDeploy.indexOf('const deploySha = currentDeploySha()'))
      .toBeLessThan(localDeploy.indexOf("tofu(['init', '-reconfigure', '-input=false'])"));
    expect(localDeploy.indexOf('captureExpectedWorkerIdentity(workers.ingestion, deploySha)'))
      .toBeLessThan(localDeploy.indexOf('restoreOperationsSecrets(expected, deploySha)'));
    expect(localDeploy.indexOf('auditFinalState(finalPlan, expected, converged.status)'))
      .toBeLessThan(localDeploy.indexOf("console.log(changes.length ? 'Deployed and converged.'"));
    expect(compilerImage).toContain('apk add --no-cache poppler-utils python3 texlive texmf-dist-fontsrecommended');
    expect(compilerImage).not.toContain('texlive-full');
  });

  it('registers the ingestion traffic controller before the API binds to it', () => {
    const terraform = read('infra/cloudflare/main.tf');
    expect(ingestion.durable_objects?.bindings).toContainEqual({ name: 'D1_TRAFFIC_CONTROLLER', class_name: 'D1TrafficController' });
    expect(ingestion.migrations).toContainEqual({ tag: 'v1-d1-traffic-controller', new_sqlite_classes: ['D1TrafficController'] });
    expect(terraform).toContain('{ name = "D1_TRAFFIC_CONTROLLER", type = "durable_object_namespace", class_name = "D1TrafficController" }');
    // Wrangler keeps the bootstrap history; production OpenTofu updates existing
    // classes without replaying a migration tag on every script upload.
    expect(terraform).not.toMatch(/\bmigrations\s*=\s*\{/);
  });

  it('keeps the Cloudflare development resume stack isolated and complete', () => {
    const provision = read('scripts/provision-cloudflare-dev.sh');
    expect(devApi.ai).toEqual({ binding: 'AI' });
    expect(devApi.vectorize).toEqual([{ binding: 'RESUME_EMBEDDINGS', index_name: 'intern-notifs-dev-resume-bank-v1' }]);
    expect(devApi.durable_objects?.bindings).toContainEqual({ name: 'RESUME_PDF_COMPILER', class_name: 'ResumePdfCompilerV2' });
    // Dev never carried the retired ResumePdfCompiler class, so its first Durable
    // Object migration must create ResumePdfCompilerV2 directly; a deleted_classes
    // migration cannot be the first tag on a Worker with no DO history.
    expect(devApi.migrations).toEqual([{ tag: 'v4-resume-pdf-compiler-v2', new_sqlite_classes: ['ResumePdfCompilerV2'] }]);
    expect(devApi.containers).toEqual([{ class_name: 'ResumePdfCompilerV2', image: './cloudflare/resume-compiler/Dockerfile', instance_type: 'basic', max_instances: 2 }]);
    expect(devApi.queues?.producers).toContainEqual({ binding: 'RESUME_JOB_IMPORT_QUEUE', queue: 'intern-notifs-dev-resume-job-import' });
    expect(devApi.vars.RESUME_TUNER_ENABLED).toBe('true');
    expect(devIngestion.vars.RESUME_TUNER_ENABLED).toBe('true');
    expect(devIngestion.queues?.consumers).toContainEqual({
      queue: 'intern-notifs-dev-resume-job-import', max_batch_size: 1, max_concurrency: 1,
      max_retries: 2, dead_letter_queue: 'intern-notifs-dev-resume-job-import-dlq',
    });
    expect(provision).toContain("resume_index='intern-notifs-dev-resume-bank-v1'");
    expect(provision).not.toContain("resume_index='intern-notifs-resume-bank-v1'");
  });

  it('moves queue and cron state to ingestion ownership', () => {
    const terraform = read('infra/cloudflare/main.tf');
    expect(terraform).toContain('from = cloudflare_queue_consumer.application');
    expect(terraform).toContain('to   = cloudflare_queue_consumer.ingestion');
    expect(terraform).toContain('from = cloudflare_workers_cron_trigger.application');
    expect(terraform).toContain('to   = cloudflare_workers_cron_trigger.ingestion');
  });

  it('protects the production D1 database from replacement', () => {
    const terraform = read('infra/cloudflare/main.tf');
    expect(terraform).toContain('prevent_destroy = true');
    expect(terraform).toContain('ignore_changes  = [primary_location_hint]');
  });

  it('declares Cloudflare trace defaults to prevent perpetual Worker drift', () => {
    const terraform = read('infra/cloudflare/main.tf');
    expect(terraform.match(/traces\s+= \{ enabled = false, head_sampling_rate = 1, persist = true \}/gu)).toHaveLength(2);
  });

  it('restores billing-shutdown schedules only on ingestion', () => {
    const runbook = read('docs/cloudflare-migration.md');

    expect(runbook).toContain('wrangler triggers deploy --name intern-notifs-ingestion');
    expect(runbook).toContain('--config wrangler.ingestion.jsonc');
    expect(runbook).not.toContain('--config .context/wrangler.remote.json');
    expect(runbook).not.toContain('wrangler triggers deploy --name intern-notifs \\');
  });

  it('removes legacy consumers before deploying the handler-less API bundle', () => {
    const runbook = read('docs/api-ingestion-split.md');
    expect(runbook.indexOf('queues consumer remove intern-notifs-greenhouse')).toBeLessThan(
      runbook.indexOf('wrangler deploy --config .context/wrangler.api-cutover.jsonc'),
    );
  });

  it('requires explicit Worker configuration rather than retaining a shared default', () => {
    expect(existsSync(new URL('../wrangler.jsonc', import.meta.url))).toBe(false);
    expect(api.services).toEqual([{ binding: 'INGESTION', service: 'intern-notifs-ingestion' }]);
  });

  it('keeps shadow extraction private, bounded, and owned by ingestion', () => {
    const terraform = read('infra/cloudflare/main.tf');
    const worker = read('cloudflare/worker.ts');
    const producerBindings = new Map(ingestion.queues?.producers?.map((binding) => [binding.binding, binding.queue]));
    const consumer = ingestion.queues?.consumers?.find(({ queue }) => queue === 'intern-notifs-shadow-extraction');

    expect(producerBindings.get('SHADOW_EXTRACTION_QUEUE')).toBe('intern-notifs-shadow-extraction');
    expect(producerBindings.get('SHADOW_EXTRACTION_DLQ')).toBe('intern-notifs-shadow-extraction-dlq');
    expect(consumer).toEqual({
      queue: 'intern-notifs-shadow-extraction', max_batch_size: 1, max_concurrency: 1,
      max_batch_timeout: 60, max_retries: 2, retry_delay: 300, dead_letter_queue: 'intern-notifs-shadow-extraction-dlq',
    });
    expect(ingestion.vars.SHADOW_EXTRACTION_ENABLED).toBe('true');
    expect(ingestion.vars.RESUME_TUNER_ENABLED).toBe('false');
    expect(ingestion.vars.SHADOW_EXTRACTION_MONTHLY_FORECAST_CENTS).toBe('1500');
    expect(ingestion.vars.SHADOW_EXTRACTION_MONTHLY_HEADROOM_CENTS).toBe('2000');
    expect(ingestion.vars.SHADOW_EXTRACTION_QUEUE_NAME).toBe('intern-notifs-shadow-extraction');
    expect(terraform).toContain('cloudflare_r2_bucket" "shadow_extraction');
    expect(terraform).toContain('SHADOW_EXTRACTION_ARTIFACTS');
    expect(terraform).toContain('"shadow-extraction"');
    expect(terraform).toContain('{ name = "SHADOW_EXTRACTION_QUEUE_ID", type = "plain_text"');
    expect(terraform).toContain('{ name = "SHADOW_EXTRACTION_QUEUE_NAME", type = "plain_text"');
    expect(terraform).toContain('{ name = "RESUME_TUNER_ENABLED", type = "plain_text", text = tostring(var.resume_tuner_enabled) }');
    expect(terraform).toContain('contains(["destination-verification", "shadow-extraction"], each.key) ? 60000 : 5000');
    expect(terraform).toContain('retry_delay      = each.key == "shadow-extraction" ? 300 : null');
    expect(worker).toContain('env.SHADOW_EXTRACTION_QUEUE_ID');
  });

  it('keeps the V2 admission queue dedicated, bounded, and owned by ingestion', () => {
    const terraform = read('infra/cloudflare/main.tf');
    const worker = read('cloudflare/worker.ts');
    const producerBindings = new Map(ingestion.queues?.producers?.map((binding) => [binding.binding, binding.queue]));
    const consumer = ingestion.queues?.consumers?.find(({ queue }) => queue === 'intern-notifs-admission-v2');

    expect(producerBindings.get('ADMISSION_V2_QUEUE')).toBe('intern-notifs-admission-v2');
    expect(producerBindings.get('ADMISSION_V2_DLQ')).toBe('intern-notifs-admission-v2-dlq');
    expect(consumer).toEqual({
      queue: 'intern-notifs-admission-v2', max_batch_size: 1, max_concurrency: 1, max_retries: 2,
      dead_letter_queue: 'intern-notifs-admission-v2-dlq',
    });
    expect(ingestion.vars.INGESTION_V2_ADMISSION_ENABLED).toBe('false');
    expect(ingestion.vars.INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST).toBe('');
    expect(terraform).toContain('"admission-v2"');
    expect(terraform).toContain('{ name = "INGESTION_V2_ADMISSION_ENABLED", type = "plain_text", text = tostring(var.ingestion_v2_admission_enabled) }');
    expect(terraform).toContain('{ name = "INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST", type = "plain_text", text = var.ingestion_v2_admission_source_allowlist }');
    expect(worker).toContain('ADMISSION_V2_QUEUE');
  });
});
