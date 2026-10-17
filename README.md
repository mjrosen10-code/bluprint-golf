# BluPrint Golf — bluprintgolf.com

One Cloudflare Worker serves the app and its API.

- `public/` — the app (index.html), the web runtime (`bp-runtime.js`), course and tee data
- `src/worker.js` — sign-in by emailed code, sessions, your saved data (Cloudflare D1), AI proxy
- `wrangler.jsonc` — Worker settings. The D1 database `bluprint-golf` already exists in your Cloudflare account with its tables (`schema.sql`).

Not in this release: the Clubhouse (hidden; it shows "coming soon").

## Secrets to add (Worker → Settings → Variables and Secrets → Add → type "Secret")

| Name | Where it comes from |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys. Set a monthly spend limit under Billing. |
| `RESEND_API_KEY` | resend.com → API Keys (sends the sign-in codes) |

Each signed-in golfer gets up to 60 AI calls a day (`AI_DAILY_LIMIT` in wrangler.jsonc).

## Deploy
Connect this folder's GitHub repo in Cloudflare (Workers & Pages → Create → Import a repository). Every push redeploys.
Or from a computer with Node installed: `npx wrangler deploy` in this folder.
