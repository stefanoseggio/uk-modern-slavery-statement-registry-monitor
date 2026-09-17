# Go-to-market & Apify Store SEO — UK Modern Slavery Statement Registry Monitor

## The same honest correction as Actor #1

Apify Store ranking is percentile-based against the entire marketplace and explicitly weights
real usage ("popularity"), not just title/description keyword match (confirmed directly from
Apify's own Quality Score dashboard text, documented in this session's earlier fleet-wide audit).
Metadata below maximizes discoverability at every stage of this actor's adoption curve - it cannot
manufacture a top rank for a zero-review actor on day one.

## Real Store metadata

**Title** (set in [`.actor/actor.json`](.actor/actor.json)):
> UK Modern Slavery Statement Registry - Delta Monitor

**Description** (also set in `.actor/actor.json`):
> Delta-tracks the official UK Modern Slavery Statement Registry (gov.uk) - 34,000+ organisations,
> 23,500+ statements - for new statements, compliance-status changes, and missing mandatory
> disclosures (the six recommended topics: organisational structure, policies, risk assessment,
> due diligence, training, goals). Sourced from the registry's own official yearly bulk CSV
> downloads under the Open Government Licence. Pay-per-event: billed only for what changed.

**Category**: `BUSINESS` (Apify's real, single-select category field, already set).

## Real target-term mapping

| Target term / intent | How this listing addresses it |
|---|---|
| "UK Modern Slavery Statement Registry" / "Modern Slavery Act compliance" | Verbatim in title/description - the exact real registry name, not a paraphrase |
| "Modern slavery statement monitoring" / "compliance monitoring" | "Delta-tracks... for new statements, compliance-status changes" |
| "Supplier due diligence" / "CSDDD" / "ESG screening" | Real, adjacent buyer-intent terms this actor genuinely serves (a compliance/procurement-BD team screening counterparties) - not keyword-stuffed, since the actor's own `onlyMissingDisclosures` filter and per-organisation compliance tracking directly deliver on this intent |
| "Six recommended topics" / "mandatory disclosures" | Verbatim - the registry's own real terminology, confirmed from its public statistics page |

## Real competitive landscape (verified live via the Apify Store API on this actor's build date)

A direct search for `"modern slavery"` on Apify's own public Store API
(`api.apify.com/v2/store?search=modern%20slavery`) returned **zero results**. A broader search for
`"slavery"` returned exactly **one** real, adjacent actor:

| Actor | Coverage | Pricing (real, live) | Relevance |
|---|---|---|---|
| `paulovitor18/brazil-esg-supply-chain-monitor` | Brazil's government "Dirty List" (forced/slave labor) + IBAMA environmental infractions, by CNPJ | $0.20/monitor run, $0.06/CNPJ screened, $0.90/risk-change-detected | Same product category (ESG/forced-labour delta-monitoring, pay-per-event) but a **different country and data source** - not a direct competitor, but real, live evidence the category and pricing model both work: its "risk change detected" tier at $0.90 is priced well above this actor's proposed $0.02/$0.01, suggesting real headroom in this actor's launch pricing if usage validates a premium tier later. |

**This is a genuinely open niche on Apify Store today** - not because no one has thought of it, but
because (per this session's own earlier market-intelligence research) the UK Modern Slavery
Statement Registry is a comparatively under-served compliance-data category relative to saturated
ones like UK Companies House or Brazil's CNPJ registry, both of which have 18-87 real competing
actors already.

## What actually moves ranking over time

Same as Actor #1: early real usage and reviews compound faster than any further metadata
iteration. The Reddit organic-engagement channel already established this session
(`distribution/reddit_organic_engagement_plan.md`) is the same rule-compliant venue this actor
should be introduced through once published, not a separate initiative.
