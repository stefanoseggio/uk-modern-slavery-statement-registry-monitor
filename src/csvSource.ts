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

const MAX_RETRY_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
/**
 * A GET on the largest real year file (~15MB) completed in a few seconds during this actor's live
 * verification, so 20s per attempt is still generous headroom, not a tight bound. Found by
 * adversarial-security review: without this, a request that hangs (a stalled connection, not just
 * a slow one) would block indefinitely with no way to abort, since fetch has no default timeout.
 *
 * Kept deliberately short (fleet-wide timeout-budget audit, 2026-09-19 recurrence): this actor's
 * own `defaultRunOptions.timeoutSecs` is 300s. A single `fetchWithRetry` call's real worst case is
 * MAX_RETRY_ATTEMPTS request timeouts plus the exponential-backoff (with up to 30% jitter) waited
 * between them:
 *   attempt 1:                                    20_000ms request
 *   attempt 2: +  1_000ms * 1.3 max backoff  +     20_000ms request
 *   attempt 3: +  2_000ms * 1.3 max backoff  +     20_000ms request
 *   attempt 4: +  4_000ms * 1.3 max backoff  +     20_000ms request
 *   = 4 * 20_000 + (1_300 + 2_600 + 5_200) = 80_000 + 9_100 = 89_100ms (~89s)
 * That comfortably fits under the 300s run timeout with real margin (~70%), even before
 * `fetchYearContentHash`'s HEAD and `fetchYearStatements`'s GET are each their own such call, and
 * `years` can select several independent years per run - see MAX_FETCH_WITH_RETRY_DURATION_MS and
 * the per-run cumulative time-budget guard in routes.ts, which exists precisely because per-call
 * margin alone doesn't bound a multi-year run.
 *
 * The previous values here (MAX_RETRY_ATTEMPTS=5, REQUEST_TIMEOUT_MS=60_000) gave a single call's
 * own worst case of ~319.5s - already exceeding the 300s run timeout on its own, before any
 * multi-year compounding. An earlier fleet-wide timeout-budget pass had covered other actors but
 * left this actor's numbers untightened; this is that recurrence being fixed for real.
 */
const REQUEST_TIMEOUT_MS = 20_000;

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
