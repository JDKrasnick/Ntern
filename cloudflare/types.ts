export interface D1ResultMeta { changes: number; }
export interface D1RunResult { meta: D1ResultMeta; }
export interface D1AllResult<T> { results: T[]; }
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1AllResult<T>>;
  run(): Promise<D1RunResult>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1RunResult[]>;
}

export interface R2ObjectBody {
  body: ReadableStream;
  size?: number;
  httpMetadata?: { contentType?: string };
}
export interface R2Bucket {
  put(key: string, value: ReadableStream | ArrayBuffer | null, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<void>;
}

export interface Queue {
  send(message: unknown, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(messages: Array<{ body: unknown }>): Promise<void>;
  metrics?(): Promise<{ backlogCount: number; backlogBytes: number; oldestMessageTimestamp?: Date }>;
}
export interface QueueMessage<T> {
  id: string;
  body: T;
  attempts?: number;
  timestamp?: Date;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}
export interface MessageBatch<T> {
  queue: string;
  messages: QueueMessage<T>[];
}

export interface DurableObjectStub { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>; }
export interface DurableObjectNamespace { idFromName(name: string): unknown; get(id: unknown): DurableObjectStub; }
export interface ScheduledController {
  cron: string;
  scheduledTime: number;
}
