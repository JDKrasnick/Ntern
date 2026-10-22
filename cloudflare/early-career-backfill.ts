import {createHash} from 'node:crypto';
import {metadataCollectionTarget} from './catalog-admission-store.js';
import {metadataApiRoute} from '../src/metadata-acquisition.js';
import {extractPostingMetadataEvidence,mergeRoleMetadataEvidence,ROLE_METADATA_EXTRACTION_VERSION,type RoleMetadataArtifact} from '../src/role-metadata.js';
import {earlyCareerFromEvidence,enforceJobEarlyCareer,withEarlyCareerAdmission} from '../src/early-career-eligibility.js';
import {catalogEligible,alertEligible} from '../src/catalog-admission.js';
import {catalogSearchText,catalogSourceClasses} from '../src/catalog-fields.js';
import {openCatalogSortKey} from '../src/catalog-recency.js';
import type {D1Database} from './types.js';
import type {Internship,SourceOccurrenceState,RoleMetadataEvidence} from '../src/types.js';

const stageKind='early-career-repair-stage',planKind='early-career-repair-plan';
const maxBytes=4*1024*1024,maxRows=150;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export interface EarlyCareerProof {
  sourceId:string; externalId?:string; sourceUrl:string; observedAt:string;
  artifact?:RoleMetadataArtifact;
  absence?:{status?:number;pageStatus?:number;nullPosting?:boolean;outcome?:string};
}
interface StagedRow {pk:string;sk:string;original:string;proposed:string;jobId:string;canonical:boolean}
interface Review {jobId:string;company:string;oldTitle:string;title:string;change:'kept'|'pruned'|'added'|'withheld';presentationChanged:boolean;reason:string;evidence:string[];sourceUrls:string[]}
interface Plan {createdAt:string;expectedJobs:number;expectedRows:number;reviews:Review[];applied?:boolean}
const key=(target:NonNullable<ReturnType<typeof metadataCollectionTarget>>)=>JSON.stringify([target.providerIdentity.provider,target.providerIdentity.tenant,target.providerIdentity.postingId??target.candidateUrl]);
function normalizedUrl(value:string){const u=new URL(value);u.hash='';u.search='';u.pathname=u.pathname.replace(/\/apply\/?$/u,'').replace(/\/$/u,'');return u.href;}

/** Operations-only reviewed artifact repair. No network work, source dispatch,
 * lifecycle closure, notification events or changes to unrelated policy gates. */
export async function previewEarlyCareerBackfill(db:D1Database,candidates:Array<{jobId:string;proofs:EarlyCareerProof[]}>,now=new Date().toISOString()) {
  if(!Array.isArray(candidates)||!candidates.length||candidates.length>10||new Set(candidates.map(c=>c.jobId)).size!==candidates.length)throw Error('Preview requires 1–10 distinct jobs');
  const rows:StagedRow[]=[],reviews:Review[]=[];
  for(const candidate of candidates){
    if(typeof candidate.jobId!=='string'||candidate.jobId.length>512||!Array.isArray(candidate.proofs)||!candidate.proofs.length||candidate.proofs.length>20)throw Error('Invalid job/proof selection');
    const current=await db.prepare("SELECT value FROM catalog_items WHERE pk=? AND sk='META' AND kind='internship'").bind(`JOB#${candidate.jobId}`).first<{value:string}>();
    if(!current)throw Error('Job no longer exists');
    const job=JSON.parse(current.value) as Internship;
    if(!job.open||!job.admission)throw Error('Only open jobs with an existing admission may be reviewed');
    const evidence:RoleMetadataEvidence[]=[],covered=new Set<string>();
    for(const proof of candidate.proofs){
      const age=Date.parse(now)-Date.parse(proof.observedAt);
      if(!Number.isFinite(age)||age < -300000||age>24*60*60*1000)throw Error('Proof must be observed within 24 hours');
      const matches=job.sourceReferences.filter(r=>r.sourceId===proof.sourceId&&r.state==='open'&&(!proof.externalId||r.externalId===proof.externalId));
      if(matches.length!==1)throw Error('Proof must identify one exact source occurrence');
      const reference=matches[0];
      const target=reference&&metadataCollectionTarget(reference);
      if(!target)throw Error('Proof must match an existing open exact posting target');
      const route=metadataApiRoute(target.providerIdentity,target.candidateUrl);
      const source=new URL(proof.sourceUrl);
      if(source.protocol!=='https:'||source.username||source.password||source.port
        || !(proof.sourceUrl===route?.url||normalizedUrl(proof.sourceUrl)===normalizedUrl(target.candidateUrl)))throw Error('Proof URL does not match the exact employer target');
      covered.add(key(target));
      if(proof.artifact){
        const a=proof.artifact;
        if(typeof a.title!=='string'||!a.title.trim()||a.title.length>500||typeof(a.text??'')!=='string'||(a.text?.length??0)>80000||typeof(a.employmentType??'')!=='string'||(a.employmentType?.length??0)>100)throw Error('Artifact exceeds bounded schema');
        if(new TextEncoder().encode(JSON.stringify(a)).length>200000)throw Error('Artifact exceeds bounded schema');
        // Preserve the full exact artifact so a later metadata projection cannot
        // interpret a policy-only upload as withdrawal of salary/location fields.
        const artifact={...a};
        evidence.push(...extractPostingMetadataEvidence({artifact,sourceClass:proof.sourceUrl===route?.url?'official-api':'official-json-ld',sourceId:proof.sourceId,sourceUrl:proof.sourceUrl,observedAt:now,exactPosting:true}));
      }else{
        const a=proof.absence;
        const absent=a&&(a.pageStatus===404||a.pageStatus===410
          || target.providerIdentity.provider==='ashby'&&a.status===200&&a.pageStatus===200&&a.nullPosting===true&&a.outcome==='identity-mismatch');
        if(!absent)throw Error('Uninspectable or unsupported postings cannot be pruned as absent');
        const hash=sha(JSON.stringify({jobId:job.jobId,sourceUrl:proof.sourceUrl,absence:a}));
        const assessment=earlyCareerFromEvidence([]);
        evidence.push({schemaVersion:1,extractionVersion:ROLE_METADATA_EXTRACTION_VERSION,artifactHash:hash,sourceClass:'official-api',sourceId:proof.sourceId,sourceUrl:proof.sourceUrl,observedAt:now,exactPosting:true,
          earlyCareer:{...assessment,sourceClass:'official-api',sourceUrl:proof.sourceUrl,artifactHash:hash,observedAt:now}});
      }
    }
    // A live qualifying target protects a merged job when another alias is gone.
    const positives=evidence.filter(e=>e.earlyCareer?.status==='eligible');
    const assessment=earlyCareerFromEvidence(positives.length?positives:evidence);
    if(assessment.status!=='eligible'){
      if(candidate.proofs.some(p=>Date.parse(now)-Date.parse(p.observedAt)>30*60*1000))throw Error('Pruning proof must be refreshed within 30 minutes');
      const targets=job.sourceReferences.filter(r=>r.state==='open').flatMap(r=>{const t=metadataCollectionTarget(r);return t?[key(t)]:[];});
      if(targets.some(t=>!covered.has(t)))throw Error('Every distinct open target must be reviewed before pruning');
    }
    const sourceReferences=job.sourceReferences.map(r=>({...r,metadataEvidence:mergeRoleMetadataEvidence(r.metadataEvidence,evidence.filter(e=>e.sourceId===r.sourceId))}));
    const enrolled={...job,sourceReferences,admission:withEarlyCareerAdmission(job.admission,assessment)};
    const proposed=enforceJobEarlyCareer(enrolled,positives.length?positives:evidence);
    // Historical publication never replays a backlog alert.
    proposed.notification={...proposed.notification,smsPending:false,digestPending:false};
    const before=job.technical!==false&&catalogEligible(job),after=proposed.technical!==false&&catalogEligible(proposed);
    const presentationChanged=before&&after&&(job.title!==proposed.title||job.programType!==proposed.programType||job.season!==proposed.season);
    reviews.push({jobId:job.jobId,company:job.company,oldTitle:job.title,title:proposed.title,change:before?(after?'kept':'pruned'):(after?'added':'withheld'),presentationChanged,reason:assessment.reason,evidence:assessment.evidence,sourceUrls:candidate.proofs.map(p=>p.sourceUrl)});
    rows.push({pk:`JOB#${job.jobId}`,sk:'META',original:current.value,proposed:JSON.stringify(proposed),jobId:job.jobId,canonical:true});
    for(const reference of proposed.sourceReferences){
      const pk=`SOURCE#${reference.sourceId}`,sk=`OCCURRENCE#${reference.externalId}`;
      const item=await db.prepare("SELECT value FROM catalog_items WHERE pk=? AND sk=? AND kind='source-occurrence'").bind(pk,sk).first<{value:string}>();
      if(!item)continue;
      const state=JSON.parse(item.value) as SourceOccurrenceState;
      if(state.jobId!==job.jobId)throw Error('Occurrence was reassigned; review again');
      const occurrence={...state.occurrence,admission:reference.admission,metadataEvidence:reference.metadataEvidence};
      rows.push({pk,sk,original:item.value,proposed:JSON.stringify({...state,occurrence}),jobId:job.jobId,canonical:false});
    }
  }
  const serialized=JSON.stringify(rows);
  if(rows.length>maxRows||new TextEncoder().encode(serialized).length>maxBytes)throw Error('Preview exceeds bounded atomic repair size');
  const plan:Plan={createdAt:now,expectedJobs:candidates.length,expectedRows:rows.length,reviews};
  const token=sha('early-career-v4\n'+JSON.stringify(plan)+'\n'+serialized),pk=`EARLY_CAREER_REPAIR#${token}`;
  await db.batch([db.prepare('INSERT OR REPLACE INTO catalog_items(pk,sk,kind,value) VALUES(?,?,?,?)').bind(pk,'PLAN',planKind,JSON.stringify(plan)),
    ...rows.map((r,i)=>db.prepare('INSERT OR REPLACE INTO catalog_items(pk,sk,kind,value) VALUES(?,?,?,?)').bind(pk,`ROW#${i}`,stageKind,JSON.stringify(r)))]);
  return {repairToken:token,expectedJobs:plan.expectedJobs,expectedRows:plan.expectedRows,reviews,applied:false};
}

export async function applyEarlyCareerBackfill(db:D1Database,token:string,expectedJobs:number,now=new Date().toISOString()){
  if(!/^[a-f0-9]{64}$/u.test(token)||!Number.isInteger(expectedJobs)||expectedJobs<1||expectedJobs>10)throw Error('Exact preview token/count required');
  const pk=`EARLY_CAREER_REPAIR#${token}`;
  const record=await db.prepare('SELECT value FROM catalog_items WHERE pk=? AND sk=? AND kind=?').bind(pk,'PLAN',planKind).first<{value:string}>();
  if(!record)throw Error('Preview not found');
  const plan=JSON.parse(record.value) as Plan;
  if(plan.expectedJobs!==expectedJobs)throw Error('Preview count changed');
  const projectionRefreshRequired=plan.reviews.some(r=>r.change==='pruned'||r.change==='added'||r.presentationChanged);
  if(plan.applied)return {applied:true,alreadyApplied:true,reviews:plan.reviews,projectionRefreshRequired};
  if(Date.parse(now)-Date.parse(plan.createdAt)>10*60*1000)throw Error('Preview expired; review again');
  const staged=await db.prepare('SELECT value FROM catalog_items WHERE pk=? AND kind=? ORDER BY CAST(substr(sk,5) AS INTEGER)').bind(pk,stageKind).all<{value:string}>();
  const rows=staged.results.map(r=>JSON.parse(r.value) as StagedRow);
  if(rows.length!==plan.expectedRows||rows.length>maxRows||new TextEncoder().encode(JSON.stringify(rows)).length>maxBytes)throw Error('Staged rows changed');
  if(sha('early-career-v4\n'+JSON.stringify(plan)+'\n'+JSON.stringify(rows))!==token)throw Error('Staged content does not match the reviewed token');
  // Existing CHECK(ok=1) guard causes the entire D1 batch to roll back on any
  // changed/deleted canonical job or occurrence, before visibility can change.
  const guard=db.prepare(`INSERT INTO role_metadata_repair_guards(token,ok,applied_at)
    SELECT ?,CASE WHEN (SELECT count(*) FROM catalog_items WHERE pk=? AND kind=?)=? AND NOT EXISTS(
      SELECT 1 FROM catalog_items AS stage LEFT JOIN catalog_items AS current
       ON current.pk=json_extract(stage.value,'$.pk') AND current.sk=json_extract(stage.value,'$.sk')
      WHERE stage.pk=? AND stage.kind=? AND (current.value IS NULL OR current.value<>json_extract(stage.value,'$.original')))
     THEN 1 ELSE 0 END,?`).bind(token,pk,stageKind,plan.expectedRows,pk,stageKind,now);
  const updates=rows.map(row=>{
    if(!row.canonical)return db.prepare('UPDATE catalog_items SET value=? WHERE pk=? AND sk=? AND value=?').bind(row.proposed,row.pk,row.sk,row.original);
    const job=JSON.parse(row.proposed) as Internship,visible=job.technical!==false&&catalogEligible(job),alertable=alertEligible(job);
    return db.prepare(`UPDATE catalog_items SET value=?,url_key=?,fingerprint_key=?,sms_pending=?,digest_pending=?,catalog_state=?,catalog_sort_key=?,search_text=?,source_classes=? WHERE pk=? AND sk=? AND value=?`)
      .bind(row.proposed,job.normalizedUrl,job.fingerprint,job.notification.smsPending&&alertable?1:0,job.notification.digestPending&&alertable?1:0,
        visible?(job.open?'OPEN':'CLOSED'):null,visible?(job.open?openCatalogSortKey(job):`${job.lastSeenAt}#${job.jobId}`):null,
        visible?catalogSearchText(job):null,visible?JSON.stringify(catalogSourceClasses(job)):null,row.pk,row.sk,row.original);
  });
  const metadata=rows.filter(r=>r.canonical).flatMap(r=>{
    const job=JSON.parse(r.proposed) as Internship;
    const seen=new Set<string>();
    return job.sourceReferences.flatMap(ref=>(ref.metadataEvidence??[]).flatMap(e=>{
      if(!e.earlyCareer||e.observedAt!==plan.createdAt)return [];
      const key=JSON.stringify([e.sourceClass,e.sourceId,e.sourceUrl,e.artifactHash]);
      if(seen.has(key))return [];seen.add(key);
      return [db.prepare('UPDATE role_metadata_evidence SET is_current=0 WHERE job_id=? AND source_class=? AND source_id=? AND source_url=? AND observed_at<=? AND is_current=1')
        .bind(job.jobId,e.sourceClass,e.sourceId,e.sourceUrl,e.observedAt),
      db.prepare(`INSERT INTO role_metadata_evidence(job_id,source_class,source_id,source_url,artifact_hash,extraction_version,evidence,observed_at,is_current)
        VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT(job_id,source_class,source_id,source_url,artifact_hash) DO UPDATE SET extraction_version=excluded.extraction_version,evidence=excluded.evidence,observed_at=excluded.observed_at,is_current=1`)
        .bind(job.jobId,e.sourceClass,e.sourceId,e.sourceUrl,e.artifactHash,e.extractionVersion,JSON.stringify(e),e.observedAt)];
    }));
  });
  await db.batch([guard,...updates,...metadata,db.prepare('UPDATE catalog_items SET value=? WHERE pk=? AND sk=? AND kind=?').bind(JSON.stringify({...plan,applied:true}),'EARLY_CAREER_REPAIR#'+token,'PLAN',planKind)]);
  return {applied:true,alreadyApplied:false,reviews:plan.reviews,projectionRefreshRequired};
}
