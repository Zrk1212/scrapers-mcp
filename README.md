# zrk-scrapers-mcp

An MCP server that gives AI agents (Claude, Cursor, VS Code, Windsurf and others) 9 production web scrapers. Each tool runs a maintained [Apify](https://apify.com/zrk1212) actor and returns clean JSON.

| Tool | What it gets | Actor |
|---|---|---|
| `scrape_ats_jobs` | Open jobs from Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee, Personio, Teamtailor, Rippling | [ats-jobs-monitor](https://apify.com/zrk1212/ats-jobs-monitor) |
| `scrape_workday_jobs` | Every job on a Workday career site, past the 2,000 cap | [workday-jobs-scraper](https://apify.com/zrk1212/workday-jobs-scraper) |
| `audit_pagespeed` | Lighthouse scores, Core Web Vitals and top fixes for many pages or whole sites | [pagespeed-bulk-auditor](https://apify.com/zrk1212/pagespeed-bulk-auditor) |
| `find_uk_new_companies` | Newly incorporated UK companies with directors (Companies House) | [uk-new-company-leads](https://apify.com/zrk1212/uk-new-company-leads) |
| `get_tiktok_transcripts` | TikTok video transcripts from URLs or profiles | [tiktok-transcript-scraper](https://apify.com/zrk1212/tiktok-transcript-scraper) |
| `find_luma_organizers` | Luma event organizer leads with socials and audience size | [luma-organizer-leads](https://apify.com/zrk1212/luma-organizer-leads) |
| `get_google_hotel_prices` | Google Hotels prices from every seller for exact dates | [google-hotels-prices-scraper](https://apify.com/zrk1212/google-hotels-prices-scraper) |
| `scrape_google_ads_transparency` | A brand's Google ads with Search ad copy as text | [google-ads-transparency-ad-copy](https://apify.com/zrk1212/google-ads-transparency-ad-copy) |
| `scrape_telegram_channel` | Public Telegram channel posts, views, reactions and subscriber counts | [telegram-channel-scraper-stats](https://apify.com/zrk1212/telegram-channel-scraper-stats) |
| `get_run_results` | Results of a long run, or the next page of a big one | |

## Setup

1. Get an Apify API token (free account, includes monthly credit): https://console.apify.com/settings/integrations
2. Add the server to your client.

**Claude Code**

```bash
claude mcp add zrk-scrapers -e APIFY_TOKEN=your_token -- npx -y zrk-scrapers-mcp
```

**Claude Desktop, Cursor, Windsurf, VS Code** (`mcpServers` config)

```json
{
  "mcpServers": {
    "zrk-scrapers": {
      "command": "npx",
      "args": ["-y", "zrk-scrapers-mcp"],
      "env": { "APIFY_TOKEN": "your_token" }
    }
  }
}
```

## Example prompts

- "Find remote product designer jobs at Linear, Figma and Notion posted this week."
- "Audit the mobile Core Web Vitals of the 20 main pages on example.com and list the worst offenders."
- "What Google Search ads is hubspot.com running in the UK right now? Give me the headlines."
- "Get the transcripts of @nasa's last 5 TikToks and summarize them."
- "Compare Booking.com vs the official site price for 3 hotels in Austin for Dec 12 to 14."
- "List software companies incorporated in Manchester in the last 7 days with their directors."

## Pricing and limits

Runs use your Apify account. Each actor is pay-per-result (for example $0.60 per 1,000 Telegram posts or $2 per 1,000 jobs); see each actor page for prices. Every run is capped at $1 by default (`maxChargeUsd` per call, or set `ZRK_MAX_CHARGE_USD` in env to change the default), and tools accept `maxItems` to limit the rows returned. Any other actor input field can be passed through `extraInput`.

Long runs return a `runId` after `waitSecs` (default 120); call `get_run_results` to collect them.

## License

MIT
