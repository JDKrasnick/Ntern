import { describe, expect, it } from 'vitest';
import { operationsSources } from '../src/integration-registry.js';
import { decodeSourceAllowlist, encodeSourceAllowlist, SOURCE_ALLOWLIST_BINDING_LIMIT, sourceAllowlistBindingValid } from '../src/ingestion-v2/source-allowlist.js';
import { ingestionV2FeatureConfig } from '../src/ingestion-v2/types.js';
import { admissionV2FeatureConfig, admissionV2OwnsCatalogWrites } from '../src/ingestion-v2/admission/types.js';
import { admissionSourceAllowed } from '../cloudflare/admission-v2.js';

describe('bounded literal source allowlists', () => {
  it('fits the actual full configured fleet in a 5 KiB text binding without changing identity', () => {
    const ids = operationsSources().map(source => source.sourceId).sort();
    expect(ids).toHaveLength(344);
    expect(Buffer.byteLength(ids.join(','))).toBeGreaterThan(SOURCE_ALLOWLIST_BINDING_LIMIT);
    const encoded = encodeSourceAllowlist(ids);
    expect(encoded).toMatch(/^prefixes-v1:/u);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(SOURCE_ALLOWLIST_BINDING_LIMIT);
    expect(decodeSourceAllowlist(encoded).sort()).toEqual(ids);
    expect(sourceAllowlistBindingValid(encoded)).toBe(true);
  });

  it('retains CSV and its existing omitted/empty-list semantics', () => {
    expect(decodeSourceAllowlist(undefined)).toEqual([]);
    expect(decodeSourceAllowlist(' a, b,, ')).toEqual(['a', 'b']);
    expect(encodeSourceAllowlist(['b', 'a', 'a'])).toBe('a,b');
    expect(admissionSourceAllowed({}, 'a')).toBe(true);
  });

  it('uses identical literal membership in discovery, admission, writer and legacy fences', () => {
    const value = 'prefixes-v1:{"ashby-":["alpha"],"lever-":["beta"],"":["community"]}';
    const env = {
      INGESTION_V2_SHADOW_DISCOVERY_ENABLED: 'true', INGESTION_V2_SHADOW_SOURCE_ALLOWLIST: value,
      INGESTION_V2_ADMISSION_ENABLED: 'true', INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST: value,
      INGESTION_V2_CATALOG_WRITER_ENABLED: 'true', INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST: value,
      INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST: value,
      INGESTION_V2_TRUSTED_COMMUNITY_ALERT_SOURCE_ALLOWLIST: value,
    };
    const ids = ['ashby-alpha', 'lever-beta', 'community'];
    expect(ingestionV2FeatureConfig(env).sourceAllowlist).toEqual(ids);
    expect(admissionV2FeatureConfig(env).sourceAllowlist).toEqual(ids);
    for (const id of ids) {
      expect(admissionSourceAllowed(env, id)).toBe(true);
      expect(admissionV2OwnsCatalogWrites(env, id)).toBe(true);
    }
    expect(admissionSourceAllowed(env, 'ashby-alpha-other')).toBe(false);
    expect(admissionV2OwnsCatalogWrites(env, 'ashby-alpha-other')).toBe(false);
    expect(admissionV2OwnsCatalogWrites({ ...env, INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST: 'community' }, 'ashby-alpha')).toBe(false);
  });

  it.each(['prefixes-v1:{}', 'prefixes-v1:[]', 'prefixes-v1:null', 'prefixes-v1:{',
    'prefixes-v1:{"unknown-":["a"]}', 'prefixes-v1:{"ashby-":["*"]}',
    'prefixes-v1:{"ashby-":[""]}', 'prefixes-v1:{"ashby-":[3]}',
    'prefixes-v1:{"ashby-":["a","a"]}', 'prefixes-v1:{"ashby-":["a"],"":["ashby-a"]}',
    'prefixes-v1:{"__proto__":["a"]}', 'prefixes-v1:{"ashby-":[]}'])('fails closed for malformed encoding %s', value => {
    expect(() => decodeSourceAllowlist(value)).toThrow();
    expect(() => admissionSourceAllowed({ INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST: value }, 'anything')).toThrow();
    expect(sourceAllowlistBindingValid(value)).toBe(false);
  });

  it('rejects oversized deployment bindings before Cloudflare apply', () => {
    expect(sourceAllowlistBindingValid('x'.repeat(5121))).toBe(false);
    expect(() => encodeSourceAllowlist(['*'])).toThrow('Invalid source identity');
    expect(() => encodeSourceAllowlist(Array.from({ length: 100 }, (_, index) => `${index}${'x'.repeat(195)}`)))
      .toThrow('text binding budget');
  });
});
