import { describe, expect, it, vi } from 'vitest';
import { ApplicationUrlValidationError, assessApplicationPageForListing, canonicalApplicationUrl, inspectApplicationPage, validateApplicationUrl, validateApplicationUrlWithEvidence } from '../src/core/application-url.js';

describe('application URL validation', () => {
  it('canonicalizes TikTok bare position URLs before validation', () => {
    expect(canonicalApplicationUrl('https://lifeattiktok.com/position/7623166667125508357'))
      .toBe('https://lifeattiktok.com/search/7623166667125508357');
    expect(canonicalApplicationUrl('https://lifeattiktok.com/position/7623166667125508357/detail'))
      .toBe('https://lifeattiktok.com/position/7623166667125508357/detail');
  });

  it('requires HTTPS before making a network request', async () => {
    await expect(validateApplicationUrl('http://careers.example.com/role', async () => {
      throw new Error('must not fetch');
    })).rejects.toThrow(ApplicationUrlValidationError);
  });

  it('rejects an aggregator destination before making a network request', async () => {
    let called = false;
    await expect(validateApplicationUrl('https://www.linkedin.com/jobs/123', async () => {
      called = true;
      return new Response('', { status: 200 });
    })).rejects.toThrow('aggregator-only');
    expect(called).toBe(false);
  });

  it('stores the resolved HTTPS destination', async () => {
    const validated = await validateApplicationUrl('https://careers.example.com/role', async () =>
      new Response('', { status: 200 }),
    );
    expect(validated).toBe('https://careers.example.com/role');
  });

  it('retries with GET when a server does not support HEAD', async () => {
    const methods: string[] = [];
    await expect(validateApplicationUrl('https://careers.example.com/role', async (_url, init) => {
      methods.push(String(init?.method));
      return new Response('', { status: methods.length === 1 ? 405 : 200 });
    })).resolves.toBe('https://careers.example.com/role');
    expect(methods).toEqual(['HEAD', 'GET', 'GET']);
  });

  it('releases every response while validating more than six application URLs', async () => {
    const responses: Response[] = [];
    const validate = (index: number) => validateApplicationUrl(`https://careers.example.com/role-${index}`, async (_url, init) => {
      const response = init?.method === 'HEAD'
        ? new Response('HEAD not supported', { status: 405 })
        : new Headers(init?.headers).has('Range')
          ? new Response('range probe', { status: 200 })
          : new Response(`<title>Software Engineer Intern ${index}</title>`, { status: 200, headers: { 'content-type': 'text/html' } });
      responses.push(response);
      return response;
    });

    await expect(Promise.all(Array.from({ length: 8 }, (_, index) => validate(index)))).resolves.toHaveLength(8);
    expect(responses).toHaveLength(24);
    expect(responses.every((response) => response.bodyUsed)).toBe(true);
  });

  it('does not wait for a remote response source to finish cancellation', async () => {
    let cancellationStarted = false;
    await expect(validateApplicationUrl('https://careers.example.com/role', async (_url, init) => {
      if (init?.method === 'HEAD') {
        return new Response(new ReadableStream({
          cancel() {
            cancellationStarted = true;
            return new Promise<void>(() => undefined);
          },
        }), { status: 200 });
      }
      return new Response('<title>Software Engineer Intern</title>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    })).resolves.toBe('https://careers.example.com/role');
    expect(cancellationStarted).toBe(true);
  });

  it('times out when a response body stream never yields a chunk', async () => {
    vi.useFakeTimers();
    try {
      const validation = inspectApplicationPage('https://careers.example.com/role', async () =>
        new Response(new ReadableStream({ pull() { return new Promise<void>(() => undefined); } }), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }));
      const rejected = expect(validation).rejects.toThrow('body timed out');
      await vi.advanceTimersByTimeAsync(8_001);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the body timeout to the complete stream rather than each chunk', async () => {
    vi.useFakeTimers();
    try {
      const validation = inspectApplicationPage('https://careers.example.com/role', async () =>
        new Response(new ReadableStream({
          pull(controller) {
            return new Promise<void>((resolve) => {
              setTimeout(() => {
                controller.enqueue(new TextEncoder().encode('<p>still loading</p>'));
                resolve();
              }, 3_000);
            });
          },
        }), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }));
      const rejected = expect(validation).rejects.toThrow('body timed out');
      await vi.advanceTimersByTimeAsync(8_001);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('inspects and cancels the first 512 KiB of an oversized declared page', async () => {
    const cancel = vi.fn();
    const prefix = '<title>Software Engineer Intern</title><main>Responsibilities and qualifications. 123456 ';
    const bytes = new TextEncoder().encode(prefix + 'x'.repeat(700 * 1024));
    const evidence = await inspectApplicationPage('https://jobs.lever.co/acme/123456', async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes); },
        cancel,
      }), { status: 200, headers: { 'content-type': 'text/html', 'content-length': String(bytes.byteLength) } }));
    expect(evidence).toMatchObject({ inspectionTruncated: true, inspectedBytes: 512 * 1024,
      title: 'Software Engineer Intern', postingIdPresent: true });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('treats an absent posting ID as unknown in a truncated streamed page', async () => {
    const prefix = '<title>Software Engineer Intern</title><script type="application/ld+json">{"@type":"JobPosting"}</script>';
    const evidence = await inspectApplicationPage('https://careers.example.com/jobs/123456', async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(prefix + 'x'.repeat(700 * 1024))); },
      }), { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(evidence).toMatchObject({ inspectionTruncated: true, inspectedBytes: 512 * 1024, jobPostingCount: 1 });
    expect(evidence).not.toHaveProperty('postingIdPresent');
  });

  it('includes truncation state in otherwise identical evidence hashes', async () => {
    const body = '<title>Software Engineer Intern</title><main>Responsibilities and qualifications.</main>';
    const complete = await inspectApplicationPage('https://jobs.example.com/123456', async () =>
      new Response(body, { headers: { 'content-type': 'text/html' } }));
    const truncated = await inspectApplicationPage('https://jobs.example.com/123456', async () =>
      new Response(body, { headers: { 'content-type': 'text/html', 'content-length': String(700 * 1024) } }));
    expect(truncated.inspectionTruncated).toBe(true);
    expect(truncated.contentHash).not.toBe(complete.contentHash);
  });

  it("reads a rendered job page instead of accepting a generic 200 shell", async () => {
    const id = '7623166667125508357';
    const methods: string[] = [];
    await expect(validateApplicationUrl(`https://lifeattiktok.com/position/${id}`, async (_url, init) => {
      methods.push(String(init?.method));
      return new Response(
        init?.method === 'GET' ? `<title>Machine Learning Engineer Intern</title><main>Job ${id}</main>` : '',
        { status: 200 },
      );
    })).resolves.toBe(`https://lifeattiktok.com/search/${id}`);
    expect(methods).toEqual(['HEAD', 'GET']);
  });

  it("scores a generic shell low even though it returns HTTP 200", async () => {
    await expect(inspectApplicationPage('https://careers.example.com/roles/7623166667125508357', async () =>
      new Response('<title>Join TikTok</title>', { status: 200, headers: { 'content-type': 'text/html' } }),
    )).resolves.toMatchObject({ expectedPostingId: '7623166667125508357', postingIdPresent: false, confidence: { level: 'medium', score: 55, recommendation: 'catalog-only' } });
  });

  it('extracts generic application-page evidence from an ordinary employer host', async () => {
    await expect(inspectApplicationPage('https://careers.example.com/jobs/7623166667125508357', async () =>
      new Response('<title>Software Engineer Intern</title><meta name="description" content="Build platform software.">7623166667125508357', { status: 200, headers: { 'content-type': 'text/html' } }),
    )).resolves.toMatchObject({ title: 'Software Engineer Intern', description: 'Build platform software.', expectedPostingId: '7623166667125508357', postingIdPresent: true, confidence: { level: 'high', score: 100, recommendation: 'alert-eligible' } });
  });
  it('counts distinct role links on an aggregate page without treating a newsletter signup as an application form', async () => {
    const html = `<title>Open roles at Acme</title><main>
      <a href="/jobs/one">Software Engineering Intern</a>
      <a href="/jobs/two">Data Science Intern</a>
      <a href="/roles/three#details">Product Design Intern</a>
      <form><input name="email"></form>
    </main>`;
    const evidence = await inspectApplicationPage('https://careers.example.com/open-roles', async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    expect(evidence).toMatchObject({ distinctJobLinkCount: 3 });
    expect(evidence).not.toHaveProperty('applicationFormPresent');
  });
  it('extracts bounded public job content from JSON-LD before generic page text', async () => {
    const description = `<p>${'Build reliable systems with our platform team. '.repeat(12)}Responsibilities include testing and deployment.</p>`;
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', description })}</script><main>Navigation text</main>`;
    await expect(inspectApplicationPage('https://careers.example.com/jobs/123456', async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    )).resolves.toMatchObject({ contentExcerpt: expect.stringContaining('Responsibilities include testing'), contentSource: 'json-ld', confidence: { signals: expect.arrayContaining(['substantive page content', 'job-description language']) } });
  });
  it('extracts authoritative closure language and structured validThrough before accepting a 200 page', async () => {
    const explicit = await inspectApplicationPage('https://careers.example.com/jobs/123456', async () =>
      new Response('<title>Software Engineering Intern</title><main>This position is no longer accepting applications.</main>',
        { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(explicit).toMatchObject({ closureState: 'gone', closureSignal: 'explicit-language' });

    const structured = await inspectApplicationPage('https://careers.example.com/jobs/123456', async () =>
      new Response(`<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting',
        description: 'Software Engineering Intern', validThrough: '2020-01-01' })}</script>`,
      { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(structured).toMatchObject({ validThrough: '2020-01-01T00:00:00.000Z', closureState: 'gone',
      closureSignal: 'valid-through-expired' });
  });
  it('uses validThrough only from the requested structured posting', async () => {
    const html = `<script type="application/ld+json">${JSON.stringify([
      { '@type': 'JobPosting', identifier: '999999', description: 'Related expired role', validThrough: '2020-01-01' },
      { '@type': 'JobPosting', identifier: '123456', description: 'Requested open role', validThrough: '2030-01-01' },
    ])}</script>`;
    await expect(inspectApplicationPage('https://careers.example.com/jobs/123456', async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    )).resolves.toMatchObject({ validThrough: '2030-01-01T00:00:00.000Z', closureState: 'open' });
  });
  it('ignores a sole structured posting when its identity does not match the requested role', async () => {
    const html = `<main>Requested role details and qualifications.</main><script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting', identifier: '999999', description: 'Related expired role', validThrough: '2020-01-01',
    })}</script>`;
    const evidence = await inspectApplicationPage('https://careers.example.com/jobs/123456', async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    expect(evidence).toMatchObject({ expectedPostingId: '123456', postingIdPresent: false, closureState: 'open',
      contentExcerpt: 'Requested role details and qualifications.', contentSource: 'main' });
    expect(evidence).not.toHaveProperty('validThrough');
  });
  it('recognizes common explicit closure artifacts with surrounding copy', async () => {
    for (const closure of ['This job has expired.', 'No longer accepting applications. View similar roles.']) {
      await expect(inspectApplicationPage('https://careers.example.com/jobs/123456', async () =>
        new Response(`<title>Software Engineering Intern</title><main>${closure}</main>`,
          { status: 200, headers: { 'content-type': 'text/html' } }),
      )).resolves.toMatchObject({ closureState: 'gone', closureSignal: 'explicit-language' });
    }
  });
  it('does not mistake generic careers policy copy for posting closure', async () => {
    const evidence = await inspectApplicationPage('https://careers.example.com/jobs/123456', async () =>
      new Response('<title>Software Engineering Intern</title><main>Benefits may change after positions are no longer available. Apply now.</main>',
        { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(evidence).toMatchObject({ closureState: 'open' });
  });
  it('does not close a live application form from related-role copy in the same body', async () => {
    const evidence = await inspectApplicationPage('https://careers.example.com/jobs/123456', async () =>
      new Response(`<title>Software Engineering Intern</title><main>${'Software Engineering Intern responsibilities. '.repeat(10)}
        <form id="application"><input type="file" name="resume"></form>
        <aside>Related role: This job has expired.</aside></main>`,
      { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(evidence).toMatchObject({ closureState: 'open', applicationFormPresent: true, postingIdPresent: false });
  });
  it('caps a generic career shell at catalog-only even when its metadata is present', async () => {
    await expect(inspectApplicationPage('https://careers.example.com/jobs/123456', async () =>
      new Response('<title>JPMC Candidate Experience page</title><meta name="description" content="Search opportunities.">', { status: 200, headers: { 'content-type': 'text/html' } }),
    )).resolves.toMatchObject({ confidence: { level: 'medium', score: 65, recommendation: 'catalog-only', signals: expect.arrayContaining(['generic career-page title']) } });
  });
  it('promotes substantive public job text that matches the source role', async () => {
    const html = `<meta name="description" content="Apply for this role."><main>${'Software Engineering Intern. '.repeat(20)}Responsibilities include testing distributed systems.</main>`;
    const evidence = await inspectApplicationPage('https://careers.example.com/jobs/workday-role', async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    expect(evidence.confidence).toMatchObject({ level: 'medium', score: 65 });
    expect(assessApplicationPageForListing('Software Engineer Intern', evidence)).toMatchObject({ level: 'high', score: 75, recommendation: 'alert-eligible', signals: expect.arrayContaining(['source role matches public job content']) });
  });
  it('does not alert when a specific posting collapses to a generic destination', () => {
    const confidence = assessApplicationPageForListing('Software Engineer Intern', {
      url: 'https://careers.example.com/', redirectedToGenericDestination: true,
      contentExcerpt: `${'Software Engineer Intern. '.repeat(20)}Responsibilities include testing distributed systems.`,
      confidence: { score: 75, level: 'high', recommendation: 'alert-eligible', signals: ['substantive page content', 'job-description language'] },
    });
    expect(confidence).toMatchObject({ score: 65, level: 'medium', recommendation: 'catalog-only', signals: expect.arrayContaining(['specific posting redirected to generic destination']) });
  });
  it('treats bot protection as unverified rather than a dead link', async () => {
    await expect(inspectApplicationPage('https://careers.example.com/jobs/123456', async () =>
      new Response('Access denied', { status: 403 }),
    )).resolves.toMatchObject({ confidence: { level: 'low', recommendation: 'review', signals: expect.arrayContaining(['access restricted to scraper']) } });
  });
  it('keeps HTTP 406 unverified at both URL and page probes', async () => {
    const url = 'https://careers.example.com/jobs/123456';
    await expect(validateApplicationUrlWithEvidence(url, async () =>
      new Response('Not acceptable', { status: 406 }),
    )).resolves.toMatchObject({ evidence: { confidence: { recommendation: 'review', signals: expect.arrayContaining(['access restricted to scraper']) } } });
    await expect(inspectApplicationPage(url, async () =>
      new Response('Not acceptable', { status: 406 }),
    )).resolves.toMatchObject({ confidence: { recommendation: 'review', signals: expect.arrayContaining(['access restricted to scraper']) } });
  });
  it('treats a server failure as transient rather than a dead link', async () => {
    await expect(inspectApplicationPage('https://careers.example.com/jobs/123456', async () =>
      new Response('Service unavailable', { status: 503 }),
    )).resolves.toMatchObject({ confidence: { level: 'low', recommendation: 'review', signals: expect.arrayContaining(['temporary server failure']) } });
  });
  it('rejects a successful response that resolves to an explicit error URL', async () => {
    const response = new Response('', { status: 200, headers: { 'content-type': 'text/html' } });
    Object.defineProperty(response, 'url', { value: 'https://careers.example.com/errorpage/?errortype=404' });
    await expect(inspectApplicationPage('https://careers.example.com/jobs/123456', async () => response)).rejects.toThrow('explicit error destination');
  });

  it('rejects broken destinations', async () => {
    await expect(validateApplicationUrl('https://careers.example.com/role', async () =>
      new Response('', { status: 404 }),
    )).rejects.toThrow('HTTP 404');
  });
});
