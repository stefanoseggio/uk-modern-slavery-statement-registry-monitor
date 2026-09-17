export type RegistryYear = '2020' | '2021' | '2022' | '2023' | '2024' | '2025' | '2026' | '2027';

export interface ActorInput {
    years?: RegistryYear[];
    sectorFilter?: string[];
    turnoverFilter?: string[];
    onlyMissingDisclosures?: boolean;
    maxItems?: number;
    deltaStateName?: string;
    resetState?: boolean;
    onlyNew?: boolean;
    webhookUrl?: string;
    slackWebhookUrl?: string;
    teamsWebhookUrl?: string;
}

/**
 * The real CSV column set for a StatementSummaries{YEAR}.csv row, confirmed by parsing the live
 * 2026 file end-to-end with `csv-parse` (76 real columns; only the subset this actor uses is
 * typed here). Every field is a string because that's genuinely what `csv-parse` with
 * `columns: true` returns - CSV has no native types, and this actor does its own conversion
 * (booleans from 'Yes'/empty, arrays from CRLF-joined lists) in `normalizeStatement()`.
 */
export interface RawStatementRow {
    StatementYear: string;
    OrganisationName: string;
    Address: string;
    SectorType: string;
    CompanyNumber: string;
    LastUpdated: string;
    GroupSubmission: string;
    ParentName: string;
    StatementURL: string;
    StatementSummaryURL: string;
    StatementStartDate: string;
    StatementEndDate: string;
    DateApproved: string;
    StatementIncludesOrgStructure: string;
    StatementIncludesPolicies: string;
    StatementIncludesRisksAssessment: string;
    StatementIncludesDueDiligence: string;
    StatementIncludesTraining: string;
    StatementIncludesGoals: string;
    OrganisationSectors: string;
    Turnover: string;
    ILOIndicatorsInStatement: string;
    PDFDate: string;
    PDFURL: string;
    [otherColumn: string]: string;
}

export type EventType = 'NEW_STATEMENT' | 'STATEMENT_UPDATED' | 'STATEMENT_UNCHANGED' | 'BASELINE_SNAPSHOT';

/** The six real government-recommended topics a statement can cover - confirmed against the live registry's own stats page and CSV columns. */
export const RECOMMENDED_TOPICS = [
    'Organisational structure',
    'Policies',
    'Risk assessment',
    'Due diligence',
    'Training',
    'Goals',
] as const;

export type RecommendedTopic = (typeof RECOMMENDED_TOPICS)[number];

export interface NormalizedStatement {
    /**
     * A compound key: `${StatementSummaryURL}::${raw organisation identifier for this row}`.
     * `StatementSummaryURL` alone is NOT unique per organisation - a real, live-verified group
     * statement can name several distinct organisations under one shared statement URL (see
     * deltaEngine.ts's `buildRecordId` for the full finding). This compound form is this actor's
     * actual state-tracking key.
     */
    recordId: string;
    organisationName: string | null;
    companyNumber: string | null;
    address: string | null;
    parentName: string | null;
    groupSubmission: boolean;
    sectorType: string | null;
    organisationSectors: string[];
    turnover: string | null;
    statementUrl: string | null;
    statementSummaryUrl: string;
    pdfUrl: string | null;
    statementYear: string;
    statementStartDate: string | null;
    statementEndDate: string | null;
    dateApproved: string | null;
    lastUpdated: string | null;
    pdfDate: string | null;
    includesOrgStructure: boolean;
    includesPolicies: boolean;
    includesRiskAssessment: boolean;
    includesDueDiligence: boolean;
    includesTraining: boolean;
    includesGoals: boolean;
    iloIndicatorsInStatement: boolean;
}

export interface StoredFingerprint {
    statusFingerprint: string;
    contentFingerprint: string;
    lastSeen: string;
}

export interface YearCacheEntry {
    /** The real Azure Blob `Content-MD5` response header value from the last time this year was fetched. */
    contentMd5: string | null;
    lastChecked: string;
    /**
     * True once at least one FULL, untruncated pass over this specific year's file has completed.
     * Scoped per year, not global - found by adversarial review to be a real bug when it was a
     * single `DeltaState.baselineComplete` boolean: broadening `years` (or loosening
     * sectorFilter/turnoverFilter/onlyMissingDisclosures - see recordSeen's call site in
     * routes.ts, which now records every row regardless of filters) after baseline had already
     * completed for a narrower scope would misclassify every row newly brought into scope as
     * NEW_STATEMENT (billed + notified) instead of BASELINE_SNAPSHOT, since the flag had no way
     * to know a given year/row combination had never actually been walked before.
     */
    baselineComplete: boolean;
}

export interface DeltaState {
    /** Keyed by recordId (StatementSummaryURL). */
    statements: Record<string, StoredFingerprint>;
    /** Keyed by registry year - the cheap change-detection cache described in ARCHITECTURE.md section 0, and (see YearCacheEntry.baselineComplete) the per-year baseline-completion flag. */
    yearCache: Record<string, YearCacheEntry>;
}

export interface ClassifiedEvent {
    statement: NormalizedStatement;
    eventType: EventType;
    statusFingerprint: string;
    contentFingerprint: string;
}

export interface OutputRecord {
    '@type': 'schema:Organization';
    event_id: string;
    event_type: EventType;
    record_id: string;
    organisation_name: string | null;
    company_number: string | null;
    address: string | null;
    parent_name: string | null;
    group_submission: boolean;
    sector_type: string | null;
    organisation_sectors: string[];
    turnover: string | null;
    statement_url: string | null;
    statement_summary_url: string;
    pdf_url: string | null;
    statement_year: string;
    statement_start_date: string | null;
    statement_end_date: string | null;
    date_approved: string | null;
    last_updated: string | null;
    pdf_date: string | null;
    includes_org_structure: boolean;
    includes_policies: boolean;
    includes_risk_assessment: boolean;
    includes_due_diligence: boolean;
    includes_training: boolean;
    includes_goals: boolean;
    missing_disclosures: RecommendedTopic[];
    is_fully_compliant: boolean;
    ilo_indicators_in_statement: boolean;
    status_fingerprint: string;
    content_fingerprint: string;
    is_new: boolean;
    scraped_at: string;
}
