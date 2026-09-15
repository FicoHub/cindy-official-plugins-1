import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../google-gmail/main.js', import.meta.url), 'utf8');
const encoded = (value) => Buffer.from(value).toString('base64url');
const json = (value) => JSON.parse(JSON.stringify(value));
const attachment = (filename, bytes, extra = {}) => ({
  filename, mimeType: 'application/octet-stream',
  body: { size: Buffer.byteLength(bytes), data: encoded(bytes) }, ...extra,
});
function harness(payload, { responses = [], rejectWrite = false, accounts, throwDownload = false } = {}) {
  let handler;
  const calls = [], writes = [], results = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'gmail-test-'));
  const context = createContext({
    TextEncoder, TextDecoder, atob, btoa, crypto: webcrypto,
    fetch: async () => ({ ok: true, json: async () => [{ key: 'gmail_account', clientConfigured: true,
      accounts: accounts || [{ id: 'account-a', label: 'a@example.test', status: 'connected', isDefault: true }] }] }),
    cindy: {
      onHostMessage: (fn) => { handler = fn; },
      fetch: async (req) => {
        calls.push(json(req));
        if (calls.length === 1) return { ok: true, status: 200, body: JSON.stringify({ id: 'message', payload }) };
        if (throwDownload) throw new Error('Network interrupted');
        return responses.shift() || { ok: true, status: 200, body: JSON.stringify({ size: 3, data: encoded('log') }) };
      },
      send: async (req) => {
        if (req.type === 'tool-result') { results.push(json(req)); return; }
        writes.push(json(req));
        if (rejectWrite) return { ok: false, message: '当前任务禁止写入' };
        const target = path.join(dir, req.path);
        mkdirSync(path.dirname(target), { recursive: true });
        const bytes = Buffer.from(req.content, 'base64');
        writeFileSync(target, bytes);
        return { ok: true, path: req.path, bytes: bytes.length };
      },
    },
  });
  runInContext(source, context);
  return { calls, writes, results, dir, context,
    run: async (args) => { await handler({ type: 'tool-call', tool: 'gmail', args: { message_id: 'message', ...args }, callId: 'live-call' }); return results.at(-1); },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function fixture() {
  return { mimeType: 'multipart/mixed', parts: [
    attachment('first.txt', 'not the email', { mimeType: 'text/plain' }),
    { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: encoded('actual body') } }] },
    attachment('诊断.json', 'log', { body: { size: 3, attachmentId: 'remote/id?' } }),
    attachment('pixel.png', Buffer.from([0, 255, 128, 10]), { headers: [{ name: 'Content-ID', value: '<image>' }] }),
  ] };
}

test('read returns nested attachments without putting attachment text in the body or downloading', async () => {
  const h = harness(fixture());
  try {
    const r = await h.run({ action: 'read' });
    assert.equal(r.ok, true); assert.equal(r.result.body, 'actual body');
    assert.equal(r.result.attachments.length, 3); assert.equal(r.result.attachments[2].inline, true);
    assert.equal(h.calls.length, 1); assert.equal(h.writes.length, 0);
    assert.equal(r.result.account, 'account-a');
  } finally { h.close(); }
});

test('read downloads remote and embedded files byte-for-byte, pins account and uses live host call', async () => {
  const h = harness(fixture());
  try {
    const r = await h.run({ action: 'read', download_attachments: true });
    assert.equal(r.result.downloads.complete, true);
    assert.deepEqual(h.calls.map((c) => c.authAccount), ['account-a', 'account-a']);
    assert.ok(h.calls[1].url.endsWith('/attachments/remote%2Fid%3F'));
    assert.equal(h.calls[1].callId, 'live-call');
    const files = r.result.downloads.files;
    assert.equal(readFileSync(path.join(h.dir, files[1].path), 'utf8'), 'log');
    assert.deepEqual(readFileSync(path.join(h.dir, files[2].path)), Buffer.from([0, 255, 128, 10]));
    assert.ok(h.writes.every((w) => w.callId === 'live-call' && w.root === 'workdir'));
    assert.ok(!JSON.stringify(r).includes('content')); // No byte payload in model result.
  } finally { h.close(); }
});

test('select attachments by returned id and honor host save ticket, preserving explicit account', async () => {
  const h = harness(fixture());
  try {
    const r = await h.run({ action: 'download_attachments', account: 'account-b', attachment_ids: ['part-0-2'], save_deposit: { token: 'host-ticket' } });
    assert.equal(r.result.files.length, 1); assert.equal(r.result.complete, true);
    assert.ok(h.calls.every((c) => c.authAccount === 'account-b'));
    assert.equal(h.writes[0].root, 'save'); assert.equal(h.writes[0].token, 'host-ticket');
  } finally { h.close(); }
});

test('invalid selection fails before file writes', async () => {
  for (const ids of [[], ['missing'], 'part-0-0', [null]]) {
    const h = harness(fixture());
    try { assert.equal((await h.run({ action: 'download_attachments', attachment_ids: ids })).ok, false); assert.equal(h.writes.length, 0); }
    finally { h.close(); }
  }
});

test('truncated, invalid, mismatched, oversized and interrupted downloads never produce files', async () => {
  const cases = [
    { response: { ok: true, status: 200, truncated: true, body: '{}' } },
    { response: { ok: true, status: 200, body: JSON.stringify({ data: '!invalid', size: 3 }) } },
    { response: { ok: true, status: 200, body: JSON.stringify({ data: encoded('x'), size: 1 }) } },
    { response: { ok: true, status: 403, body: '{"error":{"message":"Permission denied"}}' } },
    { size: 16 * 1024 * 1024 + 1 }, { throwDownload: true },
  ];
  for (const c of cases) {
    const h = harness(attachment('log.json', 'log', { body: { size: c.size || 3, attachmentId: 'remote' } }), { responses: [c.response], throwDownload: c.throwDownload });
    try { const r = await h.run({ action: 'download_attachments' }); assert.equal(r.result.complete, false); assert.equal(r.result.files[0].status, 'failed'); assert.ok(r.result.files[0].error); assert.equal(h.writes.length, 0); }
    finally { h.close(); }
  }
});

test('partial batch keeps successful files and reports individual failures', async () => {
  const h = harness(fixture(), { throwDownload: true });
  try { const r = await h.run({ action: 'download_attachments' }); assert.equal(r.result.complete, false); assert.deepEqual(r.result.files.map((f) => f.status), ['downloaded', 'failed', 'downloaded']); }
  finally { h.close(); }
});

test('host write denial remains a failure, no fallback destination', async () => {
  const h = harness(attachment('log.json', 'log'), { rejectWrite: true });
  try { const r = await h.run({ action: 'download_attachments' }); assert.equal(r.result.complete, false); assert.match(r.result.files[0].error, /禁止写入/); assert.equal(h.writes.length, 1); }
  finally { h.close(); }
});

test('hostile and duplicate filenames use independent safe paths and preserve original labels', async () => {
  const h = harness({ parts: ['../../CON', 'NUL.txt', '.env', 'same.txt', 'same.txt', 'x\\y'].map((n) => attachment(n, 'x')) });
  try {
    const a = await h.run({ action: 'download_attachments' });
    assert.equal(a.result.complete, true);
    assert.equal(new Set(a.result.files.map((f) => f.path)).size, 6);
    for (const f of a.result.files) assert.ok(path.resolve(h.dir, f.path).startsWith(h.dir + path.sep));
    assert.equal(a.result.files[0].filename, '../../CON');
  } finally { h.close(); }
});

test('empty files and emails without attachments are successful, batch remainder is explicit', async () => {
  for (const [payload, count] of [[{ parts: [] }, 0], [attachment('empty.txt', ''), 1], [{ parts: Array.from({ length: 17 }, () => attachment('x', 'x')) }, 16]]) {
    const h = harness(payload);
    try { const r = await h.run({ action: 'download_attachments' }); assert.equal(r.result.files.length, count); assert.equal(r.result.complete, count !== 16); if (count === 16) assert.deepEqual(r.result.remaining_attachment_ids, ['part-0-16']); }
    finally { h.close(); }
  }
});

test('inline text remains body while unnamed CID binary parts appear as attachments', async () => {
  const h = harness({ parts: [
    { mimeType: 'text/plain', headers: [{ name: 'Content-Disposition', value: 'inline' }], body: { data: encoded('body') } },
    { mimeType: 'image/png', headers: [{ name: 'Content-ID', value: '<image>' }], body: { size: 1, data: encoded('x') } },
  ] });
  try { const r = await h.run({ action: 'read', download_attachments: true }); assert.equal(r.result.body, 'body'); assert.equal(r.result.attachments.length, 1); assert.equal(r.result.downloads.complete, true); }
  finally { h.close(); }
});

test('exact 16 MiB binary boundary is accepted and malformed encoding rejected before any write', () => {
  const h = harness({});
  try {
    const bytes = Buffer.alloc(16 * 1024 * 1024, 0xff);
    const result = h.context.attachmentBase64({ data: encoded(bytes), size: bytes.length }, bytes.length);
    assert.deepEqual(Buffer.from(result.content, 'base64'), bytes);
    for (const data of ['a', 'Zh', '!!']) assert.throws(() => h.context.attachmentBase64({ data }, null));
  } finally { h.close(); }
});

test('default account cannot change after metadata request, and repeated workdir downloads never overwrite', async () => {
  const accounts = [{ id: 'first', label: 'a@example.test', status: 'connected', isDefault: true }, { id: 'second', label: 'b@example.test', status: 'connected', isDefault: false }];
  const h = harness(attachment('log', 'log', { body: { size: 3, attachmentId: 'remote' } }), { accounts });
  try {
    const original = h.context.cindy.fetch;
    h.context.cindy.fetch = async (req) => { const r = await original(req); accounts[0].isDefault = false; accounts[1].isDefault = true; return r; };
    await h.run({ action: 'download_attachments' });
    assert.deepEqual(h.calls.map((c) => c.authAccount), ['first', 'first']);
  } finally { h.close(); }
  const repeat = harness(attachment('log', 'log'));
  try {
    const first = await repeat.run({ action: 'download_attachments', account: 'first' });
    // Reuse the same Gmail metadata on the second request.
    repeat.context.cindy.fetch = async () => ({ ok: true, status: 200, body: JSON.stringify({ id: 'message', payload: attachment('log', 'log') }) });
    const second = await repeat.run({ action: 'download_attachments', account: 'first' });
    assert.notEqual(first.result.files[0].path, second.result.files[0].path);
    assert.equal(readFileSync(path.join(repeat.dir, first.result.files[0].path), 'utf8'), 'log');
  } finally { repeat.close(); }
});
