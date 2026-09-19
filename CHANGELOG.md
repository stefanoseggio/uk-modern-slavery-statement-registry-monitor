# Changelog

## [1.0.1](https://github.com/stefanoseggio/uk-modern-slavery-statement-registry-monitor/compare/uk-modern-slavery-statement-registry-monitor-v1.0.0...uk-modern-slavery-statement-registry-monitor-v1.0.1) (2026-09-19)


### Bug Fixes

* **ci:** pass RELEASE_PLEASE_TOKEN so release PRs skip the bot-approval gate ([699305f](https://github.com/stefanoseggio/uk-modern-slavery-statement-registry-monitor/commit/699305f1dc5c6a22367c97fc2ee752e93d5ea656))
* **csvSource:** tighten retry timeout budget, add per-run time-budget guard ([#8](https://github.com/stefanoseggio/uk-modern-slavery-statement-registry-monitor/issues/8)) ([271aa22](https://github.com/stefanoseggio/uk-modern-slavery-statement-registry-monitor/commit/271aa2200c9e8b6e8877b45eba2ba4743ce62483))
* tighten CSV fetch retry/timeout so a single call fits the run timeout ([#7](https://github.com/stefanoseggio/uk-modern-slavery-statement-registry-monitor/issues/7)) ([ddb4128](https://github.com/stefanoseggio/uk-modern-slavery-statement-registry-monitor/commit/ddb41280c897a535166af730dedf1c5424536b32))

## 1.0.0 - 2026-09-17

### Added

- Published this actor to the Apify Store (`stefano_seggio/uk-modern-slavery-statement-registry-monitor`).

### Investigated

- The first billable run pushed 5 `STATEMENT_UPDATED` events instead of an all-free
  `BASELINE_SNAPSHOT` set. Ruled out a code defect, a state-persistence bug, and a
  Key-Value-Store-naming collision (the named store's `readCount: 0` and `createdAt` exactly
  matched run-start time, proving state was genuinely empty at the start of the run). The most
  parsimonious explanation consistent with all evidence is genuine duplicate rows for the same
  organisation/year within the source registry's own 10,401-row bulk CSV export, not a defect in
  this actor's delta engine. Financial exposure: 5 events, $0.05, one-time.
