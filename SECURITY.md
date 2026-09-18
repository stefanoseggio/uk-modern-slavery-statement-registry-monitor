# Security Policy

## Supported versions

This Actor follows [semantic versioning](https://semver.org/) via automated release tagging (see [`.github/workflows/release.yml`](.github/workflows/release.yml)). Only the latest published major version receives security fixes — there is no long-term-support branch for older majors, consistent with this being a single-maintainer, independently-operated Actor rather than an enterprise product with a formal support matrix.

## Reporting a vulnerability

**Preferred: GitHub Private Vulnerability Reporting.** This repository has private vulnerability reporting enabled — go to the **Security** tab → **Report a vulnerability** to open a private advisory visible only to the maintainer until a fix is ready. This is the correct channel for anything that shouldn't be disclosed in a public issue (credential handling, injection risks, dependency CVEs affecting this Actor's real usage, etc.).

**Do not** open a public GitHub issue for a suspected security vulnerability — use private reporting instead so the disclosure stays coordinated.

## What's actually in scope

This Actor's real attack surface, honestly assessed:

- **No credential handling of any kind.** This Actor calls no third-party API and requires no API key — the registry's bulk CSV exports are unauthenticated and open-licensed (Open Government Licence v3.0). There is no customer secret this Actor could leak.
- **No arbitrary-code or arbitrary-URL input surface**, with narrow exceptions for the user-supplied `webhookUrl` / `slackWebhookUrl` / `teamsWebhookUrl` fields, which are outbound-only notification destinations the operator configures for their own run, not attacker-controlled input. Input is otherwise a fixed JSON Schema (`.actor/input_schema.json`) enforced by the Apify platform before the Actor runs.
- **Untrusted CSV content.** Organisation-submitted fields (organisation name, statement URLs, addresses) come from the registry's own self-reported CSV rows and are treated as untrusted when rendered into Slack/Teams notifications — `test/notifier.test.ts` includes escaping tests confirming these fields can't inject Slack mrkdwn or Adaptive Card markdown.
- **Dependency vulnerabilities** in `package.json`'s real dependency tree (`apify`, `csv-parse`, and dev dependencies) are a real, ongoing concern — tracked via Dependabot (`.github/dependabot.yml`) and GitHub's own dependency/secret scanning, both enabled on this repository.
- **Source integrity** (a compromised or spoofed registry endpoint) is outside this Actor's control — it fetches from the registry's own official `modern-slavery-statement-registry.service.gov.uk` domain over HTTPS, with a `Content-MD5` integrity check per year, and does not implement independent content-signing verification beyond that and standard TLS.

## Response expectations

This is an independently developed and maintained Actor with no contractual security SLA. In practice, security reports are typically triaged within 48 hours, though there is no guaranteed fix timeline. Reports that turn out to be genuine, exploitable vulnerabilities will be credited in the fix's release notes unless the reporter requests otherwise.

## Enterprise / institutional customers

If your organization requires a signed security addendum, a formal disclosure SLA, or a security questionnaire completed as part of procurement, open an issue against this Actor's [Store page](https://apify.com/stefano_seggio/uk-modern-slavery-statement-registry-monitor) or connect via [LinkedIn](https://www.linkedin.com/in/stefanoseggio-deltaregistry) — these are handled case-by-case, not something this file can commit to on Stefano's behalf.
