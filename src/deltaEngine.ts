import { createHash } from 'node:crypto';

import type { ClassifiedEvent, DeltaState, EventType, NormalizedStatement, RawStatementRow, RecommendedTopic, StoredFingerprint } from './types.js';
import { RECOMMENDED_TOPICS } from './types.js';

/** Splits a real CRLF/LF-joined multi-value CSV field into a clean array, dropping blank entries. */
function splitMultiValue(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(/\r\n|\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

/** Registry booleans are encoded as the literal string 'Yes' or an empty string - never any other value observed live. */
function toBoolean(raw: string | undefined): boolean {
    return (raw ?? '').trim().toLowerCase() === 'yes';
}

function toNullableString(raw: string | undefined): string | null {
    const trimmed = (raw ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * `OrganisationName` is not always a name - confirmed live in ~0.1% of real 2026 rows, where it
 * holds a bare numeric reference while the real name sits in `ParentName` instead (see
 * ARCHITECTURE.md section 2; NOT correlated with GroupSubmission, so this is a genuine per-row
 * fallback, not a group-vs-standalone rule). Also strips stray literal quote characters some real
 * rows carry as data (e.g. a real name parses to `"Edelweiss Air Ltd."`, quotes included).
 */
function resolveDisplayName(organisationName: string | undefined, parentName: string | undefined): string | null {
    const cleaned = (organisationName ?? '').trim().replace(/^"+|"+$/g, '');
    const isBareNumeric = /^\d+$/.test(cleaned);
    if (cleaned.length > 0 && !isBareNumeric) return cleaned;
    return toNullableString(parentName);
}

/**
 * `StatementSummaryURL` alone is NOT a unique identifier - confirmed live in the real 2027 file,
 * where a single group statement PDF names several distinct organisations, and the registry's
 * CSV export gives each named organisation its own row while all of them share the one
 * `StatementSummaryURL` (e.g. 4 real, differently-named organisations - "CONCERT LIVING LIMITED",
 * "KEY UNLOCKING FUTURES LIMITED", "PROGRESS HOUSING ASSOCIATION LIMITED", "Progress Housing
 * Group" - all pointing at the same statement URL). Using the URL alone as the state-tracking key
 * would silently collapse these distinct organisations onto one tracked entity - the first row
 * seen would be recorded, and every subsequent row sharing that URL would be misclassified
 * against the FIRST organisation's fingerprint, producing spurious STATEMENT_UPDATED noise and
 * losing per-organisation tracking entirely. The compound key below (URL + the raw organisation
 * identifier as it appears in that row) resolves this. This was found by live end-to-end testing
 * of this exact actor, not anticipated in advance.
 */
function buildRecordId(statementSummaryUrl: string, row: RawStatementRow): string {
    const primaryOrgKey = (row.OrganisationName ?? '').trim() || (row.ParentName ?? '').trim() || (row.CompanyNumber ?? '').trim();
    if (primaryOrgKey) return `${statementSummaryUrl}::${primaryOrgKey}`;

    // Found by adversarial review: a static fallback literal here (e.g. 'unknown-organisation')
    // would itself collide whenever two rows sharing one URL ALSO have blank OrganisationName,
    // ParentName, and CompanyNumber - reintroducing the exact tracked-entity-loss failure the
    // compound key above was built to prevent, just via this last-resort path instead. There is
    // no way to GUARANTEE uniqueness from genuinely blank source fields, but folding in several
    // more real per-row fields makes a collision require ALL of them to also match, which is far
    // less likely for two genuinely different organisations than three blank fields alone.
    const fallbackKey = [row.DateApproved, row.StatementStartDate, row.StatementEndDate, row.Address, row.Turnover]
        .map((value) => (value ?? '').trim())
        .join('|');
    return `${statementSummaryUrl}::unknown-organisation::${fallbackKey}`;
}

export function normalizeStatement(row: RawStatementRow): NormalizedStatement {
    const statementSummaryUrl = toNullableString(row.StatementSummaryURL);
    if (!statementSummaryUrl) {
        throw new Error('Registry row is missing StatementSummaryURL - cannot track this record as it has no stable identifier.');
    }
    const recordId = buildRecordId(statementSummaryUrl, row);

    return {
        recordId,
        organisationName: resolveDisplayName(row.OrganisationName, row.ParentName),
        companyNumber: toNullableString(row.CompanyNumber),
        address: splitMultiValue(row.Address).join(', ') || null,
        parentName: toNullableString(row.ParentName),
        groupSubmission: toBoolean(row.GroupSubmission),
        sectorType: toNullableString(row.SectorType),
        organisationSectors: splitMultiValue(row.OrganisationSectors),
        turnover: toNullableString(row.Turnover),
        statementUrl: toNullableString(row.StatementURL),
        statementSummaryUrl,
        pdfUrl: toNullableString(row.PDFURL),
        statementYear: (row.StatementYear ?? '').trim(),
        statementStartDate: toNullableString(row.StatementStartDate),
        statementEndDate: toNullableString(row.StatementEndDate),
        dateApproved: toNullableString(row.DateApproved),
        lastUpdated: toNullableString(row.LastUpdated),
        pdfDate: toNullableString(row.PDFDate),
        includesOrgStructure: toBoolean(row.StatementIncludesOrgStructure),
        includesPolicies: toBoolean(row.StatementIncludesPolicies),
        includesRiskAssessment: toBoolean(row.StatementIncludesRisksAssessment),
        includesDueDiligence: toBoolean(row.StatementIncludesDueDiligence),
        includesTraining: toBoolean(row.StatementIncludesTraining),
        includesGoals: toBoolean(row.StatementIncludesGoals),
        // A real, non-empty ILOIndicatorsInStatement value means the organisation declared
        // finding ILO forced-labour indicators (confirmed live: the alternative,
        // NoILOIndicatorsInStatement='Yes', is what a "none found" declaration looks like).
        iloIndicatorsInStatement: (row.ILOIndicatorsInStatement ?? '').trim().length > 0,
    };
}

export function missingDisclosures(statement: NormalizedStatement): RecommendedTopic[] {
    const coverage: Record<RecommendedTopic, boolean> = {
        'Organisational structure': statement.includesOrgStructure,
        Policies: statement.includesPolicies,
        'Risk assessment': statement.includesRiskAssessment,
        'Due diligence': statement.includesDueDiligence,
        Training: statement.includesTraining,
        Goals: statement.includesGoals,
    };
    return RECOMMENDED_TOPICS.filter((topic) => !coverage[topic]);
}

export function isFullyCompliant(statement: NormalizedStatement): boolean {
    return missingDisclosures(statement).length === 0;
}

/** Recursive key-sort canonicalization - same discipline as Actor #1's deltaEngine.ts. */
function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value !== null && typeof value === 'object') {
        const sortedEntries = Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, val]) => [key, canonicalize(val)] as const);
        return Object.fromEntries(sortedEntries);
    }
    return value;
}

function sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
}

/** Excludes `recordId` (the state key itself, derived from other fields - contributes nothing new) and `statementSummaryUrl` (stable for a given recordId in practice, per buildRecordId). */
function hashableFields(statement: NormalizedStatement): Omit<NormalizedStatement, 'recordId' | 'statementSummaryUrl'> {
    const { recordId: _id, statementSummaryUrl: _url, ...rest } = statement;
    return rest;
}

export function computeContentFingerprint(statement: NormalizedStatement): string {
    return sha256(JSON.stringify(canonicalize(hashableFields(statement))));
}

/** The compliance-status subset a procurement-BD/compliance buyer actually escalates on - see ARCHITECTURE.md section 4. */
function statusRelevantFields(statement: NormalizedStatement) {
    return {
        includesOrgStructure: statement.includesOrgStructure,
        includesPolicies: statement.includesPolicies,
        includesRiskAssessment: statement.includesRiskAssessment,
        includesDueDiligence: statement.includesDueDiligence,
        includesTraining: statement.includesTraining,
        includesGoals: statement.includesGoals,
        iloIndicatorsInStatement: statement.iloIndicatorsInStatement,
    };
}

export function computeStatusFingerprint(statement: NormalizedStatement): string {
    return sha256(JSON.stringify(canonicalize(statusRelevantFields(statement))));
}

/**
 * Classifies one statement against the persisted delta state. Determines the statement's TRUE
 * event type only - it deliberately does not know about `onlyNew`. Whether a given event type is
 * actually delivered (pushed + charged) is a separate decision, made by `shouldDeliver` below.
 * This separation is deliberate: Actor #1 (TED) shipped a real bug from conflating classification
 * with delivery filtering in a single function (a not-yet-baselined run with onlyNew=false got
 * permanently stuck reporting BASELINE_SNAPSHOT even after the baseline completed) - this actor
 * is built with that lesson applied from the start, not retrofitted after the fact.
 *
 * `year` (the registry year being processed, NOT read from the statement's own self-reported
 * `statementYear` field) scopes the baseline-completion check per year - found by adversarial
 * review to be a real bug when baseline completion was a single global flag on `state`: adding a
 * year to `years` after an earlier run had already completed its baseline for a narrower
 * selection would misclassify every row in the newly-added year as NEW_STATEMENT (billed +
 * notified) instead of BASELINE_SNAPSHOT. Using the actual fetched file's year, not the row's own
 * field, avoids any dependency on that field always matching the file it came from.
 */
export function classify(statement: NormalizedStatement, state: DeltaState, year: string): ClassifiedEvent {
    const contentFingerprint = computeContentFingerprint(statement);
    const statusFingerprint = computeStatusFingerprint(statement);
    const previous = state.statements[statement.recordId];
    const yearBaselineComplete = state.yearCache[year]?.baselineComplete ?? false;

    let eventType: EventType;
    if (!previous) {
        eventType = yearBaselineComplete ? 'NEW_STATEMENT' : 'BASELINE_SNAPSHOT';
    } else if (previous.contentFingerprint !== contentFingerprint) {
        eventType = 'STATEMENT_UPDATED';
    } else {
        eventType = 'STATEMENT_UNCHANGED';
    }

    return { statement, eventType, statusFingerprint, contentFingerprint };
}

/**
 * Delivery filter, kept separate from classify() (see above). NEW_STATEMENT and
 * STATEMENT_UPDATED are always delivered - the two charged, buyer-relevant tiers.
 * BASELINE_SNAPSHOT and STATEMENT_UNCHANGED are only delivered when `onlyNew` is false.
 */
export function shouldDeliver(classified: ClassifiedEvent, onlyNew: boolean): boolean {
    if (classified.eventType === 'NEW_STATEMENT' || classified.eventType === 'STATEMENT_UPDATED') return true;
    return !onlyNew;
}

export function toStoredFingerprint(classified: ClassifiedEvent, seenAt: string): StoredFingerprint {
    return {
        statusFingerprint: classified.statusFingerprint,
        contentFingerprint: classified.contentFingerprint,
        lastSeen: seenAt,
    };
}
