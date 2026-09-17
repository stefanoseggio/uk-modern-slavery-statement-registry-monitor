import { log } from 'apify';

import type { OutputRecord } from './types.js';

/**
 * Registry fields (organisation name, sector, turnover, etc.) are self-reported free text by the
 * submitting organisation - not vetted by this actor, and not trusted input. Found by
 * adversarial-security review: interpolating them unescaped into Slack `mrkdwn` or a Teams
 * Adaptive Card's markdown-subset text lets a crafted field inject live formatting - e.g. Slack's
 * special-mention syntax (`<!channel>`, `<!here>`, `<!everyone>`) or a `<...|...>` link breakout.
 * Slack's own documented escaping rule for mrkdwn text: replace `&`, `<`, `>` (in that order, so
 * `&` doesn't double-escape the entities this introduces).
 */
function escapeSlackMrkdwn(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Adaptive Card TextBlock/FactSet text is a CommonMark-like markdown subset - backslash-escape characters that could start unintended markdown (links, emphasis, code spans). */
function escapeAdaptiveCardText(value: string): string {
    return value.replace(/[[\]()*_~`\\]/g, (char) => `\\${char}`);
}

/** A URL destined for a Slack `<url|text>` link - the `|` and `>` characters would otherwise break out of the link syntax. */
function sanitizeSlackLinkUrl(url: string): string {
    return url.replace(/[|<>]/g, encodeURIComponent);
}

function summaryLine(record: OutputRecord): string {
    const org = record.organisation_name ?? record.record_id;
    const missing = record.missing_disclosures.length > 0 ? `missing: ${record.missing_disclosures.join(', ')}` : 'fully compliant on the 6 recommended topics';
    return `[UK Modern Slavery Registry] ${record.event_type}: ${org} (${record.sector_type ?? 'unknown sector'}, ${record.statement_year}) - ${missing}`;
}

/** A single channel's send must never throw past this function - see notifyAllChannels. */
async function postJson(url: string, body: unknown, channelLabel: string): Promise<void> {
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            log.warning(`${channelLabel} notification failed with status ${response.status} - continuing (channel delivery is best-effort, not run-blocking).`);
        }
    } catch (error) {
        log.warning(`${channelLabel} notification threw an error - continuing: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function sendGenericWebhook(url: string, record: OutputRecord): Promise<void> {
    return postJson(url, { text: summaryLine(record), record }, 'Generic webhook');
}

/**
 * Slack Block Kit format - the current, documented, still-supported way to post a formatted
 * message via a Slack App's Incoming Webhooks feature (see ARCHITECTURE.md section 5: this is
 * distinct from, and NOT, the older pre-app "legacy custom integrations" webhook Slack is phasing
 * out - both happen to accept a similar top-level JSON shape, but this actor's README directs
 * users to create the webhook via the App-based path).
 */
async function sendSlackNotification(url: string, record: OutputRecord): Promise<void> {
    const missingText =
        record.missing_disclosures.length > 0 ? `:warning: Missing: ${escapeSlackMrkdwn(record.missing_disclosures.join(', '))}` : ':white_check_mark: Fully compliant on the 6 recommended topics';
    const orgName = escapeSlackMrkdwn(record.organisation_name ?? record.record_id);
    const sector = escapeSlackMrkdwn(record.sector_type ?? 'Unknown sector');
    const turnover = escapeSlackMrkdwn(record.turnover ?? 'turnover not disclosed');
    const linkText = record.statement_url ? `<${sanitizeSlackLinkUrl(record.statement_url)}|View statement>` : 'No statement URL published';
    const payload = {
        text: summaryLine(record),
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*${record.event_type}*: ${orgName}\n${sector} · ${record.statement_year} · ${turnover}`,
                },
            },
            {
                type: 'section',
                text: { type: 'mrkdwn', text: missingText },
            },
            {
                type: 'context',
                elements: [{ type: 'mrkdwn', text: linkText }],
            },
        ],
    };
    return postJson(url, payload, 'Slack');
}

/**
 * Microsoft Teams via a "Workflows" webhook URL, posting a standard Adaptive Card wrapped in a
 * message attachment - see ARCHITECTURE.md section 5 for why this targets Workflows rather than
 * the retired classic connector. Honest caveat, not silently omitted: a Power Automate flow's
 * exact expected trigger JSON schema is user-configurable per flow, so the precise body shape a
 * given user's flow accepts can vary - this is the standard, widely-documented Adaptive Card
 * envelope, not a schema independently confirmed against a specific live Teams workspace during
 * this build (no Teams tenant was available to test against). If a user's flow expects a
 * different shape, they may need to adjust their flow's trigger schema to match this payload.
 */
async function sendTeamsNotification(url: string, record: OutputRecord): Promise<void> {
    const missingText =
        record.missing_disclosures.length > 0 ? `⚠️ Missing: ${escapeAdaptiveCardText(record.missing_disclosures.join(', '))}` : '✅ Fully compliant on the 6 recommended topics';
    const orgName = escapeAdaptiveCardText(record.organisation_name ?? record.record_id);
    const sector = escapeAdaptiveCardText(record.sector_type ?? 'Unknown');
    const turnover = escapeAdaptiveCardText(record.turnover ?? 'Not disclosed');
    const payload = {
        type: 'message',
        attachments: [
            {
                contentType: 'application/vnd.microsoft.card.adaptive',
                content: {
                    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                    type: 'AdaptiveCard',
                    version: '1.4',
                    body: [
                        {
                            type: 'TextBlock',
                            text: `${record.event_type}: ${orgName}`,
                            weight: 'Bolder',
                            size: 'Medium',
                            wrap: true,
                        },
                        {
                            type: 'FactSet',
                            facts: [
                                { title: 'Sector', value: sector },
                                { title: 'Statement year', value: record.statement_year },
                                { title: 'Turnover', value: turnover },
                                { title: 'Compliance', value: missingText },
                            ],
                        },
                        ...(record.statement_url
                            ? [
                                  {
                                      type: 'ActionSet',
                                      actions: [{ type: 'Action.OpenUrl', title: 'View statement', url: record.statement_url }],
                                  },
                              ]
                            : []),
                    ],
                },
            },
        ],
    };
    return postJson(url, payload, 'Microsoft Teams');
}

export interface NotifierChannels {
    webhookUrl?: string;
    slackWebhookUrl?: string;
    teamsWebhookUrl?: string;
}

/**
 * Fires every configured channel in parallel. Each channel is independently failure-isolated
 * (postJson never throws), and this function itself never rejects - a run must never fail because
 * a notification channel is unreachable or misconfigured.
 */
export async function notifyAllChannels(channels: NotifierChannels, record: OutputRecord): Promise<void> {
    const sends: Promise<void>[] = [];
    if (channels.webhookUrl) sends.push(sendGenericWebhook(channels.webhookUrl, record));
    if (channels.slackWebhookUrl) sends.push(sendSlackNotification(channels.slackWebhookUrl, record));
    if (channels.teamsWebhookUrl) sends.push(sendTeamsNotification(channels.teamsWebhookUrl, record));
    await Promise.allSettled(sends);
}
