// Calls the UK Modern Slavery Statement Registry Delta Monitor actor and prints each new/changed statement.
// Install: npm install apify-client
// Run: APIFY_TOKEN=your_token node examples/call-actor.cjs

const { ApifyClient } = require('apify-client');

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

async function main() {
    const input = {
        years: ['2026'],
        sectorFilter: ['Private'],
        onlyMissingDisclosures: true,
        maxItems: 100,
    };

    const run = await client.actor('vWDvsAd2iXgVp5aC7').call(input);

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    for (const item of items) {
        const missing = (item.missing_disclosures || []).join(', ') || 'none';
        console.log(`${item.event_type}: ${item.organisation_name} (${item.sector_type}, ${item.turnover}) - missing: ${missing}`);
    }

    console.log(`Fetched ${items.length} records. Full run: https://console.apify.com/actors/runs/${run.id}`);
}

main();
