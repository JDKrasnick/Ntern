import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
  browser?: { binding: string };
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
  triggers?: { crons: string[] };
  vars: Record<string, string>;
  workers_dev?: boolean;
  preview_urls?: boolean;
};

describe('Cloudflare deployment configuration', () => {
  const api = JSON.parse(read('wrangler.api.jsonc')) as WorkerConfig;
  const ingestion = JSON.parse(read('wrangler.ingestion.jsonc')) as WorkerConfig;

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
      'intern-notifs-shadow-extraction', 'intern-notifs-resume-job-import',
    ]);
    expect(ingestion.triggers?.crons).toHaveLength(9);
    expect(ingestion.workers_dev).toBe(false);
    expect(ingestion.preview_urls).toBe(false);
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

  it('keeps admission alert thresholds synchronized across Wrangler and OpenTofu', () => {
    const terraform = read('infra/cloudflare/main.tf');

    expect(ingestion.vars.ADMISSION_QUEUE_AGE_ALERT_HOURS).toBe('120');
    expect(ingestion.vars.ADMISSION_STALE_ALERT_THRESHOLD).toBe('1');
    expect(terraform).toContain('{ name = "ADMISSION_QUEUE_AGE_ALERT_HOURS", type = "plain_text", text = tostring(var.admission_queue_age_alert_hours) }');
    expect(terraform).toContain('{ name = "ADMISSION_STALE_ALERT_THRESHOLD", type = "plain_text", text = tostring(var.admission_stale_alert_threshold) }');
  });

  it('keeps every work-queue consumer concurrency synchronized in Wrangler and OpenTofu', () => {
    const terraform = read('infra/cloudflare/main.tf');
    const block = terraform.match(/consumer_max_concurrency = \{([^}]*)\}/s)?.[1] ?? '';
    const declared = Object.fromEntries([...block.matchAll(/([\w-]+)\s*=\s*(\d+)/g)]
      .map(([, provider, value]) => [provider, Number(value)]));

    expect(Object.keys(declared).sort()).toEqual([
      'ashby', 'destination-verification', 'github', 'gmail', 'greenhouse', 'lever', 'resume-job-import', 'shadow-extraction',
    ]);
    for (const consumer of ingestion.queues?.consumers ?? []) {
      expect(consumer.max_concurrency).toBe(declared[consumer.queue.replace('intern-notifs-', '')]);
    }
    expect(terraform).toContain('max_concurrency  = lookup(local.consumer_max_concurrency, each.key, 1)');
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
    expect(ingestion.vars.SHADOW_EXTRACTION_MONTHLY_HEADROOM_CENTS).toBe('500');
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
});
