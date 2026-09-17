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

const MAX_RETRY_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
/**
 * A GET on the largest real year file (~15MB) completed in a few seconds during this actor's live
 * verification; 60s is generous headroom, not a tight bound. Found by adversarial-security review:
 * without this, a request that hangs (a stalled connection, not just a slow one) would block
 * indefinitely with no way to abort, since fetch has no default timeout.
 */
const REQUEST_TIMEOUT_MS = 60_000;

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
