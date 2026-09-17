# AGENTS.md - UK Modern Slavery Statement Registry Monitor

Technical notes for whoever (human or AI) touches this actor next.

## Delta Engine v2 — UK Modern Slavery Statement Registry Monitor

Status: authored 2026-09-16, applying the same reference architecture established in
`infrastructure/flagship_ted_eu_procurement_actor/ARCHITECTURE.md` to a genuinely different real
data-access mechanism. Every claim below was verified against the live registry, not assumed from
the mandate's framing.

## 0. The extraction architecture, verified live — this is not TED's shape

The mandate asked to evaluate "Official API vs. structured endpoints." The real answer, confirmed
directly: **there is no API.** The UK Modern Slavery Statement Registry
(`modern-slavery-statement-registry.service.gov.uk`) publishes one full CSV snapshot per
registry year (2020–2027, eight files, confirmed live), hosted on a separate downloads subdomain
backed by Azure Blob Storage:

```
https://downloads.modern-slavery-statement-registry.service.gov.uk/publicdownloads/StatementSummaries{YEAR}.csv
```

Confirmed real and licensed for reuse under the **Open Government Licence v3.0** (Crown
copyright, per the registry's own footer) — no authentication, no rate limit encountered, updated
daily (the registry's own `/data-about-modern-slavery-statement-registry` page states "updated
daily... last updated at midnight today," and a live `HEAD` request against the 2020 file — the
*oldest* year — returned a `Last-Modified` timestamp from *today*, confirming the whole dataset,
not just the current year, is regenerated nightly).

### A real, verified efficiency mechanism this actor exploits

A live `HEAD` request against these files returns real Azure Blob headers:

```
content-length: 8493928
content-md5: iuO5kx4zUWSM+UeEF/lHxw==
etag: 0x8DF14463C595AF5
last-modified: Wed, 16 Sep 2026 23:00:00 GMT
```

**`Last-Modified` is not a reliable "did the content change" signal** — since the entire dataset
regenerates nightly regardless of whether any individual year's *content* actually changed, a
year's `Last-Modified` can advance daily even when nothing in it did. `Content-MD5`, a real hash
of the actual blob bytes, is the correct signal, and this actor uses it: before downloading and
parsing a ~5–15 MB CSV, it issues a cheap `HEAD` request and compares the returned `Content-MD5`
against the value stored from the previous run for that year. **Unchanged years are never
downloaded, never parsed, and never diffed** — a stronger zero-cost guarantee than Actor #1's
(TED), which still had to make a real search call every run; here, a genuinely unchanged year
costs one small `HEAD` request and nothing else.

### Why this is not a scraping/anti-bot problem either

Same conclusion as Actor #1, for the same reason: this is an official, licensed, government bulk
file with no bot-detection layer to bypass. No stealth/fingerprint-impersonation layer is built
here either.

## 1. A real CSV parsing hazard, found by actually parsing the live file

A naive `text.split('\n')` on this CSV is **unsafe and was proven wrong** during this session's
own live verification: several real columns (`OrganisationSectors`, `Policies`, `Training`,
`WorkingConditionsEngagement`, `Address`, and others) contain **embedded newlines inside quoted
CSV fields** (RFC 4180 quoting), so a naive line-split fractures a single logical row across
multiple "lines." This actor uses `csv-parse` (a maintained, standard RFC 4180-compliant parser),
not a hand-rolled splitter, specifically because this failure mode was reproduced live during this
build, not hypothesized. One correction made by adversarial review: this actor uses `csv-parse`'s
**synchronous, whole-buffer** API (`csv-parse/sync`), not a streaming one - `fetchYearStatements()`
in `src/csvSource.ts` calls `response.text()` first, fully buffering a year's ~8-15 MB file into
memory as a string before parsing it in one pass. This is a deliberate, acceptable tradeoff at this
actor's real file sizes, not an oversight, but it is not "streaming" and should not be described as
such.

## 2. Real data-quality findings that shaped the normalizer

Verified by parsing a full live year-file (2026, 10,401 real rows) end-to-end, not sampled from
documentation:

- **`OrganisationName` is not always a name.** In 10 of 10,401 real 2026 rows (~0.1%), this field
  holds a bare numeric string (an internal reference number) while the real organisation name sits
  in `ParentName` instead. This is **not** correlated with `GroupSubmission` as might be assumed
  (8,844 of 10,401 rows are group submissions, and all but these same 10 have a normal
  `OrganisationName`) — it's a standalone data-quality artifact of the source, not a structural
  rule. The normalizer treats this as an edge case to tolerate, not a pattern to build logic
  around: `displayName` prefers `OrganisationName`, falling back to `ParentName` only when
  `OrganisationName` is empty or purely numeric.
- **Some name values carry stray literal quote characters** (e.g. a real row's `OrganisationName`
  parses to the literal string `"Edelweiss Air Ltd."` — quotes included as data, not as CSV
  syntax) — stripped for display cleanliness.
- **Multi-line fields need real normalization for tabular/dataset output.** `Address` and
  `OrganisationSectors` (among others) are genuinely multi-value/multi-line in the source
  (`\r\n`-joined). The normalizer joins these into a single readable string (`, `-joined) for the
  dataset's flat output rather than leaving embedded control characters in exported data.
- **`CompanyNumber` is frequently blank** (confirmed: only 1,862 of a 2,000-row sample had one) —
  it's a real, useful cross-reference to UK Companies House when present, but must never be
  assumed present.

## 3. Data model — real columns mapped to the mandate's requested categories

| Mandate category | Real CSV column(s) used |
|---|---|
| Organization details | `OrganisationName`, `CompanyNumber`, `Address`, `ParentName`, `GroupSubmission` |
| Sector | `SectorType` (real values: `Private`/`Public`), `OrganisationSectors` |
| Turnover brackets | `Turnover` (real observed values: `Under £36 million`, `£36 million to £60 million`, `£60 million to £100 million`, `£100 million to £500 million`, `Over £500 million`) |
| Statement URLs | `StatementURL` (the organisation's own hosted copy), `StatementSummaryURL` (the registry's own per-statement page — part of, but not the whole of, this actor's record key; see §4), `PDFURL` (registry-hosted PDF copy) |
| Compliance status / missing mandatory disclosures | The six real "recommended topics" columns: `StatementIncludesOrgStructure`, `StatementIncludesPolicies`, `StatementIncludesRisksAssessment`, `StatementIncludesDueDiligence`, `StatementIncludesTraining`, `StatementIncludesGoals` (each real value is `Yes` or empty — empty means not covered, i.e. a missing disclosure), plus `ILOIndicatorsInStatement` |
| Historical delta tracking | `StatementYear`, `StatementStartDate`, `StatementEndDate`, `DateApproved`, `LastUpdated`, `PDFDate` |

## 4. Delta engine — same fingerprint discipline as Actor #1, applied to a bulk-file source

- **Unique record key**: `buildRecordId()` in `src/deltaEngine.ts` builds
  `${StatementSummaryURL}::${orgKeyPart}` — a compound key, not `StatementSummaryURL` alone. This
  was a real correction made mid-build, found by live-testing this exact actor against the 2027
  file: `StatementSummaryURL` identifies a *statement document*, not an *organisation*, and a real
  group statement can name several distinct organisations under one shared URL (a live example
  found in the 2027 file: "CONCERT LIVING LIMITED", "KEY UNLOCKING FUTURES LIMITED", "PROGRESS
  HOUSING ASSOCIATION LIMITED", and "Progress Housing Group" are four different real organisations
  sharing one `StatementSummaryURL`). Using the URL alone as the state key would have silently
  collapsed these onto a single tracked entity - the second organisation's row would misclassify
  against the first's stored fingerprint, and only the last-seen organisation's data would survive
  in state. The compound key was verified live to correctly track all organisations named under a
  shared statement URL as independent entities.

  `orgKeyPart`'s real fallback chain, found incomplete by adversarial review and since corrected:
  raw `OrganisationName` → raw `ParentName` → `CompanyNumber` → (only if all three are blank) a
  combination of `DateApproved`/`StatementStartDate`/`StatementEndDate`/`Address`/`Turnover`. The
  first version of this fallback ended in a single static literal (`'unknown-organisation'`),
  which reintroduced the exact same collision class the compound key was built to prevent, just
  for the rare case of two rows sharing a URL that ALSO both have blank
  OrganisationName/ParentName/CompanyNumber - folding in several more real fields makes that
  collision require all of them to also match, which is far less likely for two genuinely
  different organisations. Note this fallback chain is deliberately different from
  `resolveDisplayName()`'s (used for the *display* `organisationName` field only): display
  additionally treats a bare-numeric `OrganisationName` as absent and falls back to `ParentName`,
  while the record-key fallback does not - so for a bare-numeric `OrganisationName`, the displayed
  name and the tracking key can legitimately diverge (documented explicitly, not an inconsistency
  to "fix", since using the numeric value for the key is actually safer for uniqueness than
  resolving multiple distinct numeric-ID rows onto a possibly-shared `ParentName`).
- **Content fingerprint**: SHA-256 (same fleet-wide decision as Actor #1's ARCHITECTURE.md §1.1 —
  BLAKE3 evaluated and rejected there for the same reasons, which apply identically here: this
  actor's runtime is I/O-bound on an 8–15 MB CSV download, not hash-bound, so BLAKE3's speed
  advantage is unrealized while its native/WASM bindings remain a real Docker build-fragility
  risk) over the normalized record, via recursive key-sort canonicalization - **with two fields
  excluded**: `recordId` (the state key itself, derived from other fields - contributes nothing
  new to hash) and `statementSummaryUrl` (stable in practice for a given `recordId`, since
  `recordId` textually embeds it). "Full normalized record" would be an overstatement; see
  `hashableFields()` in `src/deltaEngine.ts` for the exact exclusion.
- **Status fingerprint**: a narrower SHA-256 over just the six compliance-topic booleans plus
  `ILOIndicatorsInStatement` — the fields a compliance/procurement-BD buyer actually escalates on
  — used to gate notifications so a cosmetic change (e.g. a corrected approving-person name)
  doesn't fire an alert that a genuine compliance-status change should.
- **Event types**: `NEW_STATEMENT`, `STATEMENT_UPDATED`, `STATEMENT_UNCHANGED`,
  `BASELINE_SNAPSHOT` — directly mirroring Actor #1's `NEW_NOTICE`/`NOTICE_UPDATED`/
  `NOTICE_UNCHANGED`/`BASELINE_SNAPSHOT` naming for fleet-wide consistency.
- **Zero-cost no-change guarantee, two layers deep**: (1) an unchanged year's file is never even
  downloaded (§0), and (2) within a changed year's file, an individual statement whose content
  fingerprint hasn't moved is never pushed or charged.

## 5. Multi-channel alerting — corrected against real 2026 platform status

The mandate asked for "Slack Incoming Webhooks and Microsoft Teams Connectors." Both were checked
against their real, current 2026 status rather than built as remembered/assumed:

- **Slack**: incoming webhooks created through a **Slack App** remain current, documented, and
  Slack's own recommended way to post from an external system. What's actually deprecated is the
  older, pre-app "legacy custom integrations" mechanism — a different, older webhook-creation
  path. This actor's README documents the App-based path explicitly so a user doesn't set up the
  legacy version that Slack itself is phasing out.
- **Microsoft Teams**: the classic "Incoming Webhook" **connector** — the exact mechanism the
  mandate names — is **already retired as of this actor's build date.** Microsoft blocked new
  connector creation from August 2024, set a webhook-URL migration deadline of March 31, 2026, and
  fully disabled Office 365 connectors in Teams during a **May 18–22, 2026** cutover window — a
  date that has already passed as of today (2026-09-16). Building support for the old
  `outlook.office.com/webhook/...` connector URL format would ship dead functionality: any user
  who followed the mandate's literal wording to "create a Teams Connector" today would find
  Microsoft's own UI no longer offers it. This actor instead targets the real, current replacement
  — a **Power Automate Workflows** webhook URL (Teams' own in-app "Workflows" webhook template),
  posting an **Adaptive Card** payload (the modern, actively-supported Teams card format, as
  opposed to the older MessageCard format tied to the retiring connector). This substitution is
  disclosed explicitly in the README, not silently made.
- Both channels, plus a fully generic `webhookUrl` (raw JSON POST, no assumed shape), are
  independently optional and failure-isolated from each other — one channel's failure never blocks
  another's delivery or fails the run, matching this fleet's existing "webhook delivery is
  best-effort, not run-blocking" convention (`webhookNotifier.ts` in Actor #1).

## 6. Why there's no "INCREMENTAL vs BACKFILL" split like Actor #1

TED's API made that split meaningful (bounded vs. unbounded server-side pagination). Here, each
year is always a complete snapshot fetched in one shot — there's no pagination to split across
modes. The actor's real operational axis instead is **which years to check** (`years` input,
multi-select across the real 2020–2027 range) — every run re-checks every selected year's
`Content-MD5` cheaply, and only fully processes the years that actually changed. A first run
against a newly-added year is naturally a `BASELINE_SNAPSHOT` pass (per §4); there is no separate
"BACKFILL mode" to design since there's no scroll/pagination state to manage across runs the way
TED's `ITERATION` mode required.
