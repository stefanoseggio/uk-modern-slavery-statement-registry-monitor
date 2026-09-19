import { afterEach, describe, expect, it, vi } from 'vitest';

import { classify, normalizeStatement } from '../src/deltaEngine.js';
import type { ActorInput, DeltaState, RawStatementRow } from '../src/types.js';

const pushedRecords: { record: unknown; eventName?: string }[] = [];
// null by default (no real platform timeout deadline) - matches today's behaviour where the
// per-run time-budget guard in routes.ts is skipped outside a real Actor run; individual tests
// override this to a concrete Date to exercise the guard itself.
let mockTimeoutAt: Date | null = null;

vi.mock('apify', () => ({
    Actor: {
        pushData: vi.fn(async (record: unknown, eventName?: string) => {
            pushedRecords.push({ record, eventName });
            return {};
        }),
        getEnv: vi.fn(() => ({ timeoutAt: mockTimeoutAt })),
    },
    log: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const fetchYearContentHash = vi.fn();
const fetchYearStatements = vi.fn();
vi.mock('../src/csvSource.js', () => ({
    fetchYearContentHash: (...args: unknown[]) => fetchYearContentHash(...args),
    fetchYearStatements: (...args: unknown[]) => fetchYearStatements(...args),
    // Mirrors csvSource.ts's real computed value for MAX_RETRY_ATTEMPTS=4/REQUEST_TIMEOUT_MS=20_000
    // (4 * 20_000ms requests + (1_000 + 2_000 + 4_000) * 1.3 max-jitter backoff = 89_100ms), so
    // routes.ts's own per-run time-budget guard is exercised against real numbers, not NaN/undefined.
    MAX_FETCH_WITH_RETRY_DURATION_MS: 89_100,
}));

const { computeEventId, eventNameFor, isHighValueChange, matchesFilters, run, toOutputRecord } = await import('../src/routes.js');

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

afterEach(() => {
    pushedRecords.length = 0;
    fetchYearContentHash.mockReset();
    fetchYearStatements.mockReset();
    mockTimeoutAt = null;
});

describe('matchesFilters', () => {
    const statement = normalizeStatement(baseRow());

    it('matches everything when no filters are set', () => {
        expect(matchesFilters(statement, {} as ActorInput)).toBe(true);
    });

    it('filters by sectorType', () => {
        expect(matchesFilters(statement, { sectorFilter: ['Private'] } as ActorInput)).toBe(true);
        expect(matchesFilters(statement, { sectorFilter: ['Public'] } as ActorInput)).toBe(false);
    });

    it('filters by turnover bracket', () => {
        expect(matchesFilters(statement, { turnoverFilter: ['£36 million to £60 million'] } as ActorInput)).toBe(true);
        expect(matchesFilters(statement, { turnoverFilter: ['Over £500 million'] } as ActorInput)).toBe(false);
    });

    it('filters out fully-compliant statements when onlyMissingDisclosures is true', () => {
        expect(matchesFilters(statement, { onlyMissingDisclosures: true } as ActorInput)).toBe(false);
        const nonCompliant = normalizeStatement(baseRow({ StatementIncludesGoals: '' }));
        expect(matchesFilters(nonCompliant, { onlyMissingDisclosures: true } as ActorInput)).toBe(true);
    });
});

describe('eventNameFor', () => {
    it('maps NEW_STATEMENT and STATEMENT_UPDATED to distinct, separately-priceable pay-per-event names', () => {
        expect(eventNameFor('NEW_STATEMENT')).toBe('new-statement');
        expect(eventNameFor('STATEMENT_UPDATED')).toBe('statement-updated');
        expect(eventNameFor('NEW_STATEMENT')).not.toBe(eventNameFor('STATEMENT_UPDATED'));
    });

    it('returns undefined (uncharged) for BASELINE_SNAPSHOT and STATEMENT_UNCHANGED', () => {
        expect(eventNameFor('BASELINE_SNAPSHOT')).toBeUndefined();
        expect(eventNameFor('STATEMENT_UNCHANGED')).toBeUndefined();
    });
});

describe('isHighValueChange', () => {
    it('is always true for NEW_STATEMENT', () => {
        const statement = normalizeStatement(baseRow());
        const classified = classify(statement, emptyState(), '2026');
        // force NEW_STATEMENT for this assertion regardless of baseline state
        expect(isHighValueChange({ ...classified, eventType: 'NEW_STATEMENT' }, undefined)).toBe(true);
    });

    it('is false for STATEMENT_UPDATED when the status fingerprint did not actually change', () => {
        const statement = normalizeStatement(baseRow());
        const classified = classify(statement, emptyState(), '2026');
        expect(isHighValueChange({ ...classified, eventType: 'STATEMENT_UPDATED' }, classified.statusFingerprint)).toBe(false);
    });

    it('is true for STATEMENT_UPDATED when the status fingerprint DID change', () => {
        const statement = normalizeStatement(baseRow());
        const classified = classify(statement, emptyState(), '2026');
        expect(isHighValueChange({ ...classified, eventType: 'STATEMENT_UPDATED' }, 'a-different-previous-fingerprint')).toBe(true);
    });

    it('is false for BASELINE_SNAPSHOT and STATEMENT_UNCHANGED', () => {
        const statement = normalizeStatement(baseRow());
        const classified = classify(statement, emptyState(), '2026');
        expect(isHighValueChange({ ...classified, eventType: 'BASELINE_SNAPSHOT' }, undefined)).toBe(false);
        expect(isHighValueChange({ ...classified, eventType: 'STATEMENT_UNCHANGED' }, classified.statusFingerprint)).toBe(false);
    });
});

describe('toOutputRecord / computeEventId', () => {
    it('produces a stable idempotency key that reproduces for the same classification', () => {
        const statement = normalizeStatement(baseRow());
        const classified = classify(statement, emptyState(), '2026');
        expect(computeEventId(classified)).toBe(computeEventId(classified));
    });

    it('carries missing_disclosures and is_fully_compliant derived from the statement', () => {
        const statement = normalizeStatement(baseRow({ StatementIncludesGoals: '' }));
        const classified = classify(statement, emptyState(), '2026');
        const record = toOutputRecord(classified, '2026-01-01T00:00:00.000Z');
        expect(record.missing_disclosures).toEqual(['Goals']);
        expect(record.is_fully_compliant).toBe(false);
    });
});

describe('run (integration - mocked csvSource, real classify/normalize/state pipeline)', () => {
    it('processes a fresh year as BASELINE_SNAPSHOT and populates state', async () => {
        fetchYearContentHash.mockResolvedValue('hash-v1==');
        fetchYearStatements.mockResolvedValue([baseRow()]);

        const state = emptyState();
        const stats = await run({ years: ['2026'], onlyNew: false } as ActorInput, state);

        expect(stats.totalPushed).toBe(1);
        expect(stats.byEventType.BASELINE_SNAPSHOT).toBe(1);
        expect(pushedRecords).toHaveLength(1);
        expect(pushedRecords[0].eventName).toBeUndefined(); // BASELINE_SNAPSHOT is never charged
        expect(state.yearCache['2026'].baselineComplete).toBe(true);
        expect(Object.keys(state.statements)).toHaveLength(1);
    });

    it('simulates a real API response mutation across two runs: an unchanged statement produces STATEMENT_UNCHANGED, and a genuinely changed field produces a charged STATEMENT_UPDATED', async () => {
        const state = emptyState();

        // Run 1: baseline, one statement, fully compliant.
        fetchYearContentHash.mockResolvedValueOnce('hash-v1==');
        fetchYearStatements.mockResolvedValueOnce([baseRow()]);
        await run({ years: ['2026'], onlyNew: false } as ActorInput, state);
        pushedRecords.length = 0;

        // Run 2, same content-hash as run 1 -> processYear must skip the download entirely.
        fetchYearContentHash.mockResolvedValueOnce('hash-v1==');
        const stats2 = await run({ years: ['2026'], onlyNew: false } as ActorInput, state);
        expect(fetchYearStatements).toHaveBeenCalledTimes(1); // NOT called again - cache hit
        expect(stats2.yearsSkippedUnchanged).toBe(1);
        expect(stats2.totalPushed).toBe(0);

        // Run 3: the registry's own data changed (simulating a real API response mutation) - a
        // compliance-relevant field flips from covered to missing, and the content-hash changes
        // accordingly (a real content-hash change always accompanies a real content change).
        fetchYearContentHash.mockResolvedValueOnce('hash-v2==');
        fetchYearStatements.mockResolvedValueOnce([baseRow({ StatementIncludesGoals: '' })]);
        const stats3 = await run({ years: ['2026'], onlyNew: false } as ActorInput, state);

        expect(stats3.byEventType.STATEMENT_UPDATED).toBe(1);
        expect(pushedRecords).toHaveLength(1);
        expect(pushedRecords[0].eventName).toBe('statement-updated'); // a real, charged delta trigger
        expect((pushedRecords[0].record as { missing_disclosures: string[] }).missing_disclosures).toEqual(['Goals']);
    });

    it('does not re-download or re-process a year whose HEAD check reports the same content-md5 (zero-cost no-change guarantee)', async () => {
        const state: DeltaState = { statements: {}, yearCache: { '2026': { contentMd5: 'already-cached==', lastChecked: '2025-01-01T00:00:00.000Z', baselineComplete: true } } };
        fetchYearContentHash.mockResolvedValue('already-cached==');

        const stats = await run({ years: ['2026'], onlyNew: false } as ActorInput, state);

        expect(fetchYearStatements).not.toHaveBeenCalled();
        expect(stats.yearsSkippedUnchanged).toBe(1);
        expect(stats.totalPushed).toBe(0);
    });

    it('does NOT cache the year (or mark it baselined) when maxItems truncates the pass - regression test for the exact bug found by live-testing this actor', async () => {
        fetchYearContentHash.mockResolvedValue('hash==');
        fetchYearStatements.mockResolvedValue([
            baseRow({ StatementSummaryURL: '.../1/2026', OrganisationName: 'Org One' }),
            baseRow({ StatementSummaryURL: '.../2/2026', OrganisationName: 'Org Two' }),
        ]);

        const state = emptyState();
        const stats = await run({ years: ['2026'], onlyNew: false, maxItems: 1 } as ActorInput, state);

        expect(stats.totalPushed).toBe(1);
        expect(state.yearCache['2026']).toBeUndefined(); // truncated - must not be cached
    });

    it('a row filtered out of delivery is still tracked in state, so a later run that loosens the filter correctly reports it as STATEMENT_UNCHANGED rather than a brand-new billed statement (regression test for the filter/baseline bug found by adversarial review)', async () => {
        const state = emptyState();
        const publicOrgRow = baseRow({ StatementSummaryURL: '.../public-org/2026', OrganisationName: 'Public Org', SectorType: 'Public' });
        const privateOrgRow = baseRow({ StatementSummaryURL: '.../private-org/2026', OrganisationName: 'Private Org', SectorType: 'Private' });

        // Run 1, filter=Private: the Public row is normalized/classified/tracked (recordSeen)
        // but never delivered, since it doesn't match the filter.
        fetchYearContentHash.mockResolvedValueOnce('hash-v1==');
        fetchYearStatements.mockResolvedValueOnce([publicOrgRow, privateOrgRow]);
        await run({ years: ['2026'], onlyNew: false, sectorFilter: ['Private'] } as ActorInput, state);
        expect(pushedRecords.map((p) => (p.record as { organisation_name: string }).organisation_name)).toEqual(['Private Org']);
        expect(Object.keys(state.statements)).toHaveLength(2); // both rows tracked, including the filtered-out one
        pushedRecords.length = 0;

        // Run 2: the OTHER row's content genuinely changes (forcing a real content-hash change
        // and a full re-walk of the file), while the Public row's own data stays byte-identical.
        // Filter loosens to Public.
        fetchYearContentHash.mockResolvedValueOnce('hash-v2==');
        fetchYearStatements.mockResolvedValueOnce([publicOrgRow, { ...privateOrgRow, LastUpdated: '02/06/2026' }]);
        const stats2 = await run({ years: ['2026'], onlyNew: false, sectorFilter: ['Public'] } as ActorInput, state);

        // Without the fix, the Public row would have had no state.statements entry from run 1
        // (filtered out before classify() ever ran) and would misclassify here as a billed
        // NEW_STATEMENT. With the fix, it was tracked in run 1, so it correctly reports as
        // STATEMENT_UNCHANGED - uncharged, and NOT a notification-worthy "new" statement.
        const publicPush = pushedRecords.find((p) => (p.record as { organisation_name: string }).organisation_name === 'Public Org');
        expect(publicPush).toBeDefined();
        expect((publicPush!.record as { event_type: string }).event_type).toBe('STATEMENT_UNCHANGED');
        expect(publicPush!.eventName).toBeUndefined(); // uncharged
        expect(stats2.byEventType.NEW_STATEMENT).toBeUndefined();
    });
});

describe('run - per-run cumulative time-budget guard (fleet-wide timeout-budget audit regression)', () => {
    it('does not attempt ANY year - not even the first - once too little real time remains before the platform timeout for one more worst case', async () => {
        const state = emptyState();
        fetchYearContentHash.mockResolvedValue('hash==');
        fetchYearStatements.mockResolvedValue([baseRow()]);

        // A year's own worst case is 2 * MAX_FETCH_WITH_RETRY_DURATION_MS (89_100ms) = 178_200ms,
        // plus a 30_000ms safety margin = 208_200ms required. Only 100s left is well under that -
        // starting a year here risks a real, hard platform kill mid-fetch, so the guard must refuse
        // to start it at all rather than only stopping between years.
        mockTimeoutAt = new Date(Date.now() + 100_000);

        const stats = await run({ years: ['2026', '2025'], onlyNew: false } as ActorInput, state);

        expect(fetchYearContentHash).not.toHaveBeenCalled();
        expect(stats.yearsChecked).toBe(0);
    });

    it('processes every selected year normally when this run has just started and the full budget remains', async () => {
        const state = emptyState();
        fetchYearContentHash.mockResolvedValue('hash==');
        fetchYearStatements.mockResolvedValue([baseRow()]);

        mockTimeoutAt = new Date(Date.now() + 290_000); // this actor's own ~300s run budget, fresh

        const stats = await run({ years: ['2026', '2025'], onlyNew: false } as ActorInput, state);

        expect(fetchYearContentHash).toHaveBeenCalledTimes(2);
        expect(stats.yearsChecked).toBe(2);
    });

    it('processes every selected year when there is no known platform timeout (e.g. a local/test run) - unchanged from before this guard existed', async () => {
        const state = emptyState();
        fetchYearContentHash.mockResolvedValue('hash==');
        fetchYearStatements.mockResolvedValue([baseRow()]);

        mockTimeoutAt = null;

        const stats = await run({ years: ['2026', '2025'], onlyNew: false } as ActorInput, state);

        expect(fetchYearContentHash).toHaveBeenCalledTimes(2);
        expect(stats.yearsChecked).toBe(2);
    });
});
