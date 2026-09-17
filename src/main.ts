import { Actor, log } from 'apify';

import { run as runRegistry } from './routes.js';
import { loadState, saveState, stateStoreName } from './state.js';
import type { ActorInput } from './types.js';

await Actor.init();
await run();
await Actor.exit();

async function run(): Promise<void> {
    const input = (await Actor.getInput<ActorInput>()) ?? ({} as ActorInput);
    const years = input.years && input.years.length > 0 ? input.years : ['2026'];
    log.info(`Starting run: years=${years.join(',')}, deltaStateName=${input.deltaStateName ?? 'default'}, onlyNew=${input.onlyNew ?? true}.`);

    const storeName = stateStoreName(input.deltaStateName ?? 'default');
    const state = await loadState(storeName, input.resetState ?? false);

    // Apify's platform can send 'migrating' (worker reassignment - the SDK's default
    // `gracefulShutdown` then calls `Actor.reboot()`) or 'aborting' (the SDK then calls
    // `Actor.exit()`) at any point during a long run. Neither is a JS exception, so a bare
    // try/catch around the run would miss both - without flushing this run's in-memory `state`
    // (per-statement fingerprints and per-year content-hash cache) here, the SDK's default
    // reboot/exit would proceed without ever persisting it, and the next run would reload stale
    // state and RE-CHARGE every statement already pushed this run. This exact gap was found and
    // fixed in Actor #1 (TED) after the fact; this actor is built with the fix from the start.
    // The SDK awaits registered event handlers before actually rebooting/exiting.
    const flushState = async (): Promise<void> => {
        try {
            await saveState(storeName, state);
        } catch (error) {
            log.error(`Failed to flush state during shutdown: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    Actor.on('migrating', flushState);
    Actor.on('aborting', flushState);

    try {
        const stats = await runRegistry(input, state);
        const baselinedYears = Object.entries(state.yearCache)
            .filter(([, entry]) => entry.baselineComplete)
            .map(([year]) => year);
        log.info(
            `Run complete. Checked ${stats.yearsChecked} year(s), skipped ${stats.yearsSkippedUnchanged} unchanged. Pushed ${stats.totalPushed} record(s): ${Object.entries(stats.byEventType).map(([type, count]) => `${type}=${count}`).join(', ') || 'none'}. Baseline complete for: ${baselinedYears.join(', ') || 'none yet'}.`,
        );
    } catch (error) {
        log.error(`Run failed: ${error instanceof Error ? error.message : String(error)}`);
        // State is saved below regardless of success/failure, so progress already made this run
        // (fingerprints recorded, year content-hashes cached) is never lost to a later failure -
        // only the failing year's remaining rows are re-evaluated on the next run.
        await saveState(storeName, state);
        throw error;
    } finally {
        Actor.off('migrating', flushState);
        Actor.off('aborting', flushState);
    }

    await saveState(storeName, state);
}
