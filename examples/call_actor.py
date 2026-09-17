# Calls the UK Modern Slavery Statement Registry Delta Monitor actor and prints each new/changed statement.
# Install: pip install apify-client
# Run: APIFY_TOKEN=your_token python examples/call_actor.py

import os

from apify_client import ApifyClient

client = ApifyClient(os.environ["APIFY_TOKEN"])

run_input = {
    "years": ["2026"],
    "sectorFilter": ["Private"],
    "onlyMissingDisclosures": True,
    "maxItems": 100,
}

run = client.actor("vWDvsAd2iXgVp5aC7").call(run_input=run_input)

items = list(client.dataset(run["defaultDatasetId"]).iterate_items())

for item in items:
    missing = ", ".join(item.get("missing_disclosures") or []) or "none"
    print(f"{item['event_type']}: {item['organisation_name']} ({item['sector_type']}, {item['turnover']}) - missing: {missing}")

print(f"Fetched {len(items)} records. Full run: https://console.apify.com/actors/runs/{run['id']}")
