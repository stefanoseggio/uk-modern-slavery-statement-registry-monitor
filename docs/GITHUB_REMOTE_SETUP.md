# GitHub Remote & CI Setup

**Current state, as of 2026-09-17:** this repository already exists on GitHub, public, with its
full commit history pushed — [github.com/stefanoseggio/uk-modern-slavery-statement-registry-monitor](https://github.com/stefanoseggio/uk-modern-slavery-statement-registry-monitor).
This document now records what was done and how CI/deployment actually work here, matching the
real, established convention already used across this developer's other 24+ Delta Registry actor
repositories (verified directly against `stefanoseggio/uk-hse-enforcement-monitor` via the GitHub
API) — it is not a step-by-step "create this" guide anymore, since that step is already done.

## How CI actually works here (and how it differs from an earlier draft of this repo)

`.github/workflows/test.yaml` runs `npm ci && npm run lint && npm run build && npm test` on every
push and pull request. It does **not** deploy anything. This repository's CI briefly had a
different `deploy.yml` workflow that authenticated with `apify login --token` and ran `apify push`
automatically on every push to `main` — that was removed and replaced with `test.yaml` specifically
to match the real, established pattern this developer already uses across the rest of the
portfolio: **CI exists as a public quality signal (a green checkmark anyone browsing the repo can
see), not as a deploy pipeline.** Confirmed directly: `uk-hse-enforcement-monitor`'s live Apify
Actor source type is `SOURCE_FILES`, not Git-linked — its maintainer deploys manually.

## How to actually deploy this actor to Apify

```bash
apify login --token <your token>   # only needed once per machine
apify push
```

Run this from the repository root whenever you want to publish a new build to Apify. This is a
deliberate, manual step — nothing in GitHub triggers it automatically. This matches how every
build referenced in this repo's `.actor/audit_manifest.json` was actually deployed this session.

## About the `APIFY_TOKEN` GitHub Actions secret

A secret named `APIFY_TOKEN` was briefly set on this GitHub repository, back when it had an
auto-deploy workflow. `test.yaml` never referenced `secrets.APIFY_TOKEN`, so it served no purpose
even while it existed. **It has since been removed** (confirmed via `gh secret list` against this
repository, which returns no secrets) — no cleanup action is needed here.

## Setting up a fresh clone on a new machine

```bash
git clone https://github.com/stefanoseggio/uk-modern-slavery-statement-registry-monitor.git
cd uk-modern-slavery-statement-registry-monitor
npm ci
npm run lint && npm run build && npm test   # matches what CI runs on every push/PR
```

To deploy from that fresh clone, see "How to actually deploy this actor to Apify" above — you'll
need your own Apify API token from [console.apify.com/settings/integrations](https://console.apify.com/settings/integrations).

## The one-time setup script (`docs/setup_github_remote.sh`)

This script automated the original repo-creation step (`gh repo create`, initial push, and setting
the now-unused `APIFY_TOKEN` secret). It has already been run for this repository and does not need
to be run again — it's kept in this repo only as a reference for how the initial GitHub setup was
done, and as a reusable template if this actor's GitHub repo is ever recreated from scratch (e.g.
after a deliberate deletion). Since deployment is manual (see above), a future run of this script
could reasonably skip the `APIFY_TOKEN` step entirely rather than repeat now-obsolete config.
