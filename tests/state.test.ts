import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadState, recordSeen, recordYearChecked, saveState, stateStoreName } from '../src/state.js';
import type { DeltaState } from '../src/types.js';

const stores = new Map<string, Map<string, unknown>>();

vi.mock('apify', () => ({
    Actor: {
        openKeyValueStore: vi.fn(async (name: string) => {
            if (!stores.has(name)) stores.set(name, new Map());
            const store = stores.get(name)!;
            return {
                getValue: vi.fn(async (key: string) => store.get(key) ?? null),
                setValue: vi.fn(async (key: string, value: unknown) => {
                    store.set(key, value);
                }),
            };
        }),
    },
}));

afterEach(() => {
    stores.clear();
    vi.clearAllMocks();
});

describe('stateStoreName', () => {
    it('scopes the KV store name by deltaStateName, matching the fleet-wide convention', () => {
        expect(stateStoreName('default')).toBe('UK-MSA-DELTA-STATE-default');
        expect(stateStoreName('my-schedule')).toBe('UK-MSA-DELTA-STATE-my-schedule');
    });
});

describe('loadState / saveState', () => {
    it('returns a fresh empty state when the KV store has nothing stored yet', async () => {
        const state = await loadState('fresh-store', false);
        expect(state).toEqual({ statements: {}, yearCache: {} });
    });

    it('round-trips a real state object through save then load', async () => {
        const original: DeltaState = {
            statements: { 'url::Acme Ltd': { statusFingerprint: 'a', contentFingerprint: 'b', lastSeen: '2026-01-01T00:00:00.000Z' } },
            yearCache: { '2026': { contentMd5: 'xyz==', lastChecked: '2026-01-01T00:00:00.000Z', baselineComplete: true } },
        };
        await saveState('round-trip-store', original);
        const loaded = await loadState('round-trip-store', false);
        expect(loaded).toEqual(original);
    });

    it('ignores whatever is stored and returns fresh empty state when resetState is true - even if a store already has real saved state', async () => {
        const existing: DeltaState = {
            statements: { x: { statusFingerprint: 'a', contentFingerprint: 'b', lastSeen: '2026-01-01T00:00:00.000Z' } },
            yearCache: {},
        };
        await saveState('reset-store', existing);

        const result = await loadState('reset-store', true);
        expect(result).toEqual({ statements: {}, yearCache: {} });
    });
});

describe('recordSeen / recordYearChecked (mutate-by-reference contract)', () => {
    it('recordSeen mutates the SAME state object passed in, not a copy - routes.ts relies on this to persist across processRow calls without re-assignment', () => {
        const state: DeltaState = { statements: {}, yearCache: {} };
        const stateRef = state;
        recordSeen(state, 'url::Acme Ltd', { statusFingerprint: 'a', contentFingerprint: 'b', lastSeen: '2026-01-01T00:00:00.000Z' });

        expect(stateRef).toBe(state); // same object identity
        expect(stateRef.statements['url::Acme Ltd']).toEqual({ statusFingerprint: 'a', contentFingerprint: 'b', lastSeen: '2026-01-01T00:00:00.000Z' });
    });

    it('recordYearChecked mutates the same state object and overwrites any prior entry for that year', () => {
        const state: DeltaState = { statements: {}, yearCache: { '2026': { contentMd5: 'old==', lastChecked: '2025-01-01T00:00:00.000Z', baselineComplete: false } } };
        recordYearChecked(state, '2026', { contentMd5: 'new==', lastChecked: '2026-01-01T00:00:00.000Z', baselineComplete: true });

        expect(state.yearCache['2026']).toEqual({ contentMd5: 'new==', lastChecked: '2026-01-01T00:00:00.000Z', baselineComplete: true });
    });

    it('recordSeen does not affect other statements or the yearCache', () => {
        const state: DeltaState = {
            statements: { existing: { statusFingerprint: 'x', contentFingerprint: 'y', lastSeen: '2025-01-01T00:00:00.000Z' } },
            yearCache: { '2026': { contentMd5: 'abc==', lastChecked: '2025-01-01T00:00:00.000Z', baselineComplete: true } },
        };
        recordSeen(state, 'new-record', { statusFingerprint: 'a', contentFingerprint: 'b', lastSeen: '2026-01-01T00:00:00.000Z' });

        expect(state.statements.existing).toEqual({ statusFingerprint: 'x', contentFingerprint: 'y', lastSeen: '2025-01-01T00:00:00.000Z' });
        expect(state.yearCache['2026']).toEqual({ contentMd5: 'abc==', lastChecked: '2025-01-01T00:00:00.000Z', baselineComplete: true });
    });
});
