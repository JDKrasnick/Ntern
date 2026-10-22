import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applicationDatabases, pauseCloudflareApplication, withBillingDeployment,
  type ApplicationEnvironment, type CloudflareManagementApi } from '../src/cloudflare-budget.js';
import { deployCloudflareDev } from '../scripts/deploy-cloudflare-dev.js';

function account() {
  const stopped = new Set<string>();
  const schedules = new Map([['intern-notifs-ingestion', ['* * * * *']], ['intern-notifs-dev-ingestion', ['* * * * *']]]);
  const consumers = new Map([['prod', [{ consumer_id: 'prod-c', script: 'intern-notifs-ingestion' }]],
    ['dev', [{ consumer_id: 'dev-c', script: 'intern-notifs-dev-ingestion' }]]]);
  let unavailable = false;
  let failedDelete = false;
  const api: CloudflareManagementApi = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    let result: unknown;
    if (path.startsWith('/d1/')) {
      const sql = JSON.parse(String(init.body)).sql as string;
      if (sql.startsWith('INSERT')) stopped.add(path);
      else if (unavailable) throw new Error('D1 unavailable');
      result = [{ results: stopped.has(path) ? [{ value: 'stopped' }] : [] }];
    } else if (path === '/workers/scripts') result = [...schedules.keys()].map(id => ({ id }));
    else if (path.endsWith('/schedules')) {
      const name = path.split('/')[3]!;
      if (init.method === 'PUT') schedules.set(name, []);
      result = { schedules: schedules.get(name) };
    } else if (path.startsWith('/queues?')) result = [
      { queue_id: 'prod', queue_name: 'intern-notifs-admission-v2' },
      { queue_id: 'dev', queue_name: 'intern-notifs-dev-admission-v2' },
    ];
    else if (path.startsWith('/queues/')) {
      const id = path.split('/')[2]!;
      if (init.method === 'DELETE') {
        if (failedDelete) throw new Error('Delete denied');
        consumers.set(id, []);
      }
      result = consumers.get(id);
    } else throw new Error(`Unexpected API path: ${path}`);
    return result as T;
  };
  const restore = (environment: ApplicationEnvironment) => {
    const name = environment === 'dev' ? 'intern-notifs-dev-ingestion' : 'intern-notifs-ingestion';
    schedules.set(name, ['* * * * *']);
    consumers.set(environment === 'dev' ? 'dev' : 'prod', [{ consumer_id: 'restored', script: name }]);
  };
  return { api, stopped, schedules, consumers, restore,
    loseTelemetry() { unavailable = true; }, denyDeletion() { failedDelete = true; } };
}

describe('deployment versus billing shutdown final state', () => {
  it('cancels a real command process group before reconciling restored resources', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'billing-cancel-'));
    const stateFile = join(directory, 'state.json');
    const lateWrite = join(directory, 'late-write');
    try {
      writeFileSync(stateFile, JSON.stringify({ stopped: false, schedules: [], consumers: [] }));
      const stub = join(directory, 'fetch.mjs');
      writeFileSync(stub, `import {readFileSync,writeFileSync} from 'node:fs';
        globalThis.fetch=async(url,init={})=>{
          const path=String(url), state=JSON.parse(readFileSync(process.env.BILLING_CANCEL_STATE,'utf8'));
          let result;
          if(path.includes('/d1/')) {
            if(JSON.parse(init.body).sql.startsWith('INSERT')) state.stopped=true;
            result=[{results:state.stopped?[{value:'stopped'}]:[]}];
          } else if(path.endsWith('/workers/scripts')) result=[{id:'intern-notifs-dev-ingestion'}];
          else if(path.endsWith('/schedules')) {
            if(init.method==='PUT') state.schedules=[];
            result={schedules:state.schedules};
          } else if(path.includes('/queues?')) result=[{queue_id:'dev',queue_name:'intern-notifs-dev-admission-v2'}];
          else if(path.includes('/consumers')) {
            if(init.method==='DELETE') state.consumers=[];
            result=state.consumers;
          } else throw new Error('Unexpected request '+path);
          writeFileSync(process.env.BILLING_CANCEL_STATE,JSON.stringify(state));
          return Response.json({success:true,result});
        };`);
      const child = join(directory, 'child.mjs');
      writeFileSync(child, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
        const grandchild=spawn(process.execPath,['-e',
          "process.send('ready');setTimeout(()=>require('node:fs').writeFileSync(process.env.BILLING_CANCEL_LATE,'restored'),600)"],
          {stdio:['ignore','ignore','ignore','ipc']});
        grandchild.on('message',()=>{
          writeFileSync(process.env.BILLING_CANCEL_STATE,JSON.stringify({stopped:true,schedules:['* * * * *'],
            consumers:[{consumer_id:'dev-c',script:'intern-notifs-dev-ingestion'}]}));
          process.kill(process.ppid,'SIGTERM');
        });setInterval(()=>{},1000);`);
      const result = spawnSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), '--import', stub,
        resolve('scripts/cloudflare-deploy-guard.ts'), 'dev', '--', process.execPath, child], {
        cwd: directory, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, BILLING_CANCEL_STATE: stateFile, BILLING_CANCEL_LATE: lateWrite,
          CLOUDFLARE_ACCOUNT_ID: '4d67a0f1b73641df84af0a283dd5b3d8', CLOUDFLARE_API_TOKEN: 'test-token' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('billing shutdown preserved');
      expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ stopped: true, schedules: [], consumers: [] });
      await new Promise(resolve => setTimeout(resolve, 900));
      expect(existsSync(lateWrite)).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('guards every production mutation phase and reconciles cancelled workflows', () => {
    const workflow = readFileSync('.github/workflows/deploy-cloudflare.yml', 'utf8');
    for (const name of ['Ensure the resume embedding index exists', 'Apply production D1 migrations',
      'Apply exact saved plan', 'Publish and roll out the resume PDF compiler container',
      'Restore operations binding if its deployment check rejects the key']) {
      const step = workflow.split(`      - name: ${name}\n`)[1]!.split('\n      - ')[0]!;
      expect(step).toContain('shell: node --import tsx scripts/cloudflare-deploy-guard.ts production -- bash');
    }
    expect(workflow).toContain("if: always() && steps.billing_preflight.outcome == 'success'");
    expect(workflow).toContain('run: node --import tsx scripts/cloudflare-deploy-guard.ts production --reconcile');
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
    expect(scripts['deploy:cloudflare']).toContain('cloudflare-deploy-guard.ts production -- tsx scripts/deploy-cloudflare.ts');
    expect(scripts['cloudflare:dev:deploy']).toBe('tsx scripts/deploy-cloudflare-dev.ts');
  });

  it.each(['production', 'dev'] as const)('a stop during successful or failed %s deployment wins after restoration', async environment => {
    for (const fail of [false, true]) {
      const s = account();
      await expect(withBillingDeployment(s.api, environment, async () => {
        await pauseCloudflareApplication(s.api, environment);
        s.restore(environment); // An already-running apply/Wrangler request finishes after shutdown.
        if (fail) throw new Error('deployment failed');
      })).rejects.toThrow('billing shutdown preserved');
      const id = environment === 'dev' ? 'dev' : 'prod';
      const other = environment === 'dev' ? 'prod' : 'dev';
      expect(s.consumers.get(id)).toEqual([]);
      expect(s.consumers.get(other)).toHaveLength(1);
      expect(s.stopped).toEqual(new Set([`/d1/database/${applicationDatabases[environment]}/query`]));
      expect(s.schedules.get(environment === 'dev' ? 'intern-notifs-dev-ingestion' : 'intern-notifs-ingestion')).toEqual([]);
    }
  });

  it('stops the real dev sequence after a shutdown racing its ingestion deploy', async () => {
    const s = account();
    const commands: string[] = [];
    await expect(deployCloudflareDev(s.api, async (command, args) => {
      commands.push([command, ...args].join(' '));
      if (args.includes('wrangler.dev.ingestion.jsonc')) {
        await pauseCloudflareApplication(s.api); // The independent account guard races dev.
        s.restore('dev');
      }
    })).rejects.toThrow('billing shutdown preserved');
    expect(commands).toHaveLength(3);
    expect(commands.some(command => command.includes('--release-legacy-consumer'))).toBe(false);
    expect([...s.consumers.values()]).toEqual([[], []]);
    expect([...s.schedules.values()]).toEqual([[], []]);
    expect(s.stopped.size).toBe(2);
  });

  it('fails closed and removes restored resources when the final latch read fails', async () => {
    const s = account();
    await expect(withBillingDeployment(s.api, 'dev', async () => { s.loseTelemetry(); }))
      .rejects.toThrow('incomplete cleanup');
    expect(s.consumers.get('dev')).toEqual([]);
    expect(s.schedules.get('intern-notifs-dev-ingestion')).toEqual([]);
    expect(s.stopped.has(`/d1/database/${applicationDatabases.dev}/query`)).toBe(true);
  });

  it('reports incomplete resource shutdown and never reports deployment success', async () => {
    const s = account();
    await expect(withBillingDeployment(s.api, 'dev', async () => {
      await pauseCloudflareApplication(s.api, 'dev');
      s.restore('dev'); s.denyDeletion();
    })).rejects.toThrow('incomplete cleanup');
    expect(s.stopped.size).toBe(1);
    expect(s.schedules.get('intern-notifs-dev-ingestion')).toEqual([]);
  });
});
