import { createHash } from 'node:crypto';

import { Actor, log } from 'apify';

import { fetchYearContentHash, fetchYearStatements, MAX_FETCH_WITH_RETRY_DURATION_MS } from './csvSource.js';
import {
    classify,
    isFullyCompliant,
    missingDisclosures,
    normalizeStatement,
    shouldDeliver,
    toStoredFingerprint,
} from './deltaEngine.js';
import { notifyAllChannels } from './notifier.js';
import { recordSeen, recordYearChecked } from './state.js';
import type {
    ActorInput,
    ClassifiedEvent,
    DeltaState,
    NormalizedStatement,
    OutputRecord,
    RawStatementRow,
    RegistryYear,
} from './types.js';

const EVENT_NEW_STATEMENT = 'new-statement';
const EVENT_STATEMENT_UPDATED = 'statement-updated';

/**
 * Worst-case wall-clock cost of processing ONE registry year: a HEAD check
 * (`fetchYearContentHash`) followed, when the content actually changed, by a full GET+parse
 * (`fetchYearStatements`) - two independent `fetchWithRetry` sequences, each able to run up to
 * MAX_FETCH_WITH_RETRY_DURATION_MS in the worst case. Parsing/normalizing/pushing/notifying a
 * year's rows is comparatively fast (real years observed live at a few seconds for the full file)
 * and isn't counted here - SAFETY_MARGIN_MS below covers that plus the platform's own run
 * teardown.
 */
const MAX_YEAR_DURATION_MS = MAX_FETCH_WITH_RETRY_DURATION_MS * 2;
const SAFETY_MARGIN_MS = 30_000;

export interface RunStats {
    totalPushed: number;
    stopped: boolean;
    yearsChecked: number;
    yearsSkippedUnchanged: number;
    byEventType: Record<string, number>;
}

export function computeEventId(classified: ClassifiedEvent): string {
    return createHash('sha1')
        .update(
            `${classified.statement.recordId}|${classified.eventType}|${classified.statusFingerprint}|${classified.contentFingerprint}`,
        )
        .digest('hex');
}

export function toOutputRecord(classified: ClassifiedEvent, scrapedAt: string): OutputRecord {
    const { statement } = classified;
    return {
        '@type': 'schema:Organization',
        event_id: computeEventId(classified),
        event_type: classified.eventType,
        record_id: statement.recordId,
        organisation_name: statement.organisationName,
        company_number: statement.companyNumber,
        address: statement.address,
        parent_name: statement.parentName,
        group_submission: statement.groupSubmission,
        sector_type: statement.sectorType,
        organisation_sectors: statement.organisationSectors,
        turnover: statement.turnover,
        statement_url: statement.statementUrl,
        statement_summary_url: statement.statementSummaryUrl,
        pdf_url: statement.pdfUrl,
        statement_year: statement.statementYear,
        statement_start_date: statement.statementStartDate,
        statement_end_date: statement.statementEndDate,
        date_approved: statement.dateApproved,
        last_updated: statement.lastUpdated,
        pdf_date: statement.pdfDate,
        includes_org_structure: statement.includesOrgStructure,
        includes_policies: statement.includesPolicies,
        includes_risk_assessment: statement.includesRiskAssessment,
        includes_due_diligence: statement.includesDueDiligence,
        includes_training: statement.includesTraining,
        includes_goals: statement.includesGoals,
        missing_disclosures: missingDisclosures(statement),
        is_fully_compliant: isFullyCompliant(statement),
        ilo_indicators_in_statement: statement.iloIndicatorsInStatement,
        status_fingerprint: classified.statusFingerprint,
        content_fingerprint: classified.contentFingerprint,
        is_new: classified.eventType === 'NEW_STATEMENT' || classified.eventType === 'BASELINE_SNAPSHOT',
        scraped_at: scrapedAt,
    };
}

/** Returns the pay-per-event charge event name for a given classification, or undefined for uncharged deliveries. */
export function eventNameFor(eventType: ClassifiedEvent['eventType']): string | undefined {
    switch (eventType) {
        case 'NEW_STATEMENT':
            return EVENT_NEW_STATEMENT;
        case 'STATEMENT_UPDATED':
            return EVENT_STATEMENT_UPDATED;
        default:
            return undefined; // BASELINE_SNAPSHOT / STATEMENT_UNCHANGED - never charged, see README Pricing section
    }
}

/**
 * Is this a change a compliance/procurement-BD buyer would actually escalate on? A brand-new
 * statement is always worth knowing about; an update only matters here if the compliance-relevant
 * fields (the six recommended topics, ILO indicators) actually changed THIS event - compared
 * against the previously stored status fingerprint, not merely current-value presence (the exact
 * bug class found and fixed in Actor #1's isHighValueChange - this actor is built with that
 * lesson applied from the start).
 */
export function isHighValueChange(classified: ClassifiedEvent, previousStatusFingerprint: string | undefined): boolean {
    if (classified.eventType === 'NEW_STATEMENT') return true;
    if (classified.eventType !== 'STATEMENT_UPDATED') return false;
    return previousStatusFingerprint !== classified.statusFingerprint;
}

export function matchesFilters(statement: NormalizedStatement, input: ActorInput): boolean {
    if (input.sectorFilter && input.sectorFilter.length > 0) {
        if (!statement.sectorType || !input.sectorFilter.includes(statement.sectorType)) return false;
    }
    if (input.turnoverFilter && input.turnoverFilter.length > 0) {
        if (!statement.turnover || !input.turnoverFilter.includes(statement.turnover)) return false;
    }
    if (input.onlyMissingDisclosures) {
        if (isFullyCompliant(statement)) return false;
    }
    return true;
}

async function processRow(
    row: RawStatementRow,
    year: RegistryYear,
    state: DeltaState,
    input: ActorInput,
    scrapedAt: string,
    stats: RunStats,
): Promise<void> {
    const onlyNew = input.onlyNew ?? true;

    let statement: NormalizedStatement;
    try {
        statement = normalizeStatement(row);
    } catch (error) {
        log.warning(
            `Skipping one row that could not be normalized: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
    }

    // Captured before recordSeen() overwrites this statement's stored fingerprint - the only way
    // to know whether THIS event actually changed the status-tier fields.
    const previousStatusFingerprint = state.statements[statement.recordId]?.statusFingerprint;
    const classified = classify(statement, state, year);

    // Every real, normalizable row is tracked in state (recordSeen, below) regardless of the
    // user's delivery filters (sectorFilter/turnoverFilter/onlyMissingDisclosures) or onlyNew -
    // filtering controls what gets DELIVERED (pushed/charged/notified) this run, never whether a
    // row counts toward this year's baseline. Gating tracking itself on the filters was a real
    // bug, found by adversarial review: a row excluded by a narrow filter was invisible to
    // state.statements entirely, so loosening that filter later (or simply running with a
    // different filter after baseline had completed) made already-existing rows look
    // "never seen", misclassifying them as billed NEW_STATEMENT events instead of the harmless
    // STATEMENT_UNCHANGED/BASELINE_SNAPSHOT they actually are.
    const deliverable = matchesFilters(statement, input) && shouldDeliver(classified, onlyNew);

    if (!deliverable) {
        recordSeen(state, statement.recordId, toStoredFingerprint(classified, scrapedAt));
        return;
    }

    const record = toOutputRecord(classified, scrapedAt);
    const eventName = eventNameFor(classified.eventType);
    const pushResult = eventName
        ? await Actor.pushData(record, eventName)
        : ({} as { eventChargeLimitReached?: boolean });
    if (!eventName) await Actor.pushData(record);

    // eslint-disable-next-line no-param-reassign
    stats.totalPushed += 1;
    // eslint-disable-next-line no-param-reassign
    stats.byEventType[classified.eventType] = (stats.byEventType[classified.eventType] ?? 0) + 1;

    if (isHighValueChange(classified, previousStatusFingerprint)) {
        await notifyAllChannels(
            {
                webhookUrl: input.webhookUrl,
                slackWebhookUrl: input.slackWebhookUrl,
                teamsWebhookUrl: input.teamsWebhookUrl,
            },
            record,
        );
    }

    // Only commit the new fingerprint for a row that was successfully pushed (or filtered out
    // above, before any charge risk) - a record held back by a charge/item limit must remain
    // eligible to be correctly reclassified next run, not silently marked seen with a fingerprint
    // it was never billed for.
    recordSeen(state, statement.recordId, toStoredFingerprint(classified, scrapedAt));

    if (pushResult.eventChargeLimitReached || (input.maxItems && stats.totalPushed >= input.maxItems)) {
        // eslint-disable-next-line no-param-reassign
        stats.stopped = true;
    }
}

async function processYear(
    year: RegistryYear,
    state: DeltaState,
    input: ActorInput,
    scrapedAt: string,
    stats: RunStats,
): Promise<void> {
    const cached = state.yearCache[year];
    let contentMd5: string | null;
    try {
        contentMd5 = await fetchYearContentHash(year);
    } catch (error) {
        log.warning(
            `Could not check registry year ${year} (HEAD request failed): ${error instanceof Error ? error.message : String(error)}. Skipping this year for this run.`,
        );
        return;
    }

    if (contentMd5 === null) {
        // Real 404 (a not-yet-published future year) or the header was genuinely absent - never
        // treated as "unchanged" (that would silently and permanently stop checking a year that
        // could still appear later, or that briefly lacked the header for an unrelated reason).
        // Also covers the extremely unlikely case of a previously-published year disappearing:
        // rather than proceed to a download that would also 404, skip cleanly this run.
        if (cached !== undefined) {
            log.warning(
                `Registry year ${year} previously had cached content but now returns no content-md5 (real 404 or missing header) - skipping this run rather than treating it as unchanged.`,
            );
        }
        return;
    }

    // eslint-disable-next-line no-param-reassign
    stats.yearsChecked += 1;

    if (cached?.contentMd5 === contentMd5) {
        log.info(
            `Registry year ${year}: content-hash unchanged since last run (${contentMd5}) - skipping download entirely.`,
        );
        // eslint-disable-next-line no-param-reassign
        stats.yearsSkippedUnchanged += 1;
        // Preserve whatever baselineComplete already was - an unchanged year that was already
        // fully baselined stays baselined; one that never finished (or was never seen) stays not.
        recordYearChecked(state, year, {
            contentMd5,
            lastChecked: scrapedAt,
            baselineComplete: cached?.baselineComplete ?? false,
        });
        return;
    }

    log.info(
        `Registry year ${year}: content-hash ${cached ? 'changed' : 'not yet cached'} - downloading and processing full file.`,
    );
    let rows: RawStatementRow[];
    try {
        rows = await fetchYearStatements(year);
    } catch (error) {
        // A transient download/parse failure on ONE year must not abort the whole run - other,
        // independent years in `years` are still worth attempting. Found by adversarial review:
        // this GET path previously had no try/catch, unlike the HEAD check just above, so a
        // single flaky year failed the entire Actor run instead of being skipped like a 404 is.
        log.warning(
            `Could not download or parse registry year ${year}: ${error instanceof Error ? error.message : String(error)}. Skipping this year for this run - already-cached years and other selected years are unaffected.`,
        );
        return;
    }
    log.info(`Registry year ${year}: parsed ${rows.length} real statement rows.`);

    for (const row of rows) {
        if (stats.stopped) break;
        await processRow(row, year, state, input, scrapedAt, stats);
    }

    // Only cache this year's content-hash (and mark its baseline complete) if the ENTIRE file was
    // walked without maxItems (or a pay-per-event charge limit) cutting it short. Caching it
    // unconditionally here was a real bug, found by live-testing this exact actor: on the next
    // run, a cache-hit skips the download entirely (see the branch above) - so if a truncated
    // pass had already cached the hash, the never-reached tail of that file would be permanently
    // stranded, since the file's content genuinely hasn't changed and no future run would ever
    // re-fetch it. Leaving the cache untouched on a truncated pass means the next run
    // re-downloads and re-walks the same file from the start - already-seen rows resolve as
    // cheap, uncharged STATEMENT_UNCHANGED, and the previously-unreached rows finally get
    // processed. This mirrors the fix applied to Actor #1 (TED)'s analogous BACKFILL
    // token-advancement bug.
    if (!stats.stopped) {
        recordYearChecked(state, year, { contentMd5, lastChecked: scrapedAt, baselineComplete: true });
    }
}

export async function run(input: ActorInput, state: DeltaState): Promise<RunStats> {
    const scrapedAt = new Date().toISOString();
    const stats: RunStats = {
        totalPushed: 0,
        stopped: false,
        yearsChecked: 0,
        yearsSkippedUnchanged: 0,
        byEventType: {},
    };
    const years = input.years && input.years.length > 0 ? input.years : (['2026'] as RegistryYear[]);

    // Per-run cumulative time-budget guard (fleet-wide timeout-budget audit, 2026-09-19
    // recurrence): `years` lets one run select several independent registry years, each doing its
    // own HEAD-then-GET fetchWithRetry sequence. Even with a single such call's worst case now
    // comfortably under this actor's run timeout on its own (see csvSource.ts), several unlucky
    // years compounding in the same run still could not be - so before starting each year, check
    // there's real budget left for another year's worst case. `Actor.getEnv().timeoutAt` is the
    // platform's own authoritative kill time for THIS run (it reflects whatever timeoutSecs the
    // run was actually started with, not just the Actor's configured default), so this guard stays
    // correct even if run options are overridden. It's null outside a real platform run (e.g. this
    // actor's own unit tests) - the guard is skipped rather than guessed at, unchanged from today.
    const { timeoutAt } = Actor.getEnv();

    for (const year of years) {
        if (stats.stopped) break;
        if (timeoutAt) {
            const remainingMs = timeoutAt.getTime() - Date.now();
            if (remainingMs < MAX_YEAR_DURATION_MS + SAFETY_MARGIN_MS) {
                const remainingYears = years.slice(years.indexOf(year));
                log.warning(
                    `Stopping before registry year ${year}: only ~${Math.round(remainingMs / 1000)}s remain before this run's platform timeout - not enough for another year's worst-case HEAD+GET retry sequence (~${Math.round(MAX_YEAR_DURATION_MS / 1000)}s) plus a ${Math.round(SAFETY_MARGIN_MS / 1000)}s safety margin. Remaining year(s) (${remainingYears.join(', ')}) were not attempted this run and will be picked up on the next one - already-processed years and rows this run are unaffected.`,
                );
                break;
            }
        }
        await processYear(year, state, input, scrapedAt, stats);
    }

    return stats;
}
