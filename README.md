# UK Modern Slavery Statement Registry — Delta Monitor

![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue) ![Tests](https://img.shields.io/badge/tests-77%20passing-brightgreen) ![Data source](https://img.shields.io/badge/data%20source-gov.uk%20official%20bulk%20export-003439) ![Pricing](https://img.shields.io/badge/pricing-pay--per--event-orange)

Delta-tracks the official UK Modern Slavery Statement Registry — 34,000+ organisations, 23,500+
statements (real, live figures as of this actor's build date) — for new statements,
compliance-status changes, and **missing mandatory disclosures** across the six government
recommended topics. Sourced from the registry's own official yearly bulk CSV exports under the
Open Government Licence v3.0. Part of [Delta Registry](https://github.com/stefanoseggio), a
pay-per-event regulatory/compliance data fleet.

## What this actor actually does that a one-shot export can't

The registry publishes a full CSV snapshot per year — anyone can download it. What this actor adds
is the same zero-cost delta-monitoring discipline as the rest of this fleet
([ARCHITECTURE.md](ARCHITECTURE.md)): **you are billed only for a statement that is new, or whose
compliance status genuinely changed** — never for re-confirming that nothing changed. And it goes
one level deeper than most delta actors: a real HTTP `Content-MD5` check on the registry's own
files means an **unchanged year is never even downloaded**, not just never re-billed.

Zero registry competitors exist for this exact niche on Apify Store today (confirmed via a live
Store API search on this actor's build date) — the closest real analogous product found is a
Brazil-focused ESG/forced-labour supply-chain monitor (`paulovitor18/brazil-esg-supply-chain-monitor`,
a different country and data source, but the same pay-per-event delta-pricing category), which
validates real market pricing for this kind of product: $0.06–$0.90 per event depending on tier.

## Quickstart

### cURL

```bash
curl "https://api.apify.com/v2/acts/stefano_seggio~uk-modern-slavery-statement-registry-monitor/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "years": ["2026"],
    "onlyMissingDisclosures": true,
    "maxItems": 100
  }'
```

### Python

```python
from apify_client import ApifyClient

client = ApifyClient("<YOUR_APIFY_TOKEN>")
run = client.actor("stefano_seggio/uk-modern-slavery-statement-registry-monitor").call(run_input={
    "years": ["2026"],
    "sectorFilter": ["Private"],
    "onlyMissingDisclosures": True,
    "maxItems": 100,
})

for item in client.dataset(run["defaultDatasetId"]).iterate_items():
    print(f"{item['event_type']}: {item['organisation_name']} - missing: {item['missing_disclosures']}")
```

### Node.js

```javascript
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

const run = await client.actor('stefano_seggio/uk-modern-slavery-statement-registry-monitor').call({
  years: ['2026'],
  sectorFilter: ['Private'],
  onlyMissingDisclosures: true,
  maxItems: 100,
});

const { items } = await client.dataset(run.defaultDatasetId).listItems();
items.forEach((item) => console.log(`${item.event_type}: ${item.organisation_name} - missing: ${item.missing_disclosures.join(', ')}`));
```

## Pricing (pay-per-event)

| Event | Price | When it fires |
|---|---|---|
| `new-statement` | $0.02 | A statement (organisation + registry year) never seen before appears, after this configuration's baseline is established. |
| `statement-updated` | $0.01 | A previously-seen statement's content fingerprint changed (any real field, not just compliance status). |
| `STATEMENT_UNCHANGED` / `BASELINE_SNAPSHOT` | **Never billed** | First-run baseline observations and confirmed-unchanged statements are always free — and an unchanged registry year is never even downloaded (see Architecture). |

*Pricing above is live — this actor is published on Apify Store, and these are the exact,
currently-active Pay-Per-Event prices configured in the Apify Console's monetization settings, not
a proposal. `apify-actor-start` is retained (the first 5 seconds of platform compute is waived on
every run) and `apify-default-dataset-item` is removed (no automatic per-write dataset charge), so
the "unchanged statements cost nothing" guarantee above is enforced at both the application layer
and the Console billing layer.*

## Input reference

See [`.actor/input_schema.json`](.actor/input_schema.json) for the full, authoritative schema.

| Field | Type | Default | Notes |
|---|---|---|---|
| `years` | array | `["2026"]` | Which of the real 2020–2027 registry years to check. Every run cheaply HEAD-checks every selected year; only changed years are actually downloaded. |
| `sectorFilter` | array | `[]` (both) | `Private` / `Public` — the two real self-declared values. |
| `turnoverFilter` | array | `[]` (all) | The five real turnover brackets, exact strings as published. |
| `onlyMissingDisclosures` | boolean | `false` | Deliver only statements with at least one of the six recommended topics uncovered - a genuine compliance gap. |
| `maxItems` | integer | 50 | This actor's own per-run push cap. |
| `deltaStateName` / `resetState` / `onlyNew` | — | fleet defaults | Same convention as the rest of this fleet. |
| `webhookUrl` | string | — | Generic JSON POST, no formatting. |
| `slackWebhookUrl` | string | — | See **Alerting** below. |
| `teamsWebhookUrl` | string | — | See **Alerting** below - real 2026 caveat, not the old connector. |

## Output record

```json
{
  "@type": "schema:Organization",
  "event_id": "a9e3df21...",
  "event_type": "NEW_STATEMENT",
  "record_id": "https://modern-slavery-statement-registry.service.gov.uk/statement-summary/nEQF3gnC/2027::ALUN GRIFFITHS (CONTRACTORS) LIMITED",
  "organisation_name": "ALUN GRIFFITHS (CONTRACTORS) LIMITED",
  "company_number": "01493003",
  "address": "Waterways House Merthyr Road, Llanfoist, Abergavenny, Monmouthshire, United Kingdom, NP7 9PE",
  "parent_name": null,
  "group_submission": false,
  "sector_type": "Private",
  "organisation_sectors": ["Construction, civil engineering and building products"],
  "turnover": "£100 million to £500 million",
  "statement_url": "https://griffiths.co.uk/wp-content/uploads/2026/05/Modern-Slavery-Human-Trafficking-Policy-2026.pdf",
  "statement_summary_url": "https://modern-slavery-statement-registry.service.gov.uk/statement-summary/nEQF3gnC/2027",
  "pdf_url": "https://downloads.modern-slavery-statement-registry.service.gov.uk/pdf-published/nEQF3gnC/2027/Modern Slavery and Human Trafficking Policy.pdf",
  "statement_year": "2027",
  "includes_org_structure": true,
  "includes_policies": false,
  "includes_risk_assessment": true,
  "includes_due_diligence": true,
  "includes_training": true,
  "includes_goals": false,
  "missing_disclosures": ["Policies", "Goals"],
  "is_fully_compliant": false,
  "ilo_indicators_in_statement": false,
  "status_fingerprint": "2387e5ba...",
  "content_fingerprint": "9d24b7ea...",
  "is_new": true,
  "scraped_at": "2026-09-16T23:10:17.817Z"
}
```

This is a real record from this actor's own live verification run against the actual 2027 registry
file — not a fabricated example.

`event_id` is a SHA-1 idempotency key over `(record_id, event_type, status_fingerprint,
content_fingerprint)` — a retried delivery of the same underlying event always reproduces the same
ID, safe for downstream deduplication.

**A note on `record_id`**: it is a compound key (`statementSummaryUrl::organisationName`), not the
bare registry URL. This was a real, live-discovered necessity, not a stylistic choice — a single
group modern slavery statement can legally cover several named organisations under one shared
`statement_summary_url` (confirmed live: one real 2027 group statement names four distinct
organisations sharing one URL). Using the URL alone would have collapsed those into one tracked
entity. See [ARCHITECTURE.md section 4](ARCHITECTURE.md#4-delta-engine--same-fingerprint-discipline-as-actor-1-applied-to-a-bulk-file-source).

## Alerting — Slack and Microsoft Teams, corrected against real 2026 platform status

Both channels fire on the same trigger: a brand-new statement, or an existing statement whose
compliance-relevant fields (the six recommended topics, ILO indicators) genuinely changed - not
merely whenever those fields happen to be populated.

### Slack

Create the webhook via a **Slack App** (Slack workspace → Apps → create/select an app → Features →
Incoming Webhooks → Add New Webhook to Workspace). This is Slack's own current, documented method.
Do **not** use the older "legacy custom integrations" webhook path - Slack is phasing that
specific mechanism out (existing legacy URLs still deliver today, but new setups should use the
App-based path). Paste the resulting URL into `slackWebhookUrl`.

### Microsoft Teams

**Important, and different from what you may expect**: Microsoft retired the classic Teams
"Incoming Webhook" connector - the mechanism most guides (and AI models with an older training
cutoff) still describe - in a **May 2026** cutover, after blocking new connector creation back in
August 2024. If you already have an old `outlook.office.com/webhook/...` URL, it no longer works.

The current, real mechanism: in a Teams channel, open **Workflows**, search for the **"When a
Teams webhook request is received"** template, and complete the setup - Power Automate gives you a
new webhook URL. Paste that into `teamsWebhookUrl`. This actor posts a standard **Adaptive Card**
(the modern Teams card format) wrapped in a message attachment. Honest caveat: a Power Automate
flow's exact expected trigger schema is user-configurable per flow, so if your flow's "Parse JSON"
step expects a different shape, adjust it to match this actor's payload (documented in
[`src/notifier.ts`](src/notifier.ts)) - this was not independently confirmed against a live Teams
tenant during this build, since none was available to test against.

## Architecture

Full spec in [ARCHITECTURE.md](ARCHITECTURE.md). Summary:

```
  Actor input ──▶ src/main.ts (migrating/aborting-safe state flush)
                        │
                        ▼
              src/routes.ts: for each selected registry year
                        │
                        ▼
         src/csvSource.ts: HEAD request → real Content-MD5
                        │
              ┌─────────┴─────────┐
              ▼                   ▼
      unchanged since        changed / never
      last run → SKIP        seen → GET + parse
      (no download at        (csv-parse, RFC 4180 -
       all)                   handles real embedded
                               newlines in quoted fields)
                        │
                        ▼
         src/deltaEngine.ts: normalize → canonicalize
         → SHA-256 → classify (NEW_STATEMENT /
         STATEMENT_UPDATED / STATEMENT_UNCHANGED /
         BASELINE_SNAPSHOT)
                        │
                        ▼
         src/state.ts: Key-Value Store persistence
         (per-statement fingerprints + per-year
          content-hash cache)
                        │
                        ▼
    Apify Dataset (pay-per-event push)
         + src/notifier.ts (webhook / Slack / Teams,
           each independently failure-isolated)
```

## Testing

```bash
npm test
```

77 real, passing Vitest tests across six files:

- [`tests/normalizer.test.ts`](tests/normalizer.test.ts) — CSV-row-to-statement mapping, including
  every real data-quality edge case found during this build (numeric `OrganisationName` fallback,
  stray quote characters, multi-line field joining, blank `CompanyNumber`, the compound-key
  shared-URL group-statement scenario, and the record-key fallback chain for blank identity
  fields).
- [`tests/deltaEngine.test.ts`](tests/deltaEngine.test.ts) — canonicalization determinism, SHA-256
  fingerprint stability and change-sensitivity, and the full classify/shouldDeliver state machine,
  including a regression test for the exact classify/onlyNew conflation bug found in Actor #1 and
  a regression test for the per-year `baselineComplete` scoping bug found by adversarial review in
  this actor.
- [`tests/notifier.test.ts`](tests/notifier.test.ts) — real payload-shape assertions for all three
  channels (mocked `fetch`, no live sends), failure-isolation tests confirming one channel's
  rejection never blocks another's delivery or throws out of the run, and escaping tests confirming
  registry-sourced (self-reported, untrusted) fields can't inject Slack mrkdwn or Adaptive Card
  markdown.
- [`tests/csvSource.test.ts`](tests/csvSource.test.ts) — the HTTP retry/backoff logic (5xx/429
  retried, other 4xx passed through immediately, network errors retried), the real 404-means-null
  distinction, RFC 4180 parsing of embedded newlines, and the request-timeout `AbortSignal`.
- [`tests/state.test.ts`](tests/state.test.ts) — Key-Value Store round-tripping, `resetState`
  behavior, and the mutate-by-reference contract `routes.ts` relies on.
- [`tests/routes.test.ts`](tests/routes.test.ts) — unit tests for the pure per-row/per-event logic
  (filters, event naming, high-value-change detection, output-record shaping) plus **integration
  tests that mock the CSV source and simulate a real API response mutation across sequential
  runs** to verify the delta trigger fires correctly - including regression tests for the
  maxItems-truncation caching bug and the filter/baseline-scoping bug, both found by this actor's
  own live testing and adversarial review.

## CI/CD

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml): every push and pull request runs
lint, type-check/build, and the full test suite; a push to `main` that passes all three then
authenticates with the Apify CLI (`apify login --token`) and deploys (`apify push`) using an
`APIFY_TOKEN` repository secret.

## What this actor deliberately does not do

- **No scraping, no anti-bot layer.** The registry's bulk CSV exports are official, licensed
  (Open Government Licence v3.0), and require no authentication - there's nothing to bypass.
- **No BLAKE3.** Same fleet-wide decision as Actor #1, for the same reason - see
  [ARCHITECTURE.md §4](ARCHITECTURE.md#4-delta-engine--same-fingerprint-discipline-as-actor-1-applied-to-a-bulk-file-source).
- **No classic Microsoft Teams connector support.** It's retired - see **Alerting** above.
- **No server-side filtering.** The registry's bulk export has no query mechanism; `sectorFilter`/
  `turnoverFilter`/`onlyMissingDisclosures` are applied client-side after parsing, so they narrow
  what's delivered, not what's downloaded.

---

This actor is part of **Delta Registry** — pay-per-event regulatory & compliance data
infrastructure built and operated by Stefano Seggio. For the rest of the fleet, see
[github.com/stefanoseggio](https://github.com/stefanoseggio).
