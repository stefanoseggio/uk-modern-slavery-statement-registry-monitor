# Changelog

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
