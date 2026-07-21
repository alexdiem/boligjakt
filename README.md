# Husjakt

**Live app: [boligjakt.vercel.app](https://boligjakt.vercel.app)**

Compare Norwegian properties side by side. Upload a salgsoppgave and tilstandsrapport (PDF), and the app extracts key facts, TG2/TG3 defects with cost estimates, and an AI-generated assessment — then ranks all your properties against each other.

## Features

- **PDF analysis** — upload salgsoppgave + tilstandsrapport, text is extracted in the browser
- **AI extraction** — price, size, year built, energy rating, TG2/TG3 items with cost estimates
- **Qualitative assessment** — summary, pros, cons written by Claude Sonnet
- **Side-by-side comparison** — sortable table with best-value highlighting
- **Scoring** — weighted ranking by size, outdoor area, condition, and price
- **Persistent storage** — all properties saved in your browser's localStorage
- **Partner sync** — share a secret code with the person you're house-hunting with and keep properties, requirements, and preferences in sync automatically (optional, requires a free Upstash Redis database)
- **BYO API key** — you supply your own Anthropic key; keys are never stored server-side

## How it works

The analysis runs in two steps to keep costs low:

1. **Claude Haiku** reads the full document and extracts structured data (price, TG items, cost estimates, etc.)
2. **Claude Sonnet** reads the structured output and a short document excerpt to write the qualitative assessment

Typical cost: ~$0.04–0.06 per property analysis.

## Getting started

### Deploy to Vercel (recommended)

1. Fork or clone this repo
2. Import at [vercel.com/new](https://vercel.com/new)
3. No environment variables needed — users supply their own Anthropic API key in the app

### Enable partner sync (optional)

Partner sync needs a small key-value database. On the free tier this costs nothing:

1. In your Vercel project, go to **Storage → Create Database → Upstash for Redis** (or add the [Upstash integration](https://vercel.com/marketplace/upstash) from the marketplace)
2. Connect it to the project — Vercel adds the `KV_REST_API_URL`/`KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`) environment variables automatically
3. Redeploy

Without a database the app works exactly as before; the sync section just reports that sync isn't set up.

In the app, one partner clicks **Opprett delingskode** and sends the `hj-…` code to the other, who pastes it under **Koble til**. From then on properties, requirements, and preferences sync automatically (on save, every 30 seconds, and when the tab regains focus). Deletions propagate too. Disconnecting keeps each person's local copy.

### Run locally

```bash
npm install -g vercel
npm install
vercel dev
```

Open [http://localhost:3000](http://localhost:3000).

### Using the app

1. Enter your [Anthropic API key](https://console.anthropic.com/settings/keys) (`sk-ant-…`) in the input at the top of the form — it's stored only in your browser
2. Upload one or more PDFs (salgsoppgave + tilstandsrapport) per property, or paste the text directly
3. Click **Analyser tekst** — fields are filled automatically
4. Adjust any fields if needed, then click **Lagre bolig**
5. Repeat for each property you want to compare

## Privacy & data handling

- Properties, preferences, and your API key are stored **only in your browser** (localStorage) by default — nothing is persisted server-side
- If you enable **partner sync**, properties, requirements, and preferences (never API keys) are also stored in the app's Redis database under your secret share code; the code works like a password — anyone who has it can read and change that data
- When you analyse a document, its text is sent through the app's serverless function to the Anthropic API using **your own key**; the function is a stateless proxy and stores nothing
- The buy-score and AI assessment are guidance, not professional building, valuation, or financial advice — always read the full salgsoppgave and tilstandsrapport yourself
- Use the in-app **Sikkerhetskopi** (backup) button to export your data to a file; clearing browser data will otherwise erase it

## Tech stack

- Vanilla HTML/CSS/JS — no framework, single file frontend
- [pdf.js](https://mozilla.github.io/pdf.js/) for client-side PDF text extraction
- [Anthropic SDK](https://github.com/anthropic-ai/anthropic-sdk-typescript) on a Vercel serverless function
- Vercel for hosting

## License

BSD-3-clause
