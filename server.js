const https = require('https');
const http  = require('http');

// ============================================================
// STORE
// ============================================================
const schedules = {};

// ============================================================
// TELEGRAM
// ============================================================
function tgSend(token, chatId, text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ ok: false }); }
      });
    });
    req.on('error', e => {
      console.error('tgSend error:', e.message);
      resolve({ ok: false });
    });
    req.write(body);
    req.end();
  });
}

// ============================================================
// SCHEDULER — every 15 seconds
// ============================================================
setInterval(async () => {
  const now = Date.now();
  for (const [postId, sch] of Object.entries(schedules)) {
    try {
      if (!sch.sentMain && sch.fireAt <= now) {
        const r = await tgSend(sch.token, sch.chatId, sch.msg);
        if (r.ok) {
          sch.sentMain   = true;
          sch.mainSentAt = now;
          console.log(`SENT main: ${postId}`);
        }
      }
      if (sch.sentMain && !sch.sentRemind1 && sch.remind1Mins > 0) {
        if ((sch.mainSentAt + sch.remind1Mins * 60000) <= now) {
          const r = await tgSend(sch.token, sch.chatId, sch.remind1Msg);
          if (r.ok) { sch.sentRemind1 = true; console.log(`SENT remind1: ${postId}`); }
        }
      }
      if (sch.sentMain && !sch.sentRemind2 && sch.remind2Mins > 0) {
        if ((sch.mainSentAt + sch.remind2Mins * 60000) <= now) {
          const r = await tgSend(sch.token, sch.chatId, sch.remind2Msg);
          if (r.ok) { sch.sentRemind2 = true; console.log(`SENT remind2: ${postId}`); }
        }
      }
      // Cleanup after 24h
      if (sch.sentMain && (now - sch.mainSentAt) > 86400000) {
        delete schedules[postId];
        console.log(`CLEANED: ${postId}`);
      }
    } catch(e) {
      console.error(`Scheduler error ${postId}:`, e.message);
    }
  }
}, 15000);

// ============================================================
// CORS helper
// ============================================================
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });
}

// ============================================================
// HTTP SERVER
// ============================================================
const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const path = req.url.split('?')[0];
  const json = (data, status) => {
    res.writeHead(status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // GET /health
  if (req.method === 'GET' && path === '/health') {
    json({ ok: true, time: new Date().toISOString(), pending: Object.keys(schedules).length });
    return;
  }

  // GET /
  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('PostJadual Notification Server running.');
    return;
  }

  // POST /schedule
  if (req.method === 'POST' && path === '/schedule') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      if (!data.token || !data.chatId || !data.postId || !data.fireAt || !data.msg) {
        json({ ok: false, error: 'Missing fields: token, chatId, postId, fireAt, msg' }, 400);
        return;
      }
      schedules[data.postId] = {
        token:       data.token,
        chatId:      String(data.chatId),
        fireAt:      Number(data.fireAt),
        msg:         data.msg,
        remind1Msg:  data.remind1Msg || '',
        remind2Msg:  data.remind2Msg || '',
        remind1Mins: Number(data.remind1Mins) || 0,
        remind2Mins: Number(data.remind2Mins) || 0,
        sentMain:    false,
        sentRemind1: false,
        sentRemind2: false,
        mainSentAt:  null,
      };
      console.log(`SCHEDULED: ${data.postId} at ${new Date(data.fireAt).toISOString()}`);
      json({ ok: true, postId: data.postId });
    } catch(e) {
      json({ ok: false, error: e.message }, 400);
    }
    return;
  }

  // DELETE /schedule/:postId
  if (req.method === 'DELETE' && path.startsWith('/schedule/')) {
    const postId = path.replace('/schedule/', '');
    delete schedules[postId];
    console.log(`CANCELLED: ${postId}`);
    json({ ok: true });
    return;
  }

  // GET /schedules (debug)
  if (req.method === 'GET' && path === '/schedules') {
    const list = Object.entries(schedules).map(([id, s]) => ({
      postId:     id,
      fireAt:     new Date(s.fireAt).toISOString(),
      sentMain:   s.sentMain,
      sentRemind1:s.sentRemind1,
      sentRemind2:s.sentRemind2,
    }));
    json({ ok: true, count: list.length, schedules: list });
    return;
  }

  json({ ok: false, error: 'Not found' }, 404);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`PostJadual Server listening on 0.0.0.0:${PORT}`);
  console.log(`Started: ${new Date().toISOString()}`);
});

server.on('error', e => {
  console.error('Server error:', e.message);
  process.exit(1);
});

// Keep-alive ping (prevent Render free tier sleep)
const selfUrl = process.env.RENDER_EXTERNAL_URL;
if (selfUrl) {
  setInterval(() => {
    const u = new URL(selfUrl + '/health');
    https.get({ hostname: u.hostname, path: u.pathname, headers: { 'User-Agent': 'keepalive' } },
      r => r.resume()
    ).on('error', () => {});
    console.log('Keep-alive ping');
  }, 14 * 60 * 1000);
}
