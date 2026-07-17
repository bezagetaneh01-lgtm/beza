require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// JIRA_BASE_URL is still used for "open in Jira" links (the domain you actually browse with).
const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');

// 'oauth' (recommended, default) or legacy 'basic'/'bearer' API-token auth,
// kept only for Jira instances where classic API tokens are actually allowed.
const JIRA_AUTH_MODE = (process.env.JIRA_AUTH_MODE || 'oauth').toLowerCase();

// Legacy API-token auth
const JIRA_PAT = process.env.JIRA_PAT || '';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';

// OAuth 2.0 (3LO) config
const OAUTH_CLIENT_ID = process.env.JIRA_OAUTH_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.JIRA_OAUTH_CLIENT_SECRET || '';
const OAUTH_REDIRECT_URI = process.env.JIRA_OAUTH_REDIRECT_URI || `http://localhost:${PORT}/oauth/callback`;
const OAUTH_SCOPES = process.env.JIRA_OAUTH_SCOPES || 'read:jira-work write:jira-work offline_access';

const DEFAULT_JQL = process.env.JIRA_JQL || 'ORDER BY updated DESC';
const STATUS_FIELD_NAME = process.env.MIGRATION_FIELD_NAME || 'Current Status';

const TOKENS_FILE = path.join(__dirname, 'tokens.json');

if (JIRA_AUTH_MODE === 'oauth' && (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET)) {
  console.warn('[WARN] JIRA_OAUTH_CLIENT_ID / JIRA_OAUTH_CLIENT_SECRET are not set. Visit /oauth/login will fail until these are set in .env.');
}
if (JIRA_AUTH_MODE !== 'oauth' && (!JIRA_BASE_URL || !JIRA_PAT)) {
  console.warn('[WARN] JIRA_BASE_URL and/or JIRA_PAT are not set. Set them in .env (see .env.example).');
}

// ---------------------------------------------------------------------------
// OAuth 2.0 (3LO) token storage + refresh
// ---------------------------------------------------------------------------

let tokenStore = null; // { accessToken, refreshToken, expiresAt, cloudId, siteUrl }

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      tokenStore = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[WARN] Failed to read tokens.json:', e.message);
  }
}
function saveTokens() {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokenStore, null, 2), 'utf8');
}
loadTokens();

// Short-lived store of pending OAuth "state" values (CSRF protection for the login flow)
const pendingStates = new Map();
function rememberState(state) {
  pendingStates.set(state, Date.now());
  for (const [s, ts] of pendingStates.entries()) {
    if (Date.now() - ts > 10 * 60 * 1000) pendingStates.delete(s);
  }
}

async function applyTokenResponse(body) {
  const prevCloudId = tokenStore && tokenStore.cloudId;
  const prevSiteUrl = tokenStore && tokenStore.siteUrl;
  tokenStore = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || (tokenStore && tokenStore.refreshToken),
    expiresAt: Date.now() + (body.expires_in ? body.expires_in * 1000 : 3600 * 1000),
    cloudId: prevCloudId || null,
    siteUrl: prevSiteUrl || null,
  };

  // Resolve which Jira site (cloudId) to use, the first time we get a token.
  if (!tokenStore.cloudId) {
    const resourcesRes = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${tokenStore.accessToken}`, Accept: 'application/json' },
    });
    const resources = await resourcesRes.json();
    if (!Array.isArray(resources) || resources.length === 0) {
      throw new Error('No accessible Jira sites found for this account/app. Make sure you approved a site during login.');
    }
    const preferred =
      resources.find((r) => (r.url || '').toLowerCase().includes('nationalgrid')) || resources[0];
    tokenStore.cloudId = preferred.id;
    tokenStore.siteUrl = preferred.url;
  }

  saveTokens();
}

async function exchangeCodeForTokens(code) {
  const res = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: OAUTH_REDIRECT_URI,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`OAuth token exchange failed: ${JSON.stringify(body)}`);
  await applyTokenResponse(body);
}

async function refreshAccessToken() {
  if (!tokenStore || !tokenStore.refreshToken) {
    throw Object.assign(new Error('Not connected to Jira. Visit /oauth/login to connect.'), { status: 401 });
  }
  const res = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: tokenStore.refreshToken,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`OAuth token refresh failed: ${JSON.stringify(body)}`);
  await applyTokenResponse(body);
}

async function getValidAccessToken() {
  if (!tokenStore || !tokenStore.accessToken) {
    throw Object.assign(new Error('Not connected to Jira. Visit /oauth/login to connect.'), { status: 401 });
  }
  if (Date.now() > tokenStore.expiresAt - 60 * 1000) {
    await refreshAccessToken();
  }
  return tokenStore.accessToken;
}

// ---------------------------------------------------------------------------
// Legacy API-token auth (kept for Jira instances where classic tokens are allowed)
// ---------------------------------------------------------------------------

function legacyAuthHeader() {
  if (JIRA_AUTH_MODE === 'basic') {
    const token = Buffer.from(`${JIRA_EMAIL}:${JIRA_PAT}`).toString('base64');
    return `Basic ${token}`;
  }
  return `Bearer ${JIRA_PAT}`;
}

// ---------------------------------------------------------------------------
// Unified Jira API request helper
// ---------------------------------------------------------------------------

async function jiraFetch(pathname, options = {}) {
  let url;
  let authHeaderValue;

  if (JIRA_AUTH_MODE === 'oauth') {
    const accessToken = await getValidAccessToken();
    url = `https://api.atlassian.com/ex/jira/${tokenStore.cloudId}${pathname}`;
    authHeaderValue = `Bearer ${accessToken}`;
  } else {
    url = `${JIRA_BASE_URL}${pathname}`;
    authHeaderValue = legacyAuthHeader();
  }

  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': authHeaderValue,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (e) {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(`Jira API ${res.status} ${res.statusText}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ---------------------------------------------------------------------------
// OAuth routes
// ---------------------------------------------------------------------------

app.get('/oauth/login', (req, res) => {
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    return res.status(500).send('JIRA_OAUTH_CLIENT_ID / JIRA_OAUTH_CLIENT_SECRET are not set in .env.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  rememberState(state);

  const authUrl = new URL('https://auth.atlassian.com/authorize');
  authUrl.searchParams.set('audience', 'api.atlassian.com');
  authUrl.searchParams.set('client_id', OAUTH_CLIENT_ID);
  authUrl.searchParams.set('scope', OAUTH_SCOPES);
  authUrl.searchParams.set('redirect_uri', OAUTH_REDIRECT_URI);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('prompt', 'consent');

  res.redirect(authUrl.toString());
});

app.get('/oauth/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  if (error) {
    return res.status(400).send(`Jira OAuth error: ${error} - ${errorDescription || ''}`);
  }
  if (!state || !pendingStates.has(String(state))) {
    return res.status(400).send('Invalid or expired OAuth state. Try connecting again from /oauth/login.');
  }
  pendingStates.delete(String(state));
  try {
    await exchangeCodeForTokens(code);
    res.redirect('/?connected=1');
  } catch (err) {
    res.status(500).send(`Failed to complete Jira connection: ${err.message}`);
  }
});

app.get('/api/oauth-status', (req, res) => {
  res.json({
    mode: JIRA_AUTH_MODE,
    connected: JIRA_AUTH_MODE === 'oauth' ? Boolean(tokenStore && tokenStore.accessToken) : true,
    siteUrl: tokenStore ? tokenStore.siteUrl : null,
  });
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, authMode: JIRA_AUTH_MODE });
});

app.get('/api/debug-env', (req, res) => {
  res.json({
    authMode: JIRA_AUTH_MODE,
    baseUrl: JIRA_BASE_URL,
    oauthClientIdSet: Boolean(OAUTH_CLIENT_ID),
    oauthClientSecretSet: Boolean(OAUTH_CLIENT_SECRET),
    oauthRedirectUri: OAUTH_REDIRECT_URI,
    oauthConnected: Boolean(tokenStore && tokenStore.accessToken),
    oauthSiteUrl: tokenStore ? tokenStore.siteUrl : null,
    legacyEmail: JIRA_EMAIL,
    legacyPatLength: JIRA_PAT.length,
  });
});

app.get('/api/whoami', async (req, res) => {
  try {
    const me = await jiraFetch('/rest/api/2/myself');
    res.json({
      authMode: JIRA_AUTH_MODE,
      accountId: me.accountId,
      displayName: me.displayName,
      emailAddress: me.emailAddress,
      active: me.active,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.body });
  }
});

// ---------------------------------------------------------------------------
// Migration-status field resolution
// ---------------------------------------------------------------------------

let cachedFieldId = null;
let cachedFieldMeta = null;

async function resolveStatusFieldId() {
  if (cachedFieldId) return cachedFieldId;

  const normalized = STATUS_FIELD_NAME.trim().toLowerCase();
  if (normalized === 'status' || normalized === 'current status') {
    cachedFieldId = 'status';
    return cachedFieldId;
  }

  const fields = await jiraFetch('/rest/api/2/field');
  const match = fields.find((f) => (f.name || '').trim().toLowerCase() === normalized);
  if (!match) {
    throw new Error(
      `Could not find a Jira field named "${STATUS_FIELD_NAME}". Set MIGRATION_FIELD_NAME in .env to match the exact field name in Jira, or use the standard "status" field.`
    );
  }
  cachedFieldId = match.id;
  cachedFieldMeta = match;
  return cachedFieldId;
}

app.get('/api/config', async (req, res) => {
  try {
    const fieldId = await resolveStatusFieldId();
    res.json({
      defaultJql: DEFAULT_JQL,
      statusFieldName: STATUS_FIELD_NAME,
      statusFieldId: fieldId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status-options', async (req, res) => {
  try {
    const issueKeyForMeta = req.query.sampleIssueKey;
    const fieldId = await resolveStatusFieldId();

    if (fieldId === 'status') {
      return res.json({ type: 'workflow', options: [] });
    }

    if (!issueKeyForMeta) {
      return res.json({ type: 'unknown', options: [], note: 'Pass ?sampleIssueKey=KEY-123 to discover allowed values from that issue\'s edit metadata.' });
    }

    const meta = await jiraFetch(`/rest/api/2/issue/${encodeURIComponent(issueKeyForMeta)}/editmeta`);
    const fieldMeta = meta.fields && meta.fields[fieldId];
    if (!fieldMeta) {
      return res.json({ type: 'unknown', options: [] });
    }
    const options = (fieldMeta.allowedValues || []).map((v) => ({
      id: v.id,
      value: v.value || v.name || v.id,
    }));
    res.json({ type: fieldMeta.schema ? fieldMeta.schema.type : 'unknown', options });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

app.get('/api/tickets', async (req, res) => {
  try {
    const fieldId = await resolveStatusFieldId();
    const jql = req.query.jql || DEFAULT_JQL;
    const maxResults = Math.min(parseInt(req.query.maxResults, 10) || 100, 200);
    const nextPageToken = req.query.nextPageToken || undefined;

    const fieldsToFetch = ['summary', 'status', 'assignee', 'updated', 'created', fieldId].filter(
      (v, i, arr) => arr.indexOf(v) === i
    );

    const data = await jiraFetch('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        maxResults,
        fields: fieldsToFetch,
        ...(nextPageToken ? { nextPageToken } : {}),
      }),
    });

    const browseBase = JIRA_BASE_URL || (tokenStore && tokenStore.siteUrl) || '';

    const issues = (data.issues || []).map((issue) => {
      const raw = issue.fields[fieldId];
      let migrationStatus = null;
      if (raw && typeof raw === 'object') {
        migrationStatus = raw.value || raw.name || null;
      } else if (raw) {
        migrationStatus = raw;
      }
      return {
        key: issue.key,
        url: `${browseBase}/browse/${issue.key}`,
        summary: issue.fields.summary,
        status: issue.fields.status ? issue.fields.status.name : null,
        assignee: issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned',
        updated: issue.fields.updated,
        migrationStatus,
      };
    });

    res.json({
      issues,
      nextPageToken: data.nextPageToken || null,
      statusFieldId: fieldId,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.put('/api/tickets/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    if (!value) return res.status(400).json({ error: 'Missing "value" in request body.' });

    const fieldId = await resolveStatusFieldId();

    if (fieldId === 'status') {
      const transitions = await jiraFetch(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`);
      const match = (transitions.transitions || []).find(
        (t) => t.name.toLowerCase() === String(value).toLowerCase() || (t.to && t.to.name.toLowerCase() === String(value).toLowerCase())
      );
      if (!match) {
        return res.status(400).json({
          error: `"${value}" is not a valid transition from the current status.`,
          availableTransitions: (transitions.transitions || []).map((t) => t.name),
        });
      }
      await jiraFetch(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
        method: 'POST',
        body: JSON.stringify({ transition: { id: match.id } }),
      });
      return res.json({ ok: true, key, newStatus: value, mode: 'transition' });
    }

    const meta = await jiraFetch(`/rest/api/2/issue/${encodeURIComponent(key)}/editmeta`);
    const fieldMeta = meta.fields && meta.fields[fieldId];
    let payloadValue = value;
    if (fieldMeta && fieldMeta.schema) {
      if (fieldMeta.schema.type === 'option') {
        payloadValue = { value };
      } else if (fieldMeta.schema.type === 'array' && fieldMeta.schema.items === 'option') {
        payloadValue = [{ value }];
      } else if (fieldMeta.schema.type === 'array') {
        payloadValue = [value];
      }
    }

    await jiraFetch(`/rest/api/2/issue/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ fields: { [fieldId]: payloadValue } }),
    });

    res.json({ ok: true, key, newStatus: value, mode: 'field-edit' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.body });
  }
});

app.listen(PORT, () => {
  console.log(`Jira migration dashboard running on http://localhost:${PORT}`);
  if (JIRA_AUTH_MODE === 'oauth') {
    console.log(
      tokenStore && tokenStore.accessToken
        ? `Already connected to Jira site: ${tokenStore.siteUrl}`
        : `Not yet connected — visit http://localhost:${PORT}/oauth/login to connect.`
    );
  }
});
