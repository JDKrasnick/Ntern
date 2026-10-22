import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {afterEach,describe,expect,it} from 'vitest';
import {previewEarlyCareerBackfill,applyEarlyCareerBackfill,type EarlyCareerProof} from '../cloudflare/early-career-backfill.js';
import type {D1Database,D1PreparedStatement} from '../cloudflare/types.js';
import type {Internship} from '../src/types.js';
const now='2026-10-21T23:00:00.000Z',url='https://jobs.ashbyhq.com/acme/12345678-abcd-1234-abcd-123456789012';
const api='https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true';
let database:DatabaseSync;afterEach(()=>database?.close());
function setup(){
  database=new DatabaseSync(':memory:');
  database.exec(readFileSync('cloudflare/migrations/0001_initial.sql','utf8'));
  database.exec(readFileSync('cloudflare/migrations/0015_role_metadata_enrichment.sql','utf8'));
  const prepared=(sql:string,values:SQLInputValue[]=[]):D1PreparedStatement=>({bind(...v:unknown[]){return prepared(sql,v as SQLInputValue[]);},
    async first<T>(){return database.prepare(sql).get(...values) as T??null;},async all<T>(){return {results:database.prepare(sql).all(...values) as T[]};},
    async run(){return {meta:{changes:Number(database.prepare(sql).run(...values).changes)}};}});
  const db:D1Database={prepare:sql=>prepared(sql),async batch(statements){database.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());database.exec('COMMIT');return results;}catch(e){database.exec('ROLLBACK');throw e;}}};
  const admission={employerResolution:'resolved' as const,postingAttribution:'attributed' as const,destination:{classification:'posting-detail' as const,candidateUrl:url,finalUrl:url,provider:'ashby' as const,tenant:'acme',expectedPostingId:'12345678-abcd-1234-abcd-123456789012',inspectedAt:now},metadata:{complete:true,title:'complete' as const,location:'complete' as const},catalogEligible:true,alertEligible:true,reasonCodes:[],evaluatedAt:now,evidenceObservedAt:now};
  const ref={sourceId:'ashby-acme',externalId:'id',document:'id',row:1,sourceUrl:api,title:'Software Engineer Intern',company:'Acme',location:'Remote',season:'summer-2027',applyUrl:url,state:'open' as const,technical:true,compensation:{raw:''},admission,provenance:'official-ats' as const};
  const job:Internship={jobId:'job',company:'Acme',title:'Software Engineer Intern',location:'Remote',season:'summer-2027',applyUrl:url,normalizedUrl:url,fingerprint:'fingerprint',compensation:{raw:''},technical:true,open:true,firstSeenAt:now,lastSeenAt:now,sourceReferences:[ref],admission,notification:{smsPending:true,digestPending:true,smsSentAt:now}};
  const insert=database.prepare('INSERT INTO catalog_items(pk,sk,kind,value,catalog_state) VALUES(?,?,?,?,?)');
  insert.run('JOB#job','META','internship',JSON.stringify(job),'OPEN');
  insert.run('SOURCE#ashby-acme','OCCURRENCE#id','source-occurrence',JSON.stringify({sourceId:ref.sourceId,externalId:'id',jobId:'job',occurrence:ref,present:true,consecutiveOmissions:0,changedSnapshotHash:'snapshot',changedAt:now}),null);
  const proof:EarlyCareerProof={sourceId:'ashby-acme',sourceUrl:api,observedAt:now,artifact:{title:'Software Engineer',text:'Build Python services.'}};
  const current=()=>JSON.parse((database.prepare("SELECT value FROM catalog_items WHERE pk='JOB#job' AND sk='META'").get() as {value:string}).value) as Internship;
  return {db,job,proof,current};
}
describe('reviewed early-career backfill',()=>{
  it('previews every prune without changing publication, then atomically updates canonical and occurrence state',async()=>{
    const {db,proof,current}=setup();const plan=await previewEarlyCareerBackfill(db,[{jobId:'job',proofs:[proof]}],now);
    expect(plan.reviews).toMatchObject([{jobId:'job',change:'pruned',reason:'no-explicit-programme'}]);expect(current().admission?.catalogEligible).toBe(true);
    const applied=await applyEarlyCareerBackfill(db,plan.repairToken,1,now);expect(applied.projectionRefreshRequired).toBe(true);
    expect(current()).toMatchObject({jobId:'job',open:true,admission:{catalogEligible:false},notification:{smsPending:false,digestPending:false,smsSentAt:now}});
    const occurrence=JSON.parse((database.prepare("SELECT value FROM catalog_items WHERE pk='SOURCE#ashby-acme'").get() as {value:string}).value);
    expect(occurrence.occurrence.admission.catalogEligible).toBe(false);expect(occurrence.present).toBe(true);
    expect(database.prepare("SELECT catalog_state,sms_pending FROM catalog_items WHERE pk='JOB#job'").get()).toMatchObject({catalog_state:null,sms_pending:0});
    expect(database.prepare('SELECT count(*) AS n FROM role_metadata_evidence WHERE is_current=1').get()).toMatchObject({n:1});
    expect(await applyEarlyCareerBackfill(db,plan.repairToken,1,now)).toMatchObject({alreadyApplied:true});
  });
  it.each(['job','occurrence'])('rolls back the whole batch if the %s changes after preview',async kind=>{
    const {db,proof,current}=setup();const plan=await previewEarlyCareerBackfill(db,[{jobId:'job',proofs:[proof]}],now);
    const pk=kind==='job'?'JOB#job':'SOURCE#ashby-acme';database.prepare("UPDATE catalog_items SET value=json_set(value,'$.concurrent',true) WHERE pk=?").run(pk);
    await expect(applyEarlyCareerBackfill(db,plan.repairToken,1,now)).rejects.toThrow();expect(current().admission?.catalogEligible).toBe(true);
    expect(database.prepare('SELECT count(*) AS n FROM role_metadata_repair_guards').get()).toMatchObject({n:0});
  });
  it('preserves valid programmes and suppresses backlog alerts',async()=>{
    const {db,proof,current}=setup();proof.artifact={title:'Associate Software Engineer',employmentType:'Intern',text:'Build Python APIs.'};
    const plan=await previewEarlyCareerBackfill(db,[{jobId:'job',proofs:[proof]}],now);expect(plan.reviews[0].change).toBe('kept');
    await applyEarlyCareerBackfill(db,plan.repairToken,1,now);expect(current()).toMatchObject({title:'Associate Software Engineer',programType:'internship',admission:{catalogEligible:true},notification:{smsPending:false,digestPending:false,smsSentAt:now}});
  });
  it('rejects a changed staged proposal, wrong counts, expired previews and stale proof',async()=>{
    const {db,proof}=setup();const plan=await previewEarlyCareerBackfill(db,[{jobId:'job',proofs:[proof]}],now);
    await expect(applyEarlyCareerBackfill(db,plan.repairToken,2,now)).rejects.toThrow('count');
    await expect(applyEarlyCareerBackfill(db,plan.repairToken,1,'2026-10-21T23:11:00Z')).rejects.toThrow('expired');
    database.prepare("UPDATE catalog_items SET value=json_set(value,'$.proposed','{}') WHERE kind='early-career-repair-stage' AND sk='ROW#0'").run();
    await expect(applyEarlyCareerBackfill(db,plan.repairToken,1,now)).rejects.toThrow('token');
    await expect(previewEarlyCareerBackfill(db,[{jobId:'job',proofs:[{...proof,observedAt:'2026-10-20T22:00:00Z'}]}],now)).rejects.toThrow('24 hours');
  });
  it('rejects another employer URL, unsupported absence and oversized batches',async()=>{
    const {db,proof}=setup();await expect(previewEarlyCareerBackfill(db,[{jobId:'job',proofs:[{...proof,sourceUrl:'https://evil.example/job'}]}],now)).rejects.toThrow('URL');
    await expect(previewEarlyCareerBackfill(db,[{jobId:'job',proofs:[{...proof,artifact:undefined,absence:{pageStatus:403}}]}],now)).rejects.toThrow('Uninspectable');
    await expect(previewEarlyCareerBackfill(db,Array.from({length:11},(_,i)=>({jobId:String(i),proofs:[proof]})),now)).rejects.toThrow('1–10');
  });
  it('requires reviewing every distinct open target before pruning',async()=>{
    const {db,proof,job}=setup();const other={...job.sourceReferences[0],sourceId:'other-source',externalId:'other',admission:{...job.admission!,destination:{...job.admission!.destination,expectedPostingId:'other-posting',finalUrl:'https://jobs.ashbyhq.com/acme/other-posting'}}};
    database.prepare("UPDATE catalog_items SET value=? WHERE pk='JOB#job'").run(JSON.stringify({...job,sourceReferences:[...job.sourceReferences,other]}));
    await expect(previewEarlyCareerBackfill(db,[{jobId:'job',proofs:[proof]}],now)).rejects.toThrow('Every distinct');
  });
});
