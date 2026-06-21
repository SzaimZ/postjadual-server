// PostJadual Notification Server
// Deploy ke Render.com (percuma)
// Node.js — hantar Telegram notification pada masa yang tepat

const https = require('https');
const http  = require('http');

// ============================================================
// IN-MEMORY STORE (cukup untuk 1 pengguna, 15 notif/hari)
// ============================================================
let schedules = {}; // { postId: scheduleObj }

// ============================================================
// TELEGRAM SENDER
// ============================================================
function tgSend(token, chatId, text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ ok: false }); }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.write(body);
    req.end();
  });
}

// ============================================================
// SCHEDULER — check every 15 seconds
// ============================================================
setInterval(async () => {
  const now = Date.now();
  for (const [postId, sch] of Object.entries(schedules)) {
    try {
      // Main notification
      if (!sch.sentMain && sch.fireAt <= now) {
        const r = await tgSend(sch.token, sch.chatId, sch.msg);
        if (r.ok) {
          sch.sentMain = true;
          sch.mainSentAt = now;
          console.log(`[${new Date().toISOString()}] SENT main for post ${postId}`);
        }
      }
      // Reminder 1
      if (sch.sentMain && !sch.sentRemind1 && sch.remind1Mins > 0) {
        const remind1At = sch.mainSentAt + sch.remind1Mins * 60000;
        if (remind1At <= now) {
          const r = await tgSend(sch.token, sch.chatId, sch.remind1Msg);
          if (r.ok) {
            sch.sentRemind1 = true;
            console.log(`[${new Date().toISOString()}] SENT remind1 for post ${postId}`);
          }
        }
      }
      // Reminder 2
      if (sch.sentMain && !sch.sentRemind2 && sch.remind2Mins > 0) {
        const remind2At = sch.mainSentAt + sch.remind2Mins * 60000;
        if (remind2At <= now) {
          const r = await tgSend(sch.token, sch.chatId, sch.remind2Msg);
          if (r.ok) {
            sch.sentRemind2 = true;
            console.log(`[${new Date().toISOString()}] SENT remind2 for post ${postId}`);
          }
        }
      }
      // Cleanup old schedules (>24h after main sent)
      if (sch.sentMain && sch.mainSentAt && (now - sch.mainSentAt) > 86400000) {
        delete schedules[postId];
      }
    } catch(e) {
      console.error(`Scheduler error for ${postId}:`, e.message);
    }
  }
}, 15000);

// ============================================================
// HTTP SERVER — receive schedule requests from PWA
// ============================================================
const server = http.createServer((req, res) => {
  // CORS — allow PWA from any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  // Parse URL
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // ---- GET /health — uptime check ----
  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      time: new Date().toISOString(),
      pending: Object.keys(schedules).length
    }));
    return;
  }

  // ---- POST /schedule — add new notification schedule ----
  if (req.method === 'POST' && path === '/schedule') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        // Validate required fields
        if (!data.token || !data.chatId || !data.postId || !data.fireAt || !data.msg) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Missing required fields' }));
          return;
        }
        // Save schedule
        schedules[data.postId] = {
          token:       data.token,
          chatId:      data.chatId,
          fireAt:      data.fireAt,       // timestamp ms
          msg:         data.msg,
          remind1Msg:  data.remind1Msg || '',
          remind2Msg:  data.remind2Msg || '',
          remind1Mins: data.remind1Mins || 0,
          remind2Mins: data.remind2Mins || 0,
          sentMain:    false,
          sentRemind1: false,
          sentRemind2: false,
          mainSentAt:  null,
        };
        console.log(`[${new Date().toISOString()}] SCHEDULED post ${data.postId} for ${new Date(data.fireAt).toISOString()}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, postId: data.postId }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ---- DELETE /schedule/:postId — cancel a notification ----
  if (req.method === 'DELETE' && path.startsWith('/schedule/')) {
    const postId = path.replace('/schedule/', '');
    if (schedules[postId]) {
      delete schedules[postId];
      console.log(`[${new Date().toISOString()}] CANCELLED post ${postId}`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ---- GET /schedules — list all pending (debug) ----
  if (req.method === 'GET' && path === '/schedules') {
    const list = Object.entries(schedules).map(([id, s]) => ({
      postId: id,
      fireAt: new Date(s.fireAt).toISOString(),
      sentMain: s.sentMain,
      sentRemind1: s.sentRemind1,
      sentRemind2: s.sentRemind2,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: list.length, schedules: list }));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`PostJadual Notification Server running on port ${PORT}`);
  console.log(`Started at: ${new Date().toISOString()}`);
});

// Keep-alive ping to prevent Render free tier sleep
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    const url = new URL(process.env.RENDER_EXTERNAL_URL);
    https.get({ hostname: url.hostname, path: '/health', headers: { 'User-Agent': 'PostJadual-KeepAlive' } }, () => {
      console.log(`[${new Date().toISOString()}] Keep-alive ping sent`);
    }).on('error', () => {});
  }, 14 * 60 * 1000); // every 14 minutes
}
