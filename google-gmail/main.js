/* global cindy, crypto */

var SECRET_KEY = 'gmail_account';
var PLUGIN_NAME = 'Gmail';
var BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

function fail(message) {
  return { ok: false, message: message };
}

function clampInt(value, fallback, max) {
  var n = typeof value === 'number' && isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(1, n));
}

async function api(opts) {
  var request = {
    url: opts.url,
    method: opts.method || 'GET',
    headers: { Accept: 'application/json' },
    callId: opts.callId,
  };
  if (opts.account) request.authAccount = opts.account;
  if (opts.body !== undefined) {
    request.headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(opts.body);
  }
  var response = await cindy.fetch(request);
  if (!response.ok) return { err: response.message || 'Gmail 请求失败，请检查连接状态' };
  if (response.truncated) return { err: 'Gmail 响应超过客户端上限，结果不完整；若为发送或创建草稿，请先检查 Gmail 中的实际状态' };
  var data = null;
  if (response.body) {
    try {
      data = JSON.parse(response.body);
    } catch (_err) {
      return { err: 'Google 返回了无法解析的响应(HTTP ' + response.status + ')' };
    }
  }
  if (response.status < 200 || response.status >= 300) {
    var message = data && data.error && data.error.message
      ? data.error.message
      : (response.body || '').slice(0, 200);
    return { err: 'Gmail API 返回 HTTP ' + response.status + ':' + message };
  }
  return { data: data };
}

async function listAccounts() {
  var response = await fetch('/oauth');
  if (!response.ok) return fail('账号状态查询失败(' + response.status + ')');
  var list = await response.json();
  var entry = list.find(function (item) { return item && item.key === SECRET_KEY; });
  if (!entry || !entry.clientConfigured) {
    return fail('内置应用身份缺失，请升级 Cindy 后重试');
  }
  if (!entry.accounts.length) {
    return fail('尚未连接 Gmail 账号，请到「' + PLUGIN_NAME + '」详情页单独授权');
  }
  return {
    ok: true,
    result: {
      accounts: entry.accounts.map(function (account) {
        return {
          id: account.id,
          email: account.label,
          status: account.status,
          is_default: account.isDefault,
        };
      }),
    },
  };
}

function b64urlUtf8(text) {
  var bytes = new TextEncoder().encode(text);
  var binary = '';
  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function utf8FromB64url(value) {
  var binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function encodeHeaderWord(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return '=?UTF-8?B?' + b64urlUtf8(text).replace(/-/g, '+').replace(/_/g, '/') + '?=';
}

function header(message, name) {
  var headers = (message.payload && message.payload.headers) || [];
  for (var i = 0; i < headers.length; i++) {
    if (headers[i].name.toLowerCase() === name.toLowerCase()) return headers[i].value;
  }
  return '';
}

function extractBody(payload) {
  if (!payload) return '';
  var queue = [payload];
  var htmlFallback = '';
  while (queue.length) {
    var part = queue.shift();
    if (isAttachment(part)) continue;
    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      return utf8FromB64url(part.body.data);
    }
    if (part.mimeType === 'text/html' && part.body && part.body.data && !htmlFallback) {
      htmlFallback = utf8FromB64url(part.body.data)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    if (part.parts) {
      for (var i = 0; i < part.parts.length; i++) queue.push(part.parts[i]);
    }
  }
  return htmlFallback;
}

// Gmail MIME part references remain stable across reads, including parts without partId.
function partHeader(part, name) {
  return header({ payload: part }, name);
}

function isAttachment(part) {
  var disposition = partHeader(part, 'Content-Disposition');
  return Boolean(part.filename || /^attachment(?:;|$)/i.test(disposition) ||
    ((/^inline(?:;|$)/i.test(disposition) || partHeader(part, 'Content-ID')) &&
      !/^text\/(plain|html)$/i.test(part.mimeType || '')) ||
    (part.body && part.body.attachmentId && !/^text\/(plain|html)$/i.test(part.mimeType || '')));
}

function attachmentParts(payload) {
  var found = [];
  function visit(part, id) {
    if (!part) return;
    if (isAttachment(part)) {
      found.push({
        view: {
          id: id, part_id: part.partId || '', filename: part.filename || 'attachment',
          mime_type: part.mimeType || 'application/octet-stream',
          size: part.body && Number.isSafeInteger(part.body.size) ? part.body.size : null,
          inline: /^inline(?:;|$)/i.test(partHeader(part, 'Content-Disposition')) ||
            Boolean(partHeader(part, 'Content-ID')),
        },
        body: part.body || {},
      });
      return; // An attached message is one file, not additional top-level attachments.
    }
    (part.parts || []).forEach(function (child, index) { visit(child, id + '-' + index); });
  }
  visit(payload, 'part-0');
  return found;
}

function attachmentBase64(body, expectedSize) {
  if (!body || typeof body.data !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(body.data)) {
    throw new Error('附件内容缺失或编码无效，未保存文件');
  }
  var encoded = body.data.replace(/=+$/, '');
  var size = Math.floor(encoded.length * 3 / 4);
  if (encoded.length % 4 === 1 || size > 16 * 1024 * 1024) {
    throw new Error('附件编码无效或超过当前单文件 16 MiB 下载上限，未保存文件');
  }
  if ((expectedSize !== null && expectedSize !== size) ||
      (body.size !== undefined && body.size !== size)) {
    throw new Error('附件长度与邮件记录不一致，未保存不完整文件');
  }
  var base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  base64 += '='.repeat((4 - base64.length % 4) % 4);
  // Decode before writing, preserving binary bytes and rejecting noncanonical padding bits.
  if (btoa(atob(base64)) !== base64) throw new Error('附件编码无效，未保存文件');
  return { content: base64, size: size };
}

async function downloadAttachments(parts, args, account, callId) {
  if (args.attachment_ids !== undefined && (!Array.isArray(args.attachment_ids) ||
      !args.attachment_ids.length || args.attachment_ids.some(function (id) {
        return typeof id !== 'string' || !parts.some(function (part) { return part.view.id === id; });
      }))) return fail('attachment_ids 必须使用 read 返回的非空附件 id 列表');
  var selected = parts.filter(function (part) {
    return !args.attachment_ids || args.attachment_ids.indexOf(part.view.id) !== -1;
  });
  var files = [];
  var nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  var directory = 'gmail-attachments/' + Array.from(nonce, function (byte) {
    return byte.toString(16).padStart(2, '0');
  }).join('');
  // Bound each batch; callers get the remaining IDs rather than losing them silently.
  for (var i = 0; i < Math.min(selected.length, 16); i++) {
    var part = selected[i];
    var file = Object.assign({}, part.view, { status: 'failed' });
    try {
      if (part.view.size !== null && part.view.size > 16 * 1024 * 1024) {
        throw new Error('附件超过当前单文件 16 MiB 下载上限，未保存文件');
      }
      var body = part.body;
      if (body.attachmentId) {
        var response = await api({
          url: BASE + '/messages/' + encodeURIComponent(args.message_id) +
            '/attachments/' + encodeURIComponent(body.attachmentId),
          account: account, callId: callId,
        });
        if (response.err) throw new Error(response.err);
        body = response.data;
      }
      var bytes = attachmentBase64(body, part.view.size);
      // Remote filenames are labels, never paths. Prefix defeats dotfiles and Windows devices.
      var name = 'file-' + i + '-' + part.view.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 100).replace(/\.+$/, '_');
      var request = {
        type: 'fs-request', op: 'write', root: 'workdir', callId: callId,
        path: directory + '/' + name, encoding: 'base64', content: bytes.content,
      };
      if (args.save_deposit && args.save_deposit.token) {
        request.root = 'save';
        request.token = args.save_deposit.token;
        request.path = name;
      }
      var written = await cindy.send(request);
      if (!written || !written.ok) throw new Error(written && written.message || '文件保存失败，请检查当前任务写入权限');
      if (written.bytes !== bytes.size || typeof written.path !== 'string') {
        throw new Error('文件写入结果无法核实，请检查目标目录后再试');
      }
      file.status = 'downloaded';
      file.path = written.path;
      file.root = request.root;
      file.bytes = written.bytes;
    } catch (error) {
      file.error = error && error.message || '附件下载失败，请检查账号及网络状态';
    }
    files.push(file);
  }
  var remaining = selected.slice(16).map(function (part) { return part.view.id; });
  return { ok: true, result: {
    files: files, remaining_attachment_ids: remaining,
    complete: !remaining.length && files.every(function (file) { return file.status === 'downloaded'; }),
  } };
}

async function gmail(args, callId) {
  var account = args.account;
  if (args.action === 'search') {
    if (!args.query) return fail('search 需要 query(Gmail 搜索语法)');
    var listed = await api({
      url: BASE + '/messages?q=' + encodeURIComponent(args.query) +
        '&maxResults=' + clampInt(args.max_results, 5, 10),
      account: account,
      callId: callId,
    });
    if (listed.err) return fail(listed.err);
    var ids = (listed.data && listed.data.messages) || [];
    var messages = [];
    for (var i = 0; i < ids.length; i++) {
      var metadata = await api({
        url: BASE + '/messages/' + ids[i].id +
          '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date',
        account: account,
        callId: callId,
      });
      if (metadata.err) return fail(metadata.err);
      messages.push({
        id: ids[i].id,
        from: header(metadata.data, 'From'),
        subject: header(metadata.data, 'Subject'),
        date: header(metadata.data, 'Date'),
        snippet: metadata.data.snippet || '',
      });
    }
    return {
      ok: true,
      result: {
        total_estimate: (listed.data && listed.data.resultSizeEstimate) || messages.length,
        messages: messages,
      },
    };
  }

  if (args.action === 'read' || args.action === 'download_attachments') {
    if (!args.message_id) return fail('read 需要 message_id');
    // Pin the default once so a settings change cannot switch accounts mid-download.
    if (!account) {
      var connected = await listAccounts();
      if (!connected.ok) return connected;
      var defaultAccount = connected.result.accounts.find(function (item) { return item.is_default; });
      if (!defaultAccount) return fail('请选择 Gmail 账号后重试');
      account = defaultAccount.id;
    }
    var full = await api({
      url: BASE + '/messages/' + encodeURIComponent(args.message_id) + '?format=full',
      account: account,
      callId: callId,
    });
    if (full.err) return fail(full.err);
    if (!full.data || !full.data.payload) return fail('邮件内容缺失，无法判断附件，请重新读取');
    var parts = attachmentParts(full.data.payload);
    var body = args.action === 'read' ? extractBody(full.data.payload) : '';
    var downloads;
    if (args.action === 'download_attachments' || args.download_attachments === true) {
      downloads = await downloadAttachments(parts, args, account, callId);
      if (!downloads.ok) return downloads;
    }
    if (args.action === 'download_attachments') {
      return { ok: true, result: Object.assign({ message_id: args.message_id, account: account }, downloads.result) };
    }
    return {
      ok: true,
      result: {
        id: full.data.id,
        account: account,
        attachments: parts.map(function (part) { return part.view; }),
        downloads: downloads ? downloads.result : undefined,
        from: header(full.data, 'From'),
        to: header(full.data, 'To'),
        subject: header(full.data, 'Subject'),
        date: header(full.data, 'Date'),
        body: body.length > 20000 ? body.slice(0, 20000) + '\n…(正文过长已截断)' : body,
      },
    };
  }

  if (args.action === 'list_labels') {
    var labels = await api({ url: BASE + '/labels', account: account, callId: callId });
    if (labels.err) return fail(labels.err);
    return {
      ok: true,
      result: {
        labels: ((labels.data && labels.data.labels) || []).map(function (label) {
          return { id: label.id, name: label.name, type: label.type };
        }),
      },
    };
  }

  if (args.action === 'modify_labels') {
    return fail('Insufficient permissions. Please wait for a future plugin update.');
  }

  if (args.action === 'send' || args.action === 'draft') {
    if (!args.to || !args.subject || args.body_text === undefined) {
      return fail(args.action + ' 需要 to / subject / body_text');
    }
    if (/[\r\n]/.test(String(args.to))) {
      return fail('to 不得包含换行符');
    }
    if (/[\r\n]/.test(String(args.subject))) {
      return fail('subject 不得包含换行符');
    }
    var recipient = String(args.to).trim();
    if (!recipient) return fail('to 不能为空');
    var mime =
      'To: ' + recipient + '\r\n' +
      'Subject: ' + encodeHeaderWord(args.subject) + '\r\n' +
      'Content-Type: text/plain; charset=UTF-8\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      b64urlUtf8(args.body_text).replace(/-/g, '+').replace(/_/g, '/');
    var raw = b64urlUtf8(mime);
    if (args.action === 'send') {
      var sent = await api({
        url: BASE + '/messages/send',
        method: 'POST',
        body: { raw: raw },
        account: account,
        callId: callId,
      });
      if (sent.err) return fail(sent.err);
      return { ok: true, result: { sent: true, id: sent.data.id } };
    }
    var draft = await api({
      url: BASE + '/drafts',
      method: 'POST',
      body: { message: { raw: raw } },
      account: account,
      callId: callId,
    });
    if (draft.err) return fail(draft.err);
    return { ok: true, result: { draft: true, id: draft.data.id } };
  }

  return fail('未知 action:' + args.action);
}

cindy.onHostMessage(async function (message) {
  if (!message || message.type !== 'tool-call') return;
  try {
    var result = message.tool === 'gmail_accounts'
      ? await listAccounts()
      : message.tool === 'gmail'
        ? await gmail(message.args || {}, message.callId)
        : fail('未知工具:' + message.tool);
    if (result.ok) {
      cindy.send({ type: 'tool-result', callId: message.callId, ok: true, result: result.result });
    } else {
      cindy.send({ type: 'tool-result', callId: message.callId, ok: false, message: result.message });
    }
  } catch (error) {
    cindy.send({
      type: 'tool-result',
      callId: message.callId,
      ok: false,
      message: 'Gmail 工具执行失败:' + (error && error.message ? error.message : String(error)),
    });
  }
});
