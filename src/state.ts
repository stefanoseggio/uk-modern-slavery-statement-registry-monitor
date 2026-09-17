import { Actor } from 'apify';

import type { DeltaState, StoredFingerprint, YearCacheEntry } from './types.js';

/** Mirrors the fleet's `deltaStateName` convention: scope the KV store name per schedule/query. */
export function stateStoreName(deltaStateName: string): string {
    return `UK-MSA-DELTA-STATE-${deltaStateName}`;
}

const STATE_KEY = 'STATE';

function emptyState(): DeltaState {
    return { statements: {}, yearCache: {} };
}

export async function loadState(storeName: string, resetState: boolean): Promise<DeltaState> {
    if (resetState) {
        return emptyState();
    }
    const store = await Actor.openKeyValueStore(storeName);
    const stored = await store.getValue<DeltaState>(STATE_KEY);
    return stored ?? emptyState();
}

export async function saveState(storeName: string, state: DeltaState): Promise<void> {
    const store = await Actor.openKeyValueStore(storeName);
    await store.setValue(STATE_KEY, state);
}

export function recordSeen(state: DeltaState, recordId: string, fingerprint: StoredFingerprint): void {
    // `state` is an explicit mutable accumulator passed in by design, mirroring the same pattern
    // already used across this fleet's other delta-tracking actors.
    // eslint-disable-next-line no-param-reassign
    state.statements[recordId] = fingerprint;
}

export function recordYearChecked(state: DeltaState, year: string, entry: YearCacheEntry): void {
    // eslint-disable-next-line no-param-reassign
    state.yearCache[year] = entry;
}
