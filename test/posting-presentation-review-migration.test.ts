import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrations = ['0013_posting_presentation_reviews.sql', '0034_posting_presentation_review_records.sql',
  '0035_posting_source_corrections.sql',
  '0036_posting_withdrawal_reviews.sql']
  .map((name) => readFileSync(new URL(`../cloudflare/migrations/${name}`, import.meta.url), 'utf8'));

function migratedDatabase() {
  const database = new DatabaseSync(':memory:');
  for (const migration of migrations) database.exec(migration);
  return database;
}

describe('posting presentation review migration', () => {
  it('records only the exact official-page reviews as immutable decisions', () => {
    const database = migratedDatabase();

    expect(database.prepare(`SELECT provider, tenant, posting_id, company
      FROM posting_identity_presentation_reviews ORDER BY id`).all()).toEqual([
      { provider: 'goldman-sachs', tenant: 'goldman-sachs', posting_id: '171567', company: 'Goldman Sachs' },
      { provider: 'meta', tenant: 'meta', posting_id: '1027438186737957', company: 'Meta' },
      { provider: 'amazon', tenant: 'amazon', posting_id: '10517567', company: 'Amazon' },
      { provider: 'smartrecruiters', tenant: 'boschgroup', posting_id: '744000142898574', company: 'Bosch Group' },
      { provider: 'smartrecruiters', tenant: 'boschgroup', posting_id: '744000145507908', company: 'Bosch Group' },
      { provider: 'smartrecruiters', tenant: 'boschgroup', posting_id: '744000145785190', company: 'Bosch Group' },
      { provider: 'smartrecruiters', tenant: 'boschgroup', posting_id: '744000146546699', company: 'Bosch Group' },
      { provider: 'smartrecruiters', tenant: 'boschgroup', posting_id: '744000146546849', company: 'Bosch Group' },
      { provider: 'smartrecruiters', tenant: 'boschgroup', posting_id: '744000146547599', company: 'Bosch Group' },
      { provider: 'smartrecruiters', tenant: 'boschgroup', posting_id: '744000148575999', company: 'Bosch Group' },
      { provider: 'smartrecruiters', tenant: 'boschgroup', posting_id: '744000148595878', company: 'Bosch Group' },
      { provider: 'smartrecruiters', tenant: 'boschgroup', posting_id: '744000150217869', company: 'Bosch Group' },
      { provider: 'smartrecruiters', tenant: 'gdmsi', posting_id: '744000147554134', company: 'General Dynamics Mission Systems' },
      { provider: 'smartrecruiters', tenant: 'gdmsi', posting_id: '744000147556214', company: 'General Dynamics Mission Systems' },
      { provider: 'smartrecruiters', tenant: 'gdmsi', posting_id: '744000147561809', company: 'General Dynamics Mission Systems' },
      { provider: 'smartrecruiters', tenant: 'gdmsi', posting_id: '744000149415235', company: 'General Dynamics Mission Systems' },
      { provider: 'smartrecruiters', tenant: 'gdmsi', posting_id: '744000151059868', company: 'General Dynamics Mission Systems' },
      { provider: 'icims', tenant: 'gsk-us-earlytalent', posting_id: '11013', company: 'GSK' },
    ]);
    // No decision exists for the eight identities the review left unresolved:
    // the two removed Cole Engineering postings, the five General Dynamics
    // identities whose page now republishes under a different posting id, and
    // the GSK programme page that redirects away from the icims tenant.
    expect(database.prepare(`SELECT posting_id FROM posting_identity_presentation_reviews
      WHERE posting_id IN ('11204', '11206', '744000146822449', '744000146985399',
        '744000147019949', '744000147563929', '744000147583700')`).all()).toEqual([]);
    expect(database.prepare(`SELECT COUNT(DISTINCT evidence_hash) AS distinctHashes,
      COUNT(*) AS rows FROM posting_identity_presentation_reviews`).get()).toEqual({ distinctHashes: 18, rows: 18 });
    database.close();
  });

  it('rejects any later update or delete of a review', () => {
    const database = migratedDatabase();
    expect(() => database.exec("UPDATE posting_identity_presentation_reviews SET title = 'Wrong' WHERE provider = 'meta'"))
      .toThrow('posting identity presentation reviews are immutable');
    expect(() => database.exec("DELETE FROM posting_identity_presentation_reviews WHERE provider = 'meta'"))
      .toThrow('posting identity presentation reviews are immutable');
    expect(() => database.exec("DELETE FROM posting_identity_presentation_reviews WHERE provider = 'smartrecruiters'"))
      .toThrow('posting identity presentation reviews are immutable');
    database.close();
  });

  it('shows the reviewed employer, title, location, and apply URL for the remaining #262 groups', () => {
    const database = migratedDatabase();
    expect(database.prepare(`SELECT company, title, location, locations_json, apply_url, evidence_url
      FROM posting_identity_presentation_reviews WHERE posting_id = '744000148595878'`).all()).toEqual([{
      company: 'Bosch Group',
      title: 'Data Analytics Intern - Engineering & SAP Operations',
      location: '500 Barclay Blvd, Lincolnshire, IL 60069, USA',
      locations_json: '["500 Barclay Blvd, Lincolnshire, IL 60069, USA"]',
      apply_url: 'https://jobs.smartrecruiters.com/BoschGroup/744000148595878-data-analytics-intern-engineering-sap-operations',
      evidence_url: 'https://jobs.smartrecruiters.com/BoschGroup/744000148595878',
    }]);
    expect(database.prepare(`SELECT company, title, locations_json, apply_url
      FROM posting_identity_presentation_reviews WHERE posting_id = '10517567'`).all()).toEqual([{
      company: 'Amazon',
      title: 'Software Development Engineer Intern, Annapurna Labs - 2027',
      locations_json: '["USA, TX, Austin", "USA, WA, Seattle", "USA, NY, New York", "USA, CA, Cupertino"]',
      apply_url: 'https://www.amazon.jobs/en/jobs/10517567/software-development-engineer-intern-annapurna-labs-2027',
    }]);
    database.close();
  });

  it('records the reviewed republished-posting corrections and withdrawals as immutable decisions', () => {
    const database = migratedDatabase();
    expect(database.prepare(`SELECT provider, tenant, posting_id, canonical_url
      FROM posting_url_corrections ORDER BY id`).all()).toEqual([
      { provider: 'smartrecruiters', tenant: 'gdmsi', posting_id: '744000146822449',
        canonical_url: 'https://jobs.smartrecruiters.com/GDMSI/744000147561809-co-op-winter-2027-software-engineering-8-months' },
      { provider: 'smartrecruiters', tenant: 'gdmsi', posting_id: '744000146985399',
        canonical_url: 'https://jobs.smartrecruiters.com/GDMSI/744000147556214-co-op-winter-2027-software-engineering-developer-16-months' },
      { provider: 'smartrecruiters', tenant: 'gdmsi', posting_id: '744000147019949',
        canonical_url: 'https://jobs.smartrecruiters.com/GDMSI/744000147554134-co-op-winter-2027-software-developer-8-months' },
      { provider: 'smartrecruiters', tenant: 'gdmsi', posting_id: '744000147563929',
        canonical_url: 'https://jobs.smartrecruiters.com/GDMSI/744000149415235-co-op-winter-2027-software-engineering-taccis-solutions-12-months' },
      { provider: 'smartrecruiters', tenant: 'gdmsi', posting_id: '744000147583700',
        canonical_url: 'https://jobs.smartrecruiters.com/GDMSI/744000151059868-co-op-winter-2027-software-engineering-4-8-months' },
    ]);
    expect(database.prepare(`SELECT provider, tenant, posting_id FROM posting_withdrawal_reviews ORDER BY id`).all())
      .toEqual([
        { provider: 'icims', tenant: 'jobs-cesi', posting_id: '11204' },
        { provider: 'icims', tenant: 'jobs-cesi', posting_id: '11206' },
      ]);
    expect(() => database.exec("UPDATE posting_url_corrections SET canonical_url = 'https://jobs.smartrecruiters.com/GDMSI/1' WHERE posting_id = '744000146822449'"))
      .toThrow('posting URL corrections are immutable');
    expect(() => database.exec("DELETE FROM posting_url_corrections WHERE posting_id = '744000146822449'"))
      .toThrow('posting URL corrections are immutable');
    expect(() => database.exec("UPDATE posting_withdrawal_reviews SET posting_id = '11200' WHERE posting_id = '11204'"))
      .toThrow('posting withdrawal reviews are immutable');
    expect(() => database.exec("DELETE FROM posting_withdrawal_reviews WHERE posting_id = '11206'"))
      .toThrow('posting withdrawal reviews are immutable');
    database.close();
  });
});
