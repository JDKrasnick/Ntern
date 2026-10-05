import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect } from 'vitest';
import { D1AdmissionProviderGovernor } from '../cloudflare/admission-v2-provider-governor.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
function d1(db: DatabaseSync): D1Database {
 const statement=(sql:string,values:unknown[]=[]):D1PreparedStatement=>({bind(...args){return statement(sql,args);},async first<T>(){return (db.prepare(sql).get(...values as string[]) as T)??null;},async all<T>(){return {results:db.prepare(sql).all(...values as string[]) as T[]};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...values as string[]).changes)}};}});
 return {prepare:sql=>statement(sql),async batch(statements){return Promise.all(statements.map(s=>s.run()));}};
}
describe('durable provider request governor',()=>{
 it('grants one atomic permit across deliveries and preserves the longest provider cooldown',async()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE system_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)');
  let now=Date.parse('2026-10-05T00:00:00Z');const first=new D1AdmissionProviderGovernor(d1(db),()=>new Date(now));const second=new D1AdmissionProviderGovernor(d1(db),()=>new Date(now));
  try{
   expect(await Promise.all([first.acquire('workable'),second.acquire('workable')])).toEqual([0,2000]);
   await first.defer('workable',7200000);await second.defer('workable',900000);
   expect(await second.acquire('workable')).toBe(7200000);
   now+=7200000;expect(await second.acquire('workable')).toBe(0);
  }finally{db.close();}
 });
 it('fails as infrastructure when durable state is corrupt instead of probing through the failure',async()=>{
  const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE system_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);INSERT INTO system_state VALUES ('ingestion-v2:provider-cooldown:workable','{}','2026-10-05T00:00:00Z')`);
  try{await expect(new D1AdmissionProviderGovernor(d1(db)).acquire('workable')).rejects.toMatchObject({classification:'d1-unavailable'});}finally{db.close();}
 });
});
