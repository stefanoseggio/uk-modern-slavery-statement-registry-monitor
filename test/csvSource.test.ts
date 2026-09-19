import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchYearContentHash, fetchYearStatements } from '../src/csvSource.js';

function mockResponse(overrides: Partial<{ ok: boolean; status: number; headers: Record<string, string>; text: () => Promise<string> }> = {}) {
    const headerMap = new Map(Object.entries(overrides.headers ?? {}));
    return {
        ok: overrides.ok ?? true,
        status: overrides.status ?? 200,
        headers: { get: (key: string) => headerMap.get(key.toLowerCase()) ?? null },
        text: overrides.text ?? (async () => ''),
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

/**
 * Runs `work` while auto-advancing fake timers, so the real 1s-30s exponential backoff between
 * retries doesn't make this suite slow. A single large advance (well beyond the ~9.1s maximum
 * cumulative backoff across all 4 real retry attempts) flushes every pending sleep in order;
 * `advanceTimersByTimeAsync` also drains microtasks between timer callbacks, so this correctly
 * unblocks a `fetchWithRetry` call regardless of how many retries it actually performs.
 */
async function withFakeRetryTimers<T>(work: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    const resultPromise = work();
    // Suppress Node's "unhandled rejection" warning for the window between starting `work()` and
    // the caller attaching its own `.rejects`/`await` handling below - this inert catch doesn't
    // change what the caller observes, since `resultPromise` itself (not this branch) is returned.
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- deliberately a no-op, see comment above
    resultPromise.catch(() => {});
    await vi.advanceTimersByTimeAsync(120_000);
    return resultPromise;
}

describe('fetchYearContentHash', () => {
    it('returns the real content-md5 header value on a successful HEAD request', async () => {
        const fetchMock = vi.fn().mockResolvedValue(mockResponse({ headers: { 'content-md5': 'abc123==' } }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await fetchYearContentHash('2026');
        expect(result).toBe('abc123==');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toContain('StatementSummaries2026.csv');
        expect(options.method).toBe('HEAD');
    });

    it('returns null (not an error) on a real 404 - a not-yet-published year', async () => {
        const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 404 }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await fetchYearContentHash('2027');
        expect(result).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1); // a 404 is not retried
    });

    it('throws on a non-404, non-retryable client error', async () => {
        const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 403 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchYearContentHash('2026')).rejects.toThrow(/403/);
    });

    it('retries on a 5xx response and succeeds once the server recovers', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(mockResponse({ ok: false, status: 503 }))
            .mockResolvedValueOnce(mockResponse({ headers: { 'content-md5': 'recovered==' } }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await withFakeRetryTimers(async () => fetchYearContentHash('2026'));
        expect(result).toBe('recovered==');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries on a 429 (rate limited) response', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(mockResponse({ ok: false, status: 429 }))
            .mockResolvedValueOnce(mockResponse({ headers: { 'content-md5': 'ok-after-429==' } }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await withFakeRetryTimers(async () => fetchYearContentHash('2026'));
        expect(result).toBe('ok-after-429==');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries on a thrown network error and eventually succeeds', async () => {
        const fetchMock = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(mockResponse({ headers: { 'content-md5': 'ok==' } }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await withFakeRetryTimers(async () => fetchYearContentHash('2026'));
        expect(result).toBe('ok==');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('gives up and throws after exhausting all retry attempts against a persistent 500', async () => {
        const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 500 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(withFakeRetryTimers(async () => fetchYearContentHash('2026'))).rejects.toThrow(/500/);
        expect(fetchMock).toHaveBeenCalledTimes(4); // MAX_RETRY_ATTEMPTS
    });

    it('passes an AbortController signal so a hung request can be aborted (regression test for the "no timeout" gap found by adversarial-security review)', async () => {
        const fetchMock = vi.fn().mockResolvedValue(mockResponse({ headers: { 'content-md5': 'x==' } }));
        vi.stubGlobal('fetch', fetchMock);

        await fetchYearContentHash('2026');
        const [, options] = fetchMock.mock.calls[0];
        expect(options.signal).toBeInstanceOf(AbortSignal);
    });
});

describe('fetchYearStatements', () => {
    it('parses a real RFC 4180 CSV response, including embedded newlines inside quoted fields', async () => {
        const csv = [
            'StatementYear,OrganisationName,OrganisationSectors',
            '2026,Acme Ltd,"Construction, civil engineering and building products\r\nWholesale and retail trade"',
            '2026,Beta Ltd,Transportation and storage',
        ].join('\n');
        const fetchMock = vi.fn().mockResolvedValue(mockResponse({ text: async () => csv }));
        vi.stubGlobal('fetch', fetchMock);

        const rows = await fetchYearStatements('2026');
        expect(rows).toHaveLength(2);
        expect(rows[0].OrganisationName).toBe('Acme Ltd');
        expect(rows[0].OrganisationSectors).toBe('Construction, civil engineering and building products\r\nWholesale and retail trade');
        expect(rows[1].OrganisationName).toBe('Beta Ltd');
    });

    it('throws on a non-ok GET response', async () => {
        const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 500 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(withFakeRetryTimers(async () => fetchYearStatements('2026'))).rejects.toThrow(/500/);
    });
});
