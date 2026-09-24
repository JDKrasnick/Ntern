import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrations = ['0013_posting_presentation_reviews.sql', '0034_posting_presentation_review_records.sql']
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
    ]);
    // No decision exists for the eight identities the review left unresolved:
    // the two removed Cole Engineering postings, the five General Dynamics
    // identities whose page now republishes under a different posting id, and
    // the GSK programme page that redirects away from the icims tenant.
    expect(database.prepare(`SELECT posting_id FROM posting_identity_presentation_reviews
      WHERE posting_id IN ('11204', '11206', '11013', '744000146822449', '744000146985399',
        '744000147019949', '744000147563929', '744000147583700')`).all()).toEqual([]);
    expect(database.prepare(`SELECT COUNT(DISTINCT evidence_hash) AS distinctHashes,
      COUNT(*) AS rows FROM posting_identity_presentation_reviews`).get()).toEqual({ distinctHashes: 12, rows: 12 });
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
});
