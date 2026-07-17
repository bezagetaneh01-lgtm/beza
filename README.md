# ODS → Snowflake Migration Dashboard (Jira-backed)

A small Node/Express web app that reads Jira tickets, shows their migration status, and lets you update that status inline. Authenticates to Jira via OAuth 2.0 (3LO) — required because this Jira org has classic API-token (Basic auth) access disabled.

## How it works

- Backend (`server.js`) authenticates to Jira Cloud using an OAuth 2.0 authorization-code flow, then calls the Jira REST API through `api.atlassian.com/ex/jira/{cloudId}/...` using the resulting access token.
- Tokens (access + refresh) are stored locally in `tokens.json` (gitignored) so you don't have to reconnect every time you restart the server. Access tokens auto-refresh using the stored refresh token.
- It auto-discovers the field ID for whatever field is named in `MIGRATION_FIELD_NAME` (defaults to the standard `Status` field) via Jira's field API.
- Frontend (`public/index.html`) is a single static page with two tabs: **Jira Tickets** (a "Connect to Jira" gate on first run, then a JQL filter box, summary counts, and a table with an inline dropdown per row to change migration status) and **Migration Timeline** (upload an Excel workbook with `Fact Table` and `Dim Table` sheets to get an interactive, clickable timeline chart).

### Migration Timeline tab

Upload any workbook shaped like the original template (sheets named exactly `Fact Table` and `Dim Table`). The file never leaves your browser — it's parsed entirely client-side (via SheetJS), so there's nothing to configure and no data is sent to any server.

- `Dim Table` (columns: `Domain`, `Expected Report Count`, `Expected Release Date`) drives the heatmap grid — one row per domain, one column per month, matching the look of the original `Timeline Chart` sheet.
- Click any highlighted cell to drill down into the matching rows from `Fact Table` (columns: `Domain`, `Status`, `Expected Release Date`, `Actual Release Date`, `Report Name`, `PO`, `Status Start Date`, `DB Developers`, `PBI Developers`, `Schema`) for that domain/month.
- Re-upload the file anytime it's updated — the chart and drill-down rebuild instantly, no restart needed.

**Risk highlighting.** Every report is classified as:
- **Released** — `Actual Release Date` is filled in.
- **Overdue** (red) — no `Actual Release Date` yet, and `Expected Release Date` has already passed.
- **Near release** (amber, default 14-day window, adjustable) — no `Actual Release Date` yet, and `Expected Release Date` is coming up soon.
- **On track** — everything else.

A timeline heatmap cell is colored red if it contains at least one overdue report, amber if it contains at least one near-release report (and no overdue ones), otherwise the normal blue. The same risk badge appears on each row in the drill-down table.

**"Reports coming your way."** A second table on the same tab filters `Fact Table` to `Status = DEV` with an `Expected Release Date` inside an adjustable window (default 30 days) — so POs can see what's about to land for testing before it shows up as a surprise. Lists `PO`, report, domain, `Status Start Date`, expected release, days until release, and the same risk badge.

**Stage progression gaps.** A third table checks a data-integrity rule: a report's `Actual Release Date` on one stage means that stage is complete and the report should have moved into the next stage (`Not Started` → `DEV` → `QA` → `UAT` → `In Production`). For every report with a completed stage, the app looks for another row for that same `Report Name` in the next stage whose `Status Start Date` matches that `Actual Release Date`. If none is found, it's listed as a gap — either the next-stage record hasn't been logged yet, or the dates don't line up.

## 1. Register an OAuth 2.0 app in Atlassian's Developer Console

1. Go to [developer.atlassian.com/console/myapps](https://developer.atlassian.com/console/myapps) and log in with your Jira account.
2. **Create** → **OAuth 2.0 integration** → name it, choose **Resource-level** access, agree to terms, **Create**.
3. **Permissions** tab → **Add** next to "Jira API" → **Configure** → on the **Classic scopes** tab, check: `read:jira-work`, `write:jira-work`. (`offline_access` isn't a checkbox here — the app requests it automatically in the login URL.)
4. **Authorization** tab → **Add** next to "OAuth 2.0 (3LO)" → set the Callback URL to `http://localhost:3000/oauth/callback` → Save.
5. **Settings** tab → copy the **Client ID** and **Secret**.

## 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

- `JIRA_AUTH_MODE=oauth` (already the default)
- `JIRA_OAUTH_CLIENT_ID` / `JIRA_OAUTH_CLIENT_SECRET` — from step 1
- `JIRA_BASE_URL` — the Jira URL you normally browse with (used only for "open in Jira" links)
- `JIRA_JQL` — narrow this to your migration tickets, e.g. `project = GDMP AND (summary ~ "ODS" OR summary ~ "Snowflake") ORDER BY created DESC`
- `MIGRATION_FIELD_NAME` — the exact Jira field name holding migration status (defaults to the standard `Status` field)

**Never commit `.env` or `tokens.json`.** Both are already in `.gitignore`.

## 3. Run and connect

```bash
npm install
npm start
```

Open `http://localhost:3000`. First time, you'll see a "Connect to Jira" button — click it, log in, and approve access to your Jira site. You'll be redirected back to the dashboard, now connected. You shouldn't need to reconnect on future restarts (the refresh token keeps you signed in), unless the token is revoked or the app is deleted from the Developer Console.

## Diagnostics

If something's not working:

- `http://localhost:3000/api/oauth-status` — connection state and which Jira site is linked
- `http://localhost:3000/api/whoami` — which Jira account the app is authenticated as
- `http://localhost:3000/api/debug-env` — confirms env vars loaded correctly (doesn't expose secrets)

## Deploying for a small team

Any Node-capable host works, since OAuth doesn't require being on the corporate network the way direct Basic-auth calls to an internal Jira URL would. Options:

- **Plain server/VM**: `npm install --production && npm start` behind a process manager (pm2, systemd) and a reverse proxy (nginx) for HTTPS.
- **Docker**: `node:20-slim` base image, copy files, `npm ci --production`, `CMD ["node", "server.js"]`.
- **Internal PaaS**: deploy as a standard Node container; set the env vars from `.env.example` as secrets, and update `JIRA_OAUTH_REDIRECT_URI` (and the callback URL in the Developer Console) to match your real deployed URL instead of `localhost:3000`.

If you move this off `localhost`, remember to update both the app's `JIRA_OAUTH_REDIRECT_URI` and the Callback URL registered in the Developer Console to match — they must be identical.

## API endpoints (for reference)

- `GET /oauth/login` — starts the OAuth flow
- `GET /oauth/callback` — OAuth redirect target, exchanges the code for tokens
- `GET /api/oauth-status` — `{ connected, siteUrl }`
- `GET /api/config` — resolved field name/id, default JQL
- `GET /api/tickets?jql=...` — list tickets matching JQL, with migration status
- `GET /api/status-options?sampleIssueKey=KEY-123` — allowed values for the migration status field
- `PUT /api/tickets/:key` with body `{ "value": "New Status" }` — updates migration status (direct field edit, or a workflow transition if `MIGRATION_FIELD_NAME` resolves to the standard `status` field)

## Notes

- If `MIGRATION_FIELD_NAME` resolves to the standard workflow status, updates go through Jira workflow **transitions** — the new value must match one of the ticket's currently available transitions (the API returns `availableTransitions` in the error if it doesn't).
- This app holds tokens with write access to Jira. Don't expose it outside your team without adding your own auth layer in front (e.g. nginx basic-auth) — anyone who can reach the dashboard URL can currently use it.
