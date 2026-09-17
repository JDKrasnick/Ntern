import type { D1FailureClass } from './d1-errors.js';

export type PipelinePriority = 'P0' | 'P1' | 'P2';
export type ControllerMode = 'observation' | 'healthy' | 'guarded' | 'open' | 'recovering';
export type ControllerOutcome = 'success' | 'failure' | 'cancelled';
export interface PermitRequest { workload: string; priority: PipelinePriority; messageId: string; runId?: string; }
export interface Permit { permitId: string; expiresAt: string; fenced: true; }
export interface ControllerStatus { mode: ControllerMode; permitsInUse: Record<PipelinePriority, number>; budgets: Record<PipelinePriority, number>; recentPressure: number; }
interface StoredPermit extends PermitRequest, Permit { priority: PipelinePriority; }
interface ControllerState extends ControllerStatus { permits: Record<string, StoredPermit>; failures: number[]; protectedSuccesses: number; }
interface DurableObjectStorage { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void>; }
interface DurableObjectState { storage: DurableObjectStorage; }
const DEFAULT_BUDGETS: Record<PipelinePriority, number> = { P0: 4, P1: 2, P2: 2 };
const LEASE_MS = 30_000;
// A later owner-reviewed rollout may add an explicit, default-off enforcement gate.
const ENFORCEMENT_ENABLED = false;
function initialState(): ControllerState { return { mode: 'observation', permitsInUse: { P0: 0, P1: 0, P2: 0 }, budgets: { ...DEFAULT_BUDGETS }, recentPressure: 0, permits: {}, failures: [], protectedSuccesses: 0 }; }
function retryDelay(mode: ControllerMode, priority: PipelinePriority): number { return priority === 'P0' ? mode === 'open' ? 30 : 10 : mode === 'open' ? 300 : 60; }

/** Coordinates D1 permits only. Observation mode records pressure but grants every request. */
export class D1TrafficController {
  constructor(private readonly state: DurableObjectState) {}
  private async load(now = Date.now()): Promise<ControllerState> {
    const value = await this.state.storage.get<ControllerState>('state') ?? initialState();
    let changed = false;
    for (const [id, permit] of Object.entries(value.permits)) {
      if (Date.parse(permit.expiresAt) <= now) { delete value.permits[id]; changed = true; }
    }
    const permitsInUse: Record<PipelinePriority, number> = { P0: 0, P1: 0, P2: 0 };
    for (const permit of Object.values(value.permits)) permitsInUse[permit.priority] += 1;
    if (JSON.stringify(value.permitsInUse) !== JSON.stringify(permitsInUse)) changed = true;
    value.permitsInUse = permitsInUse;
    const failures = value.failures.filter((at) => at >= now - 5 * 60_000);
    if (failures.length !== value.failures.length || value.recentPressure !== failures.length) changed = true;
    value.failures = failures; value.recentPressure = failures.length;
    if (changed) await this.save(value);
    return value;
  }
  private async save(value: ControllerState): Promise<void> { await this.state.storage.put('state', value); }
  async acquire(request: PermitRequest): Promise<{ permit?: Permit; retryAfterSeconds?: number; status: ControllerStatus }> {
    const state = await this.load(); const waitingP0 = request.priority !== 'P0' && state.permitsInUse.P0 >= state.budgets.P0;
    const blocked = ENFORCEMENT_ENABLED && state.mode !== 'observation' && (waitingP0 || state.permitsInUse[request.priority] >= state.budgets[request.priority] || (state.mode === 'open' && request.priority !== 'P0'));
    if (blocked) return { retryAfterSeconds: retryDelay(state.mode, request.priority), status: publicStatus(state) };
    const permit: Permit = { permitId: crypto.randomUUID(), expiresAt: new Date(Date.now() + LEASE_MS).toISOString(), fenced: true };
    state.permits[permit.permitId] = { ...request, ...permit }; state.permitsInUse[request.priority] += 1; await this.save(state);
    return { permit, status: publicStatus(state) };
  }
  async complete(input: { permitId: string; outcome: ControllerOutcome; latencyMs: number; d1FailureClass?: D1FailureClass }): Promise<ControllerStatus> {
    const state = await this.load(); const permit = state.permits[input.permitId]; if (!permit) return publicStatus(state);
    delete state.permits[input.permitId]; state.permitsInUse[permit.priority] -= 1;
    const pressure = input.d1FailureClass === 'overloaded' || input.d1FailureClass === 'internal' || input.d1FailureClass === 'stalled';
    if (pressure) { state.failures.push(Date.now()); state.protectedSuccesses = 0; const minute = state.failures.filter((at) => at >= Date.now() - 60_000).length; state.mode = state.failures.length >= 10 ? 'open' : minute >= 3 ? 'guarded' : state.mode; }
    else if (input.outcome === 'success' && permit.priority === 'P0') { state.protectedSuccesses += 1; if ((state.mode === 'open' || state.mode === 'guarded') && state.protectedSuccesses >= 5) state.mode = 'recovering'; if (state.mode === 'recovering' && state.protectedSuccesses >= 10) state.mode = 'healthy'; }
    state.recentPressure = state.failures.length; await this.save(state); return publicStatus(state);
  }
  async status(): Promise<ControllerStatus> { return publicStatus(await this.load()); }
  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.slice(1);
    if (request.method === 'GET' && action === 'status') return Response.json(await this.status());
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });
    const input = await request.json() as Record<string, unknown>;
    if (action === 'acquire' && typeof input.workload === 'string' && typeof input.messageId === 'string' && ['P0', 'P1', 'P2'].includes(String(input.priority))) {
      return Response.json(await this.acquire({ workload: input.workload, messageId: input.messageId, priority: input.priority as PipelinePriority, runId: typeof input.runId === 'string' ? input.runId : undefined }));
    }
    if (action === 'complete' && typeof input.permitId === 'string' && ['success', 'failure', 'cancelled'].includes(String(input.outcome))) {
      return Response.json(await this.complete({ permitId: input.permitId, outcome: input.outcome as ControllerOutcome, latencyMs: Number(input.latencyMs) || 0, d1FailureClass: input.d1FailureClass as D1FailureClass | undefined }));
    }
    return new Response('Bad request', { status: 400 });
  }
}
function publicStatus(state: ControllerState): ControllerStatus { const budgets = state.mode === 'guarded' ? { P0: 2, P1: 1, P2: 0 } : state.mode === 'open' ? { P0: 1, P1: 0, P2: 0 } : state.budgets; return { mode: state.mode, permitsInUse: state.permitsInUse, budgets, recentPressure: state.recentPressure }; }
