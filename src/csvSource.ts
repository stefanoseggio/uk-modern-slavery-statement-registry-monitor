import { log } from 'apify';
import { parse } from 'csv-parse/sync';

import type { RawStatementRow, RegistryYear } from './types.js';

/**
 * The registry's real, official, per-year bulk CSV download - confirmed live, hosted on Azure
 * Blob Storage, no authentication, licensed under the Open Government Licence v3.0. See
 * ARCHITECTURE.md section 0.
 */
const DOWNLOAD_BASE = 'https://downloads.modern-slavery-statement-registry.service.gov.uk/publicdownloads';

const USER_AGENT = 'DeltaRegistryUKModernSlaveryMonitor/1.0 (+https://apify.com/stefano_seggio/uk-modern-slavery-statement-registry-monitor)';

/**
 * Sized against this actor's own defaultRunOptions.timeoutSecs = 300 (confirmed live via
 * `GET /v2/acts/stefano_seggio~uk-modern-slavery-statement-registry-monitor`), not chosen in
 * isolation. Found by a real-code audit: with the previous values (5 attempts x 60s per-attempt
 * timeout), a SINGLE fetchWithRetry call whose every attempt genuinely hangs (a stalled
 * connection, not a slow-but-completing one) already cost 5 x 60,000ms = 300,000ms of attempt
 * time alone, before even adding the ~19.5s of inter-attempt backoff - i.e. one HEAD or GET call,
 * by itself, could exceed the actor's entire 300s run budget with no CSV downloaded or parsed yet.
 * That is worse than it sounds here because `processYear` awaits up to two such calls per year
 * (HEAD then GET) and `run()` awaits `processYear` for every selected year in sequence.
 *
 * With these tightened values (3 attempts x 30s per-attempt timeout):
 *   worst-case single call = 3 x 30,000ms (attempts) + backoffDelay(0)+backoffDelay(1) (2 gaps
 *                             before attempts 2 and 3, each up to base*2^n*1.3 - see backoffDelay)
 *                          <= 90,000ms + (1,300ms + 2,600ms) = 93,900ms (~94s, ~31% of the 300s budget)
 *   worst-case one year (HEAD then GET back-to-back, both maxed out) = ~187.8s (~63% of budget),
 *     leaving genuine margin for CSV parsing and row processing (both fast, local, in-memory work)
 *     even for the default single-year run.
 * 30s per attempt is still generous versus the "a few seconds" real transfer time this actor's
 * live verification measured for the largest real year file (~15MB) - this tightens the
 * pathological-hang tail, it does not touch the healthy-network case at all.
 */
const MAX_RETRY_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

function csvUrl(year: RegistryYear): string {
    return `${DOWNLOAD_BASE}/StatementSummaries${year}.csv`;
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function backoffDelay(attempt: number): number {
    const exponential = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
    const jitter = Math.random() * exponential * 0.3;
    return exponential + jitter;
}

/**
 * The real worst-case wall-clock duration of one `fetchWithRetry` call - every attempt timing out
 * and every backoff hitting its full jitter - computed from the actual constants above rather than
 * hand-copied, so it can never silently drift out of sync with them again (see REQUEST_TIMEOUT_MS's
 * comment for the fleet-wide recurrence this guards against). Exported so callers that fan out
 * across multiple such calls (routes.ts processes each registry year as one HEAD then, when
 * changed, one GET - and a single run can select several years) can size their own cumulative
 * per-run time-budget guard off the same real numbers instead of a second guessed constant.
 */
export const MAX_FETCH_WITH_RETRY_DURATION_MS = (() => {
    let total = 0;
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
        if (attempt > 0) total += Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS) * 1.3;
        total += REQUEST_TIMEOUT_MS;
    }
    return total;
})();

async function fetchWithRetry(url: string, method: 'HEAD' | 'GET'): Promise<Response> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
        if (attempt > 0) {
            const delay = backoffDelay(attempt - 1);
            log.info(`Retrying ${method} ${url} (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}) after ${Math.round(delay)}ms backoff...`);
            await sleep(delay);
        }
        const timeoutController = new AbortController();
        const timeoutHandle = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(url, { method, headers: { 'User-Agent': USER_AGENT }, signal: timeoutController.signal });
            if (response.ok) return response;
            if (response.status >= 500 || response.status === 429) {
                lastError = new Error(`${method} ${url} returned ${response.status}`);
                continue;
            }
            // A 4xx other than 429 (e.g. 404 for a year that doesn't exist yet) is not transient.
            return response;
        } catch (networkError) {
            lastError = networkError instanceof Error ? networkError : new Error(String(networkError));
        } finally {
            clearTimeout(timeoutHandle);
        }
    }
    throw lastError ?? new Error(`${method} ${url} failed with no further detail after retries.`);
}

/**
 * Cheap pre-check (ARCHITECTURE.md section 0): a HEAD request returns Azure Blob Storage's real
 * `content-md5` header without transferring the full 8-15 MB file body. Returns null if the year
 * doesn't exist yet (a real 404 - e.g. a future registry year with no file published yet) or the
 * header is genuinely absent, in which case the caller must fall back to a full download to be
 * safe rather than assume "unchanged".
 */
export async function fetchYearContentHash(year: RegistryYear): Promise<string | null> {
    const response = await fetchWithRetry(csvUrl(year), 'HEAD');
    if (!response.ok) {
        if (response.status === 404) {
            log.info(`Registry year ${year} has no published file yet (404) - skipping.`);
            return null;
        }
        throw new Error(`HEAD ${csvUrl(year)} returned ${response.status}`);
    }
    return response.headers.get('content-md5');
}

/**
 * Downloads and parses a full year's CSV. Uses `csv-parse` (RFC 4180-compliant), not a hand-split
 * on newlines - confirmed live during this build that several real columns (e.g.
 * `OrganisationSectors`, `Policies`) contain embedded newlines inside quoted fields, which a naive
 * `text.split('\n')` would corrupt (see ARCHITECTURE.md section 1).
 */
export async function fetchYearStatements(year: RegistryYear): Promise<RawStatementRow[]> {
    const response = await fetchWithRetry(csvUrl(year), 'GET');
    if (!response.ok) {
        throw new Error(`GET ${csvUrl(year)} returned ${response.status}`);
    }
    const text = await response.text();
    return parse(text, {
        columns: true,
        skip_empty_lines: true,
        relax_quotes: true,
        bom: true,
    }) as RawStatementRow[];
}
