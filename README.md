# ODS → Snowflake Migration Dashboard (Jira-backed)

A small Node/Express web app that reads Jira tickets, shows their migration status, and lets you update that status inline. Authenticates to Jira via OAuth 2.0 (3LO) — required because this Jira org has classic API-token (Basic auth) access disabled.

## How it works

- Backend (`server.js`) authenticates to Jira Cloud using an OAuth 2.0 authorization-code flow, then calls the Jira REST API through `api.atlassian.com/ex/jira/{cloudId}/...` using the resulting access token.
- Tokens (access + refresh) are stored locally in `tokens.json` (gitignored) so you don't have to reconnect every time you restart the server. Access tokens auto-refresh using the stored refresh token.
- It auto-discovers the field ID for whatever field is named in `MIGRATION_FIELD_NAME` (defaults to the standard `Status` field) via Jira's field API.
- Frontend (`public/index.html`) is a single static page with two tabs: **Jira Tickets** (a "Connect to Jira" gate on first run, then a JQL filter box, summary counts, and a table with an inline dropdown per row to change migration status) and **Migration Timeline** (upload an Excel workbook with `Fact Table` and `Dim Table` sheets to get an interactive, clickable timeline chart).

### Migration Timeline tab

On load, the app auto-fetches `data/GDM_Tracker_latest.xlsx` (you can also upload your own workbook shaped the same way). To point the dashboard at a newer tracker export, just replace that file with the new one under the same name — no code change needed. The file never leaves your browser — it's parsed entirely client-side (via SheetJS), so there's nothing to configure and no data is sent to any server, and nothing is ever written back to the file.

The workbook's `Combined Delivery Data` sheet (one row per report, one column per stage's dates) is the real source of truth. The app derives a `Fact Table` (one row per report per stage it has reached) and a `Dim Table` (one row per domain per month, with an Expected Report Count) from it live in memory every time the file loads — see the `deriveFactAndDimFromCombinedData` function in `public/index.html` for the exact rules. The workbook's own `Fact Table` sheet is just a static reference snapshot and can lag behind edits made to `Combined Delivery Data` since it was last generated — it is **not** treated as ground truth here. The app always recomputes fresh on every load, which is the more current and correct behavior even when it disagrees with that snapshot. Everything below operates on that derived Fact Table / Dim Table.

**How the Fact Table is generated.** For each report row in `Combined Delivery Data`:
- **Row count** comes from that report's `Current Status` dropdown, mapped to a position in the pipeline: `NOT STARTED` → 0 rows, `DB Dev` → 1, `PBI Dev` → 2, `QA` → 3, `DPO Approval` → 4, `RELEASED IN PROD` → 5. A report still Not Started gets **zero** Fact Table rows — no placeholder row is created for it. (A Not Started report's `Plan Delivery Month` — a plain month name like "August", with no `Plan Delivery Date` column to fall back on — is resolved to an actual date internally, assuming the nearest upcoming occurrence of that month, so the Dim Table heatmap fallback can still place it, even though it emits no Fact Table row.)
  - The `Current Status` dropdown no longer offers `RELEASED IN PROD` as a selectable option — a report is expected to stay tagged `DPO Approval` even after it ships, and instead signal that it's actually live via a filled-in `Confirmed Deployed Date`. So the app treats `Current Status = DPO Approval` **plus** a filled `Confirmed Deployed Date` as equivalent to `RELEASED IN PROD` (5 rows), on top of still honoring the literal `RELEASED IN PROD` value for any older rows that already have it set.
- One row is emitted per stage up through that count, in order: `DB Dev`, `PBI Dev`, `QA`, `DPO Approval`, `RELEASED IN PROD`.
- **Expected Release Date** for each row is that *same stage's* own Expected Completion Date if it's filled in — the real target once someone sets it — falling back to that same stage's own Actual Completion Date only when no Expected date exists yet (the common case for historical/migrated data that only ever got an Actual recorded). It never borrows a date from a different stage.
- **Actual Release Date** for each row is that stage's own Actual Completion Date, exactly as recorded — genuinely blank if not yet filled in, never guessed or pulled forward from a later stage. There's no column literally named `DPO Approval Actual Completion Date` — `Confirmed Deployed Date` is its real-world equivalent, so it's used as `DPO Approval`'s Actual field too. `RELEASED IN PROD` uses that same `Confirmed Deployed Date` for both its own Expected and Actual Release Date, so it's deliberately blank until that's filled in — never invented.
- **Status Start Date** for each row chains from the *previous* row's own Expected Release Date (so it inherits that same Expected-first-then-Actual fallback). The very first row a report has (its earliest stage) has no Status Start Date at all.
- **PO** is deliberately populated from `Combined Delivery Data`'s `QA Tester` column, not the sheet's actual `PO` column — an intentional dashboard customization, not a bug, per an explicit decision to surface the QA Tester's name in that field instead.
- `Domain`, `DB Developers`, `PBI Developers`, and `Schema` are carried straight through from the report's row in `Combined Delivery Data`, unchanged, on every stage-row for that report.

**Why `Dim Table` is manually maintained, not derived.** The app *could* compute expected counts by grouping the reports actually listed in `Combined Delivery Data` — but that only counts reports someone has already entered by name. If a domain is expected to deliver, say, 20 reports next month and only 12 have been listed so far, deriving the count from `Combined Delivery Data` would silently under-report it as 12. `Dim Table`'s `Expected Report Count` is set by hand precisely so it can reflect the *real* expected total, independent of how many reports happen to be listed yet. (The app does have a derived-Dim-Table fallback for the rare case a workbook has no `Dim Table` sheet at all, but it's just that — a fallback, not the general design.)

**Timeline chart (heatmap).** One row per domain ("Data Product"), one column per month, built from the Dim Table: each cell's number is the sum of `Expected Report Count` for that domain + month. A cell is colored using two independent checks:
- *Overdue risk* — among the Fact Table rows for that domain + month that aren't yet released (no `Actual Release Date`), find the worst case: overdue by ≥ the "red" day threshold → red; overdue by ≥ the "amber" threshold (but less than red) → amber; overdue by less than the amber threshold, or not yet due → no flag. Both thresholds are adjustable in the UI ("Timeline: overdue ≥ N days").
- *Missing reports* — for months strictly before the current month only (an in-progress or future month can't fairly be judged yet), the app counts the *distinct report names* found in the Fact Table for that domain + month and compares it to the Dim Table's Expected Report Count. If fewer distinct reports were found than expected, the cell gets a red fill and a ⚠ flag, regardless of the overdue check above.

Click any highlighted cell to open the drill-down table for that domain/month.

**Drill-down table.** Filters the Fact Table to rows matching the clicked domain + month, then collapses that down to **one row per report** — whichever stage-row is furthest along the pipeline (`DB Dev` → `PBI Dev` → `QA` → `DPO Approval` → `RELEASED IN PROD`), so a report with several stage-rows landing in the same month only appears once, showing its latest status. The title shows "`X` of `Y` expected reports found", where `X` is the count of distinct report names found and `Y` is the Dim Table's Expected Report Count for that cell; if `X < Y` it also notes how many are missing, if `X > Y` it notes how many more than expected. Each row shows its risk badge (see below), `PO`, `Status Start Date`, `Expected Release Date`, `Actual Release Date`, developers, and `Schema`.

**"Reports coming your way."** A second table on the same tab filters the Fact Table to rows whose `Status` is `DB Dev` or `PBI Dev` (i.e. still in development, not yet in QA or beyond) with an `Expected Release Date` on or before an adjustable cutoff (default 30 days out — anything already overdue is included too), so POs can see what's about to land for testing before it's a surprise. Filterable by PO and by month (the month filter syncs automatically to whichever heatmap cell you last clicked), sorted by soonest `Expected Release Date` first. Lists `PO`, report, domain, `Status Start Date`, expected release, a "Nd" / "Nd overdue" / "Released <date>" countdown, the risk badge, developers, and `Schema`.

**Risk badges.** Every Fact Table row shown in the drill-down and Coming Your Way tables is classified independently of the heatmap's tiered logic:
- **Released** — `Actual Release Date` is filled in.
- **Overdue `N`d** (red) — no `Actual Release Date` yet, and `Expected Release Date` has already passed by `N` days.
- **On track** — everything else (not yet due, or no `Expected Release Date` to judge against).

This is a simple three-way classification, deliberately separate from the heatmap cell coloring's adjustable amber/red day thresholds described above — a row can show "On track" while its cell is amber/red because of a *different* report in the same domain/month, or vice versa.

**Stage progression gaps.** A third table checks a data-integrity rule: a report's `Actual Release Date` on one stage means that stage is complete and the report should have moved into the next stage (`Not Started` → `DB Dev` → `PBI Dev` → `QA` → `DPO Approval` → `RELEASED IN PROD`). For every report with a completed stage, the app looks for another row for that same `Report Name` in the next stage whose `Status Start Date` matches that `Actual Release Date` exactly (same calendar day). If none is found, it's listed as a gap — either the next-stage record hasn't been logged yet, or the dates don't line up.

**Plan Delivery Month mismatches.** A fourth table checks another data-integrity rule, purely within `Combined Delivery Data`: a report's `Plan Delivery Month` column is expected to match the calendar month of its furthest stage's own *Expected Completion Date* column (e.g. if a report's latest stage is QA, `Plan Delivery Month` should match the month of `QA Expected Completion Date`). This compares against that raw column only — not the Expected-or-Actual-fallback value used for the Fact Table's `Expected Release Date` elsewhere. It's also capped at `DPO Approval Expected Completion Date`: `RELEASED IN PROD` has no Expected Completion Date column of its own (`Confirmed Deployed Date` is a deployment-confirmation field, not an Expected Completion Date), so a report that's shipped is still checked against its `DPO Approval Expected Completion Date`. If that column is blank, there's nothing to compare and no flag is raised either way. When the two disagree, the report is listed here. It also feeds the *derived* Dim Table fallback (used only when the workbook has no manual `Dim Table` sheet at all): a mismatched report gets grouped by its resolved `Plan Delivery Month` instead. Since this workbook's `Dim Table` sheet is manually maintained and always used directly, the heatmap's counts themselves aren't affected by this — this table exists purely to surface the discrepancy for someone to go fix in `Combined Delivery Data`.

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
