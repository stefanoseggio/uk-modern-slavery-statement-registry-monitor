import { describe, expect, it } from 'vitest';

import { classify, computeContentFingerprint, computeStatusFingerprint, normalizeStatement, shouldDeliver } from '../src/deltaEngine.js';
import type { DeltaState, RawStatementRow } from '../src/types.js';

const YEAR = '2026';

function baseRow(overrides: Partial<RawStatementRow> = {}): RawStatementRow {
    return {
        StatementYear: '2026',
        OrganisationName: 'Acme Logistics Ltd',
        Address: '1 High Street',
        SectorType: 'Private',
        CompanyNumber: '01234567',
        LastUpdated: '01/06/2026',
        GroupSubmission: '',
        ParentName: '',
        StatementURL: 'https://acme-logistics.example/modern-slavery-statement',
        StatementSummaryURL: 'https://modern-slavery-statement-registry.service.gov.uk/statement-summary/ABC12345/2026',
        StatementStartDate: '01/01/2025',
        StatementEndDate: '31/12/2025',
        DateApproved: '15/05/2026',
        StatementIncludesOrgStructure: 'Yes',
        StatementIncludesPolicies: 'Yes',
        StatementIncludesRisksAssessment: 'Yes',
        StatementIncludesDueDiligence: 'Yes',
        StatementIncludesTraining: 'Yes',
        StatementIncludesGoals: 'Yes',
        OrganisationSectors: 'Transportation and storage',
        Turnover: '£36 million to £60 million',
        ILOIndicatorsInStatement: '',
        PDFDate: '2026-05-15T10:00:00',
        PDFURL: 'https://downloads.modern-slavery-statement-registry.service.gov.uk/pdf-published/ABC12345/2026/statement.pdf',
        ...overrides,
    };
}

function emptyState(): DeltaState {
    return { statements: {}, yearCache: {} };
}

/** Marks a year as having a completed baseline in state - the per-year equivalent of the old global `state.baselineComplete = true`. */
function markYearBaselined(state: DeltaState, year: string): void {
    // eslint-disable-next-line no-param-reassign -- test helper deliberately mutates the shared fixture state object
    state.yearCache[year] = { contentMd5: null, lastChecked: '2026-01-01T00:00:00.000Z', baselineComplete: true };
}

describe('computeContentFingerprint (canonicalization + SHA-256)', () => {
    it('is deterministic - the same statement always produces the same fingerprint', () => {
        const statement = normalizeStatement(baseRow());
        expect(computeContentFingerprint(statement)).toBe(computeContentFingerprint(statement));
    });

    it('produces a 64-character lowercase hex SHA-256 digest', () => {
        const statement = normalizeStatement(baseRow());
        expect(computeContentFingerprint(statement)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('changes when a real, hashed field changes', () => {
        const a = normalizeStatement(baseRow());
        const b = normalizeStatement(baseRow({ Turnover: 'Over £500 million' }));
        expect(computeContentFingerprint(a)).not.toBe(computeContentFingerprint(b));
    });

    it('does NOT change when only the recordId-forming fields are identical but object key order differs (canonicalization is order-independent)', () => {
        const statement = normalizeStatement(baseRow());
        // Rebuild an equivalent object with keys in a deliberately different order - canonicalize()
        // must sort keys recursively, so this must not affect the hash.
        const reordered = Object.fromEntries(Object.entries(statement).reverse()) as typeof statement;
        expect(computeContentFingerprint(reordered)).toBe(computeContentFingerprint(statement));
    });
});

describe('computeStatusFingerprint', () => {
    it('changes when a compliance-topic field changes', () => {
        const a = normalizeStatement(baseRow());
        const b = normalizeStatement(baseRow({ StatementIncludesGoals: '' }));
        expect(computeStatusFingerprint(a)).not.toBe(computeStatusFingerprint(b));
    });

    it('does NOT change when only a non-compliance field changes (e.g. Address) - content fingerprint still does', () => {
        const a = normalizeStatement(baseRow());
        const b = normalizeStatement(baseRow({ Address: '2 Different Street' }));
        expect(computeStatusFingerprint(a)).toBe(computeStatusFingerprint(b));
        expect(computeContentFingerprint(a)).not.toBe(computeContentFingerprint(b));
    });
});

describe('classify (state machine, per-year baseline scoping)', () => {
    it('classifies a never-seen statement as BASELINE_SNAPSHOT when this year has no baseline yet', () => {
        const statement = normalizeStatement(baseRow());
        const state = emptyState();
        const result = classify(statement, state, YEAR);
        expect(result.eventType).toBe('BASELINE_SNAPSHOT');
    });

    it('classifies a never-seen statement as NEW_STATEMENT once THIS year is baselined', () => {
        const statement = normalizeStatement(baseRow());
        const state = emptyState();
        markYearBaselined(state, YEAR);
        const result = classify(statement, state, YEAR);
        expect(result.eventType).toBe('NEW_STATEMENT');
    });

    it('a year with no yearCache entry at all is treated as not-yet-baselined, even if OTHER years are baselined (regression test for the global-boolean bug found by adversarial review)', () => {
        const statement = normalizeStatement(baseRow({ StatementYear: '2027' }));
        const state = emptyState();
        markYearBaselined(state, '2026'); // a different year is fully baselined
        const result = classify(statement, state, '2027'); // this year never has been
        expect(result.eventType).toBe('BASELINE_SNAPSHOT');
    });

    it('classifies a previously-seen, unchanged statement as STATEMENT_UNCHANGED', () => {
        const statement = normalizeStatement(baseRow());
        const state = emptyState();
        const first = classify(statement, state, YEAR);
        state.statements[statement.recordId] = { statusFingerprint: first.statusFingerprint, contentFingerprint: first.contentFingerprint, lastSeen: '2026-01-01T00:00:00.000Z' };
        const second = classify(statement, state, YEAR);
        expect(second.eventType).toBe('STATEMENT_UNCHANGED');
    });

    it('classifies a previously-seen, changed statement as STATEMENT_UPDATED - even before the baseline completes', () => {
        const original = normalizeStatement(baseRow());
        const state = emptyState();
        const first = classify(original, state, YEAR);
        state.statements[original.recordId] = { statusFingerprint: first.statusFingerprint, contentFingerprint: first.contentFingerprint, lastSeen: '2026-01-01T00:00:00.000Z' };

        const changed = normalizeStatement(baseRow({ Turnover: 'Over £500 million' }));
        const second = classify(changed, state, YEAR);
        expect(second.eventType).toBe('STATEMENT_UPDATED');
    });

    it('never mutates the passed-in state (classify is a pure read against state)', () => {
        const statement = normalizeStatement(baseRow());
        const state = emptyState();
        const snapshotBefore = JSON.stringify(state);
        classify(statement, state, YEAR);
        expect(JSON.stringify(state)).toBe(snapshotBefore);
    });
});

describe('shouldDeliver (delivery filter, kept separate from classify)', () => {
    it('always delivers NEW_STATEMENT and STATEMENT_UPDATED regardless of onlyNew', () => {
        const newStatement = normalizeStatement(baseRow());
        const state = emptyState();
        markYearBaselined(state, YEAR);
        const classified = classify(newStatement, state, YEAR);
        expect(classified.eventType).toBe('NEW_STATEMENT');
        expect(shouldDeliver(classified, true)).toBe(true);
        expect(shouldDeliver(classified, false)).toBe(true);
    });

    it('suppresses BASELINE_SNAPSHOT when onlyNew is true, delivers it when false', () => {
        const statement = normalizeStatement(baseRow());
        const state = emptyState(); // no baseline yet -> BASELINE_SNAPSHOT
        const classified = classify(statement, state, YEAR);
        expect(classified.eventType).toBe('BASELINE_SNAPSHOT');
        expect(shouldDeliver(classified, true)).toBe(false);
        expect(shouldDeliver(classified, false)).toBe(true);
    });

    it('suppresses STATEMENT_UNCHANGED when onlyNew is true, delivers it when false', () => {
        const statement = normalizeStatement(baseRow());
        const state = emptyState();
        const first = classify(statement, state, YEAR);
        state.statements[statement.recordId] = { statusFingerprint: first.statusFingerprint, contentFingerprint: first.contentFingerprint, lastSeen: '2026-01-01T00:00:00.000Z' };
        const classified = classify(statement, state, YEAR);
        expect(classified.eventType).toBe('STATEMENT_UNCHANGED');
        expect(shouldDeliver(classified, true)).toBe(false);
        expect(shouldDeliver(classified, false)).toBe(true);
    });

    it('a not-yet-baselined year correctly reports NEW_STATEMENT once its baseline flips true (regression test for the exact classify/onlyNew conflation bug found and fixed in Actor #1)', () => {
        const statement = normalizeStatement(baseRow());
        const state = emptyState();
        markYearBaselined(state, YEAR); // simulates a later run, after this year's baseline has genuinely completed
        const classified = classify(statement, state, YEAR);
        expect(classified.eventType).toBe('NEW_STATEMENT');
        expect(shouldDeliver(classified, false)).toBe(true);
    });
});
