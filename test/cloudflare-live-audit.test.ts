import { describe, expect, it } from 'vitest';
import {
  activeVersionId,
  auditLiveVersions,
  auditSummaryLines,
  plannedWorkerValues,
  type LiveDeployment,
  type LiveVersion,
  type Plan,
} from '../scripts/cloudflare-live-audit.js';

const apiBindings = [
  { name: 'DB', type: 'd1', id: 'database-uuid' },
  { name: 'DOCUMENTS', type: 'r2_bucket', bucket_name: 'intern-notifs-documents' },
  { name: 'AI', type: 'ai' },
  { name: 'RESUME_EMBEDDINGS', type: 'vectorize', index_name: 'intern-notifs-resume-bank-v1' },
  { name: 'RESUME_PDF_COMPILER', type: 'durable_object_namespace', class_name: 'ResumePdfCompilerV2' },
  { name: 'D1_TRAFFIC_CONTROLLER', type: 'durable_object_namespace', class_name: 'D1TrafficController', script_name: 'intern-notifs-ingestion' },
  { name: 'GMAIL_QUEUE', type: 'queue', queue_name: 'intern-notifs-gmail' },
  { name: 'INGESTION', type: 'service', service: 'intern-notifs-ingestion' },
  { name: 'VERSION_METADATA', type: 'version_metadata' },
  { name: 'PUBLIC_API_URL', type: 'plain_text', text: 'https://intern-notifs.jdkrasnick.workers.dev' },
];

const ingestionBindings = [
  { name: 'DB', type: 'd1', id: 'database-uuid' },
  { name: 'DESTINATION_BROWSER', type: 'browser' },
  { name: 'GREENHOUSE_QUEUE', type: 'queue', queue_name: 'intern-notifs-greenhouse' },
  { name: 'DEPLOYMENT_ROLE', type: 'plain_text', text: 'ingestion' },
];

const plan: Plan = {
  planned_values: {
    root_module: {
      resources: [
        {
          address: 'cloudflare_workers_script.application',
          values: {
            bindings: apiBindings,
            compatibility_date: '2026-09-08',
            compatibility_flags: ['nodejs_compat'],
            handlers: ['fetch'],
            limits: { cpu_ms: 30_000, subrequests: 10_000 },
          },
        },
        {
          address: 'cloudflare_workers_script.ingestion',
          values: {
            bindings: ingestionBindings,
            compatibility_date: '2026-09-08',
            compatibility_flags: ['nodejs_compat'],
            handlers: ['scheduled', 'queue', 'fetch'],
            limits: { cpu_ms: 120_000, subrequests: 50_000 },
          },
        },
      ],
    },
  },
};

const deployment = (versionId: string, percentage = 100): LiveDeployment => ({
  versions: [{ version_id: versionId, percentage }],
});

const liveBindings = (planned: Array<Record<string, unknown>>) => planned.map((binding) => (
  binding.type === 'd1' ? { name: binding.name, type: 'd1', database_id: binding.id } : binding
));

const apiVersion: LiveVersion = {
  id: 'api-version-1',
  resources: {
    bindings: [
      ...liveBindings(apiBindings),
      { name: 'OPERATIONS_SHARED_SECRET', type: 'secret_text', text: 'secret-value' },
    ],
    script: { handlers: ['fetch'] },
    script_runtime: {
      compatibility_date: '2026-09-08',
      compatibility_flags: ['nodejs_compat'],
      limits: { cpu_ms: 30_000 },
    },
  },
};

const ingestionVersion: LiveVersion = {
  id: 'ingestion-version-1',
  resources: {
    bindings: liveBindings(ingestionBindings),
    script: { handlers: ['queue', 'scheduled', 'fetch'] },
    script_runtime: {
      compatibility_date: '2026-09-08',
      compatibility_flags: ['nodejs_compat'],
      limits: { cpu_ms: 120_000 },
    },
  },
};

function audit(overrides: { apiVersion?: LiveVersion; apiDeployment?: LiveDeployment; plan?: Plan } = {}) {
  return auditLiveVersions(overrides.plan ?? plan, {
    api: {
      scriptName: 'intern-notifs',
      address: 'cloudflare_workers_script.application',
      deployment: overrides.apiDeployment ?? deployment('api-version-1'),
      version: overrides.apiVersion ?? apiVersion,
    },
    ingestion: {
      scriptName: 'intern-notifs-ingestion',
      address: 'cloudflare_workers_script.ingestion',
      deployment: deployment('ingestion-version-1'),
      version: ingestionVersion,
    },
  });
}

describe('Cloudflare live version audit', () => {
  it('accepts live versions that match the post-apply plan, ignoring extra secrets', () => {
    const result = audit();
    expect(result.workers).toEqual([
      { scriptName: 'intern-notifs', versionId: 'api-version-1', bindingCount: apiBindings.length },
      { scriptName: 'intern-notifs-ingestion', versionId: 'ingestion-version-1', bindingCount: ingestionBindings.length },
    ]);
    expect(auditSummaryLines(result, 0).join('\n')).toContain('Final OpenTofu plan: no drift');
  });

  it('requires exactly one active version at 100% for each Worker', () => {
    expect(() => audit({ apiDeployment: deployment('api-version-1', 50) })).toThrow('at 100%');
    expect(() => audit({
      apiDeployment: {
        versions: [
          { version_id: 'api-version-1', percentage: 50 },
          { version_id: 'api-version-2', percentage: 50 },
        ],
      },
    })).toThrow('exactly one active version');
    expect(activeVersionId('intern-notifs', deployment('api-version-9'))).toBe('api-version-9');
    expect(() => activeVersionId('intern-notifs', { versions: [] })).toThrow('exactly one active version');
  });

  it('rejects binding drift between the plan and the live version', () => {
    const withoutQueue = {
      ...apiVersion,
      resources: {
        ...(apiVersion.resources as Record<string, unknown>),
        bindings: liveBindings(apiBindings).filter((binding) => binding.name !== 'GMAIL_QUEUE'),
      },
    };
    expect(() => audit({ apiVersion: withoutQueue })).toThrow('missing the non-secret binding GMAIL_QUEUE');

    const extraBinding = {
      ...apiVersion,
      resources: {
        ...(apiVersion.resources as Record<string, unknown>),
        bindings: [...liveBindings(apiBindings), { name: 'SURPRISE', type: 'plain_text', text: 'unexpected' }],
      },
    };
    expect(() => audit({ apiVersion: extraBinding })).toThrow('unreviewed non-secret binding SURPRISE');

    const wrongTarget = {
      ...apiVersion,
      resources: {
        ...(apiVersion.resources as Record<string, unknown>),
        bindings: liveBindings(apiBindings).map((binding) => (
          binding.name === 'GMAIL_QUEUE' ? { ...binding, queue_name: 'intern-notifs-other' } : binding
        )),
      },
    };
    expect(() => audit({ apiVersion: wrongTarget })).toThrow('GMAIL_QUEUE target drifted');

    const wrongType = {
      ...apiVersion,
      resources: {
        ...(apiVersion.resources as Record<string, unknown>),
        bindings: liveBindings(apiBindings).map((binding) => (
          binding.name === 'INGESTION' ? { name: 'INGESTION', type: 'service', service: 'other-worker' } : binding
        )),
      },
    };
    expect(() => audit({ apiVersion: wrongType })).toThrow('INGESTION target drifted');
  });

  it('rejects compatibility, handler, and limit drift', () => {
    const runtime = (apiVersion.resources as { script_runtime: Record<string, unknown> }).script_runtime;
    const script = (apiVersion.resources as { script: Record<string, unknown> }).script;
    const withRuntime = (patch: Record<string, unknown>) => ({
      ...apiVersion,
      resources: { ...(apiVersion.resources as Record<string, unknown>), script_runtime: { ...runtime, ...patch } },
    });
    expect(() => audit({ apiVersion: withRuntime({ compatibility_date: '2026-08-01' }) })).toThrow('compatibility date drifted');
    expect(() => audit({ apiVersion: withRuntime({ compatibility_flags: [] }) })).toThrow('compatibility flags drifted');
    expect(() => audit({ apiVersion: withRuntime({ limits: { cpu_ms: 60_000 } }) })).toThrow('limit cpu_ms drifted');
    expect(() => audit({
      apiVersion: {
        ...apiVersion,
        resources: { ...(apiVersion.resources as Record<string, unknown>), script: { ...script, handlers: ['scheduled'] } },
      },
    })).toThrow('handlers drifted');
  });

  it('fails when the post-apply plan is missing a Worker', () => {
    expect(() => plannedWorkerValues(plan, 'cloudflare_workers_script.missing')).toThrow('missing cloudflare_workers_script.missing');
    const partial: Plan = { planned_values: { root_module: { resources: [] } } };
    expect(() => audit({ plan: partial })).toThrow('Final OpenTofu plan is missing cloudflare_workers_script.application');
  });

  it('records drift in the job summary', () => {
    expect(auditSummaryLines(audit(), 2).join('\n')).toContain('drift detected (exit code 2)');
  });
});
