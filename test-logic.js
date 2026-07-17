// Standalone smoke test for the core Jira-integration logic in server.js,
// using a mocked global.fetch (no real network / npm deps required).
// Run with: node test-logic.js

const JIRA_BASE_URL = 'https://jira.mock.local';
const STATUS_FIELD_NAME = 'Current Status';

const mockFieldsList = [
  { id: 'status', name: 'Status' },
  { id: 'customfield_10050', name: 'Current Status' },
  { id: 'summary', name: 'Summary' },
];

const mockSearchResponse = {
  total: 2,
  startAt: 0,
  maxResults: 100,
  issues: [
    {
      key: 'MIG-1',
      fields: {
        summary: 'Migrate customer_orders table',
        status: { name: 'In Progress' },
        assignee: { displayName: 'Alex Doe' },
        updated: '2026-07-01T10:00:00.000Z',
        customfield_10050: { value: 'In Progress' },
      },
    },
    {
      key: 'MIG-2',
      fields: {
        summary: 'Migrate billing_events table',
        status: { name: 'Done' },
        assignee: null,
        updated: '2026-07-10T09:00:00.000Z',
        customfield_10050: { value: 'Migrated' },
      },
    },
  ],
};

const mockEditMeta = {
  fields: {
    customfield_10050: {
      schema: { type: 'option' },
      allowedValues: [
        { id: '1', value: 'Not Started' },
        { id: '2', value: 'In Progress' },
        { id: '3', value: 'Migrated' },
        { id: '4', value: 'Verified' },
      ],
    },
  },
};

let putCalls = [];

global.fetch = async (url, options = {}) => {
  const method = options.method || 'GET';
  if (url.endsWith('/rest/api/2/field')) {
    return jsonResponse(mockFieldsList);
  }
  if (url.endsWith('/rest/api/2/search') && method === 'POST') {
    return jsonResponse(mockSearchResponse);
  }
  if (url.includes('/editmeta')) {
    return jsonResponse(mockEditMeta);
  }
  if (url.match(/\/rest\/api\/2\/issue\/MIG-1$/) && method === 'PUT') {
    putCalls.push(JSON.parse(options.body));
    return jsonResponse(null);
  }
  throw new Error('Unmocked fetch: ' + method + ' ' + url);
};

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
  };
}

// --- Recreate the pure logic pieces from server.js for testing ---

async function jiraFetch(pathname, options = {}) {
  const url = `${JIRA_BASE_URL}${pathname}`;
  const res = await fetch(url, options);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

let cachedFieldId = null;
async function resolveStatusFieldId() {
  if (cachedFieldId) return cachedFieldId;
  const fields = await jiraFetch('/rest/api/2/field');
  const match = fields.find((f) => f.name.trim().toLowerCase() === STATUS_FIELD_NAME.trim().toLowerCase());
  if (!match) throw new Error('Field not found');
  cachedFieldId = match.id;
  return cachedFieldId;
}

async function getTickets() {
  const fieldId = await resolveStatusFieldId();
  const data = await jiraFetch('/rest/api/2/search', { method: 'POST', body: '{}' });
  return data.issues.map((issue) => {
    const raw = issue.fields[fieldId];
    const migrationStatus = raw && typeof raw === 'object' ? raw.value : raw;
    return {
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status ? issue.fields.status.name : null,
      assignee: issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned',
      migrationStatus,
    };
  });
}

async function updateTicket(key, value) {
  const fieldId = await resolveStatusFieldId();
  const meta = await jiraFetch(`/rest/api/2/issue/${key}/editmeta`);
  const fieldMeta = meta.fields[fieldId];
  let payloadValue = value;
  if (fieldMeta.schema.type === 'option') payloadValue = { value };
  await jiraFetch(`/rest/api/2/issue/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ fields: { [fieldId]: payloadValue } }),
  });
}

// --- Run assertions ---

(async () => {
  const fieldId = await resolveStatusFieldId();
  assert(fieldId === 'customfield_10050', `field discovery: expected customfield_10050, got ${fieldId}`);

  const tickets = await getTickets();
  assert(tickets.length === 2, 'ticket count should be 2');
  assert(tickets[0].key === 'MIG-1', 'first ticket key');
  assert(tickets[0].migrationStatus === 'In Progress', 'migration status extracted from {value} object');
  assert(tickets[1].assignee === 'Unassigned', 'null assignee falls back to Unassigned');
  assert(tickets[1].migrationStatus === 'Migrated', 'second ticket migration status');

  await updateTicket('MIG-1', 'Verified');
  assert(putCalls.length === 1, 'PUT should be called once');
  assert(
    JSON.stringify(putCalls[0]) === JSON.stringify({ fields: { customfield_10050: { value: 'Verified' } } }),
    'PUT payload should wrap value in {value} for option-type field, got ' + JSON.stringify(putCalls[0])
  );

  console.log('ALL CHECKS PASSED');
})().catch((err) => {
  console.error('TEST FAILED:', err.message);
  process.exit(1);
});

function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
}
