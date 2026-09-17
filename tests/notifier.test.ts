import { afterEach, describe, expect, it, vi } from 'vitest';

import { notifyAllChannels } from '../src/notifier.js';
import type { OutputRecord } from '../src/types.js';

function sampleRecord(overrides: Partial<OutputRecord> = {}): OutputRecord {
    return {
        '@type': 'schema:Organization',
        event_id: 'abc123',
        event_type: 'NEW_STATEMENT',
        record_id: 'https://modern-slavery-statement-registry.service.gov.uk/statement-summary/ABC12345/2026::Acme Logistics Ltd',
        organisation_name: 'Acme Logistics Ltd',
        company_number: '01234567',
        address: '1 High Street, London',
        parent_name: null,
        group_submission: false,
        sector_type: 'Private',
        organisation_sectors: ['Transportation and storage'],
        turnover: '£36 million to £60 million',
        statement_url: 'https://acme-logistics.example/modern-slavery-statement',
        statement_summary_url: 'https://modern-slavery-statement-registry.service.gov.uk/statement-summary/ABC12345/2026',
        pdf_url: 'https://downloads.modern-slavery-statement-registry.service.gov.uk/pdf-published/ABC12345/2026/statement.pdf',
        statement_year: '2026',
        statement_start_date: '01/01/2025',
        statement_end_date: '31/12/2025',
        date_approved: '15/05/2026',
        last_updated: '01/06/2026',
        pdf_date: '2026-05-15T10:00:00',
        includes_org_structure: true,
        includes_policies: true,
        includes_risk_assessment: true,
        includes_due_diligence: true,
        includes_training: true,
        includes_goals: false,
        missing_disclosures: ['Goals'],
        is_fully_compliant: false,
        ilo_indicators_in_statement: false,
        status_fingerprint: 'status-fp',
        content_fingerprint: 'content-fp',
        is_new: true,
        scraped_at: '2026-09-16T12:00:00.000Z',
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('notifyAllChannels', () => {
    it('sends nothing when no channels are configured', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({}, sampleRecord());
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('posts a generic JSON payload with a text summary and the full record when webhookUrl is set', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({ webhookUrl: 'https://example.com/hook' }, sampleRecord());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('https://example.com/hook');
        const body = JSON.parse(options.body);
        expect(body.record.organisation_name).toBe('Acme Logistics Ltd');
        expect(typeof body.text).toBe('string');
        expect(body.text).toContain('NEW_STATEMENT');
    });

    it('posts a Slack Block Kit payload with blocks and a mrkdwn summary when slackWebhookUrl is set', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({ slackWebhookUrl: 'https://hooks.slack.example/services/T000/B000/xxx' }, sampleRecord());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.blocks).toHaveLength(3);
        expect(body.blocks[0].type).toBe('section');
        expect(body.blocks[0].text.type).toBe('mrkdwn');
        expect(body.blocks[0].text.text).toContain('Acme Logistics Ltd');
        // The actual compliance signal - the reason this channel exists - lives in block[1], not block[0].
        expect(body.blocks[1].text.text).toBe(':warning: Missing: Goals');
        // block[2] carries the statement URL as a Slack link.
        expect(body.blocks[2].elements[0].text).toBe('<https://acme-logistics.example/modern-slavery-statement|View statement>');
    });

    it('renders the Slack "fully compliant" branch when missing_disclosures is empty', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({ slackWebhookUrl: 'https://hooks.slack.example/services/T000/B000/xxx' }, sampleRecord({ missing_disclosures: [], is_fully_compliant: true }));

        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.blocks[1].text.text).toBe(':white_check_mark: Fully compliant on the 6 recommended topics');
    });

    it('escapes Slack mrkdwn special characters and Slack-mention syntax in registry-sourced fields (self-reported, untrusted data)', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels(
            { slackWebhookUrl: 'https://hooks.slack.example/services/T000/B000/xxx' },
            sampleRecord({ organisation_name: '<!channel> & Sons <script>' }),
        );

        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.blocks[0].text.text).not.toContain('<!channel>');
        expect(body.blocks[0].text.text).toContain('&lt;!channel&gt; &amp; Sons &lt;script&gt;');
    });

    it('posts a Teams Adaptive Card payload wrapped in a message attachment when teamsWebhookUrl is set', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels({ teamsWebhookUrl: 'https://prod-00.westeurope.logic.azure.com/workflows/xxx' }, sampleRecord());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.type).toBe('message');
        expect(body.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
        expect(body.attachments[0].content.type).toBe('AdaptiveCard');
        const factSet = body.attachments[0].content.body.find((el: { type: string }) => el.type === 'FactSet');
        expect(factSet.facts.some((f: { title: string; value: string }) => f.title === 'Sector' && f.value === 'Private')).toBe(true);
        expect(factSet.facts.find((f: { title: string }) => f.title === 'Compliance').value).toBe('⚠️ Missing: Goals');
        const actionSet = body.attachments[0].content.body.find((el: { type: string }) => el.type === 'ActionSet');
        expect(actionSet.actions[0]).toEqual({ type: 'Action.OpenUrl', title: 'View statement', url: 'https://acme-logistics.example/modern-slavery-statement' });
    });

    it('renders the Teams "fully compliant" branch and omits the ActionSet when statement_url is null', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels(
            { teamsWebhookUrl: 'https://prod-00.westeurope.logic.azure.com/workflows/xxx' },
            sampleRecord({ missing_disclosures: [], is_fully_compliant: true, statement_url: null }),
        );

        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        const factSet = body.attachments[0].content.body.find((el: { type: string }) => el.type === 'FactSet');
        expect(factSet.facts.find((f: { title: string }) => f.title === 'Compliance').value).toBe('✅ Fully compliant on the 6 recommended topics');
        expect(body.attachments[0].content.body.some((el: { type: string }) => el.type === 'ActionSet')).toBe(false);
    });

    it('escapes Adaptive Card markdown special characters in registry-sourced fields', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels(
            { teamsWebhookUrl: 'https://prod-00.westeurope.logic.azure.com/workflows/xxx' },
            sampleRecord({ organisation_name: '[Click here](https://evil.example) *bold*' }),
        );

        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        const textBlock = body.attachments[0].content.body[0];
        expect(textBlock.text).not.toContain('[Click here](https://evil.example)');
        expect(textBlock.text).toContain('\\[Click here\\]\\(https://evil.example\\) \\*bold\\*');
    });

    it('fires all three channels in parallel when all are configured', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        await notifyAllChannels(
            { webhookUrl: 'https://a.example/hook', slackWebhookUrl: 'https://b.example/hook', teamsWebhookUrl: 'https://c.example/hook' },
            sampleRecord(),
        );
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('isolates a failing channel - one rejected fetch does not stop the others or throw out of notifyAllChannels', async () => {
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new Error('network down'))
            .mockResolvedValueOnce({ ok: true });
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            notifyAllChannels({ webhookUrl: 'https://a.example/hook', slackWebhookUrl: 'https://b.example/hook' }, sampleRecord()),
        ).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('isolates a non-2xx response - does not throw, just logs and continues', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
        vi.stubGlobal('fetch', fetchMock);
        await expect(notifyAllChannels({ webhookUrl: 'https://a.example/hook' }, sampleRecord())).resolves.toBeUndefined();
    });
});
