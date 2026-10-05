import { afterEach, describe, expect, it, vi } from 'vitest';
import { officialAdmissionProviderProbe } from '../cloudflare/admission-v2-provider.js';
import { cloudflareAdmissionProber } from '../cloudflare/admission-v2.js';
afterEach(() => vi.unstubAllGlobals());
const resolver = { async resolve() { return ['93.184.216.34']; } };
const workable = 'https://apply.workable.com/cogna/j/45A6283F88/';
const helsing = 'https://helsing.ai/jobs/4941957101?gh_jid=4941957101';
const probe = (url: string, prober = officialAdmissionProviderProbe(resolver)) => prober(url);
const job = { shortcode:'45A6283F88',title:'Software Engineer Intern',url:'https://apply.workable.com/j/45A6283F88',description:'Internship responsibilities and qualifications. '.repeat(20) };
describe('official admission provider evidence', () => {
 it.each([429, 503])('settles a challenged employer page using its reviewed official API on HTTP %s', async status => {
  const fetcher = vi.fn(async (url: unknown) => String(url).includes('boards-api.greenhouse.io')
    ? Response.json({id:4941957101,title:'AI Research Intern',content:job.description,absolute_url:helsing})
    : new Response('<title>Vercel Security Checkpoint</title>',{status}));
  vi.stubGlobal('fetch',fetcher);
  expect(await cloudflareAdmissionProber(resolver).probe({sourceId:'source',externalId:'role',applyUrl:helsing,observedAt:new Date().toISOString()}))
    .toMatchObject({reachability:'live',evidence:{expectedPostingId:'4941957101'}});
  expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('uses the reviewed Helsing Greenhouse identity and retains public API provenance', async () => {
  const fetcher=vi.fn<(url: unknown) => Promise<Response>>(async()=>Response.json({id:4941957101,title:'AI Research Intern',content:job.description,absolute_url:helsing}));vi.stubGlobal('fetch',fetcher);
  const result=await probe(helsing);
  expect(String(fetcher.mock.calls[0]?.[0])).toContain('boards-api.greenhouse.io/v1/boards/helsing/jobs/4941957101');
  expect(result).toMatchObject({reachability:'live',evidence:{postingIdPresent:true,title:'AI Research Intern',confidence:{signals:expect.arrayContaining(['official provider API'])}}});
  expect(result?.evidence?.applicationFormPresent).toBeUndefined();
 });
 it.each([{id:1},{absolute_url:'https://helsing.ai/jobs/111'},{absolute_url:'http://helsing.ai/jobs/4941957101'}])('rejects mismatched Greenhouse publisher identity %j',async bad=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({id:4941957101,title:'AI Research Intern',content:job.description,absolute_url:helsing,...bad})));
  await expect(probe(helsing)).rejects.toMatchObject({classification:'upstream-server-error'});
 });
 it('probes a complete Workable published inventory once per delivery and binds exact posting IDs',async()=>{
  const fetcher=vi.fn(async()=>Response.json({name:'Cogna',jobs:[job]}));vi.stubGlobal('fetch',fetcher);
  const prober=officialAdmissionProviderProbe(resolver);
  expect(await probe(workable,prober)).toMatchObject({reachability:'live',evidence:{title:job.title,expectedPostingId:job.shortcode}});
  expect(await probe(workable.replace(job.shortcode,'AAAAAAAAAA'),prober)).toEqual({reachability:'gone'});
  expect(fetcher).toHaveBeenCalledOnce();
 });
 it.each([{jobs:[{...job,url:'https://evil.example/j/45A6283F88'}]}, {jobs:[job,job]}, {jobs:[],next_page:2}, {jobs:[],total:5}])('does not turn invalid inventories into live or closed decisions %j',async bad=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({name:'Cogna',...bad})));
  await expect(probe(workable)).rejects.toMatchObject({classification:'upstream-server-error'});
 });
 it('does not close a posting on a tenant API 404',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:404})));
  await expect(probe(workable)).rejects.toMatchObject({classification:'upstream-server-error'});
 });
 it('makes one throttled tenant request for peer rows and preserves its minimum wait',async()=>{
  const fetcher=vi.fn(async()=>new Response('',{status:429,headers:{'Retry-After':'7200'}}));vi.stubGlobal('fetch',fetcher);
  const prober=officialAdmissionProviderProbe(resolver);
  for(const url of [workable,workable.replace(job.shortcode,'AAAAAAAAAA')]) {
   await expect(probe(url,prober)).rejects.toMatchObject({classification:'destination-rate-limited',retryAfterMs:7200000});
  }
  expect(fetcher).toHaveBeenCalledOnce();
 });
 it('keeps oversized and malformed provider responses unresolved',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('x'.repeat(512*1024+1))));
  await expect(probe(workable)).rejects.toMatchObject({classification:'destination-timeout'});
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('not JSON')));
  await expect(probe(workable)).rejects.toMatchObject({classification:'upstream-server-error'});
 });
});
