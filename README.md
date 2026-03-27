# ReviewScout Pro

A lead generation tool for review growth agencies. Enter a city + industry, get a ranked call list of businesses that need help with their Google reviews.

---

## Quick Start

### Requirements

- **Node.js** v18+ — [download here](
  
)
- **Google Places API (New)** key — [Google Cloud Console](https://console.cloud.google.com)
- **SerpApi** key — [serpapi.com](https://serpapi.com)
- **Anthropic API** key — [console.anthropic.com](https://console.anthropic.com)

### Setup

1. Open `review-scout-pro (1).html` in a text editor and add your API keys in the `GLOBAL_CONFIG` section (~line 298):

```js
const GLOBAL_CONFIG = {
  GOOGLE_MAPS_KEY: "your-google-key",
  SERP_API_KEY:    "your-serpapi-key",
  ANTHROPIC_KEY:   "your-anthropic-key",
  GHL_DOMAIN:      "app.hub360ai.com",    // optional
  GHL_LOCATION_ID: "your-location-id",    // optional
  GHL_LEAD_TAG:    "cold-call-interested", // optional
  GHL_API_KEY:     "your-ghl-api-key",    // optional
};
```

2. Open a terminal in the project folder and run:

```bash
node server.js
```

3. Open `review-scout-pro (1).html` in Chrome or Edge (just double-click it).

4. Enter a city, pick an industry (or type custom keywords), set radius and max leads, click **Generate Call List**.

---

## How It Works

1. **Search** — Runs multiple Google Places queries to find businesses in your area
2. **Review Velocity Filter** — Only keeps businesses with ≤20 reviews in the last 6 months (stalled/slow review growth)
3. **Scoring** — Ranks each business by review velocity, count, and rating gaps
4. **AI Talking Points** — Claude writes a custom cold-call opener for each lead
5. **Email Scraping** — Checks business websites for email addresses (homepage + /contact + /about pages)
6. **Results Table** — Sortable, with priority badges (Hot/Warm/Cold), velocity status, and follow-up reminders

---

## Features

- **Multi-query search** — Up to 12 query variations to maximize unique results
- **Review velocity scoring** — Prioritizes businesses whose reviews have stalled
- **Velocity status** — Stalled (≤1/mo), Slow (2-3/mo), Active (4+/mo)
- **AI talking points** — Custom cold-call openers via Claude
- **PDF reports** — One-click sales proposals per business
- **Email scraping** — Finds emails from business websites
- **CSV export** — Full call list with all data
- **GHL integration** — Push leads to GoHighLevel CRM
- **Follow-up reminders** — Track callbacks with notes

---

## Google API Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create or select a project
3. Enable **Places API (New)** in APIs & Services → Library
4. Create an API key in APIs & Services → Credentials
5. Attach a billing account (Google gives $200/month free credit)

---

## Cost Per Search

| API | Cost |
|-----|------|
| Google Text Search (3-4 queries) | ~$0.13 |
| Google Place Details — Basic (50 leads) | ~$0.25 |
| Google Place Details — Reviews (50 leads) | ~$0.50 |
| Claude AI talking points (50 leads) | ~$0.04 |
| **Total per search (~50 leads)** | **~$0.70–0.90** |

Google's $200/month free credit covers ~250+ searches.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Cannot connect" / "Failed to fetch" | Run `node server.js` in the project folder |
| "Google Denial" | Enable Places API (New) and attach billing in Google Cloud |
| No results | Try larger radius or different keywords |
| AI talking points stuck | Check Anthropic API key and balance |
| GHL blank page | Verify GHL_DOMAIN and GHL_LOCATION_ID, and login to GHL in same browser |
| Port 3456 in use | Close other process or change PORT in server.js |

---

## Project Files

```
review-scout-pro (1).html  — The app (open in browser)
server.js                   — Local proxy server (run with node)
README (1).md               — This file
```
