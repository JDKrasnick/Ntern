import {readFile,appendFile} from 'node:fs/promises';
import type {EarlyCareerProof} from '../cloudflare/early-career-backfill.js';

// Private review input and receipts stay outside Git. The operator explicitly
// selects each job's expected visibility change before any public mutation.
interface ReviewedCandidate {
  jobId:string;proofs:EarlyCareerProof[];
  expected:{change:'kept'|'pruned'|'added'|'withheld';oldTitle:string;title:string};
}
const args=process.argv.slice(2);
const option=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const input=option('--input'),output=option('--receipts');
const base=process.env.CATALOG_API_URL?.replace(/\/$/u,''),secret=process.env.OPERATIONS_SHARED_SECRET;
if(!base||!secret||!input||!output)throw Error('CATALOG_API_URL, OPERATIONS_SHARED_SECRET, --input and --receipts are required');
const candidates=JSON.parse(await readFile(input,'utf8')) as ReviewedCandidate[];
if(!Array.isArray(candidates)||new Set(candidates.map(c=>c.jobId)).size!==candidates.length||candidates.some(c=>!c.expected))throw Error('Each distinct job requires an explicit reviewed expectation');
const apply=args.includes('--apply');
async function request(body:unknown){
 const response=await fetch(base+'/internal/early-career/backfill',{method:'POST',headers:{'X-Operations-Key':secret!,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
 const value=await response.json() as {repairToken?:string;expectedJobs?:number;reviews?:Array<{jobId:string;change:string;oldTitle:string;title:string}>;message?:string};
 if(!response.ok)throw Error(`Backfill HTTP ${response.status}: ${value.message??'request rejected'}`);
 return value;
}
for(let i=0;i<candidates.length;i+=10){
 const batch=candidates.slice(i,i+10);
 const preview=await request({action:'preview',candidates:batch.map(({jobId,proofs})=>({jobId,proofs}))});
 if(preview.expectedJobs!==batch.length||preview.reviews?.length!==batch.length)throw Error('Preview count mismatch');
 for(const c of batch){
  const actual=preview.reviews.find(r=>r.jobId===c.jobId);
  if(!actual||actual.change!==c.expected.change||actual.oldTitle!==c.expected.oldTitle||actual.title!==c.expected.title)throw Error(`Reviewed outcome changed for ${c.jobId}; inspect again before applying`);
 }
 await appendFile(output,JSON.stringify({at:new Date().toISOString(),stage:'preview',...preview})+'\n');
 if(apply){
  const result=await request({action:'apply',repairToken:preview.repairToken,expectedJobs:preview.expectedJobs});
  await appendFile(output,JSON.stringify({at:new Date().toISOString(),stage:'apply',...result})+'\n');
 }
 console.log(JSON.stringify({reviewed:Math.min(i+10,candidates.length),total:candidates.length,applied:apply,changes:preview.reviews.map(r=>({jobId:r.jobId,change:r.change}))}));
}
