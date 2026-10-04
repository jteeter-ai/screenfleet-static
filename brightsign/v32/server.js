'use strict';
// ScreenFleet BrightSign Player — Node server (v32)
// Runs on BrightSign OS 9.x (Node 18) via roNodeJs in autorun.brs.
// Owns: config, manifest polling, media caching to SD, static + API serving.
// The HTML widget loads from http://localhost:13131 so fetch() works normally —
// no config injection, no file:// limitations.
//
// Boot status is written to /storage/sd/sf-status.json so autorun.brs and any
// diagnostic can see exactly how far startup got.

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var urllib = require('url');

// ── Paths & constants ───────────────────────────────────────────────────────
var SD = '/storage/sd';                 // SD card root on BrightSign
var PORT = 13131;
var MEDIA_DIR = path.join(SD, 'media');
var MANIFEST_FILE = path.join(SD, 'sf-manifest.json');
var CONFIG_FILE = path.join(SD, 'config.json');
var STATUS_FILE = path.join(SD, 'sf-status.json');
var DEVICE_ID_FILE = path.join(SD, 'sf-device-id.json');
var PLAYER_VERSION = 'v32';
var HEARTBEAT_MS = 60000;

var MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.svg': 'image/svg+xml'
};

// ── In-memory state ─────────────────────────────────────────────────────────
var CFG = null;              // config.json contents
var manifest = null;        // current content manifest (payload)
var knownVersion = null;    // content_version we last rendered/cached
var pollTimer = null;
var heartbeatTimer = null;
var activationTimer = null;
var DEVICE_ID = null;        // stable per-card id (persisted on SD)
var activation = null;       // { status, activation_code, activate_url } for the page

// ── Status breadcrumb (survives for diagnostics) ────────────────────────────
function setStatus(stage, detail) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      stage: stage, detail: detail || '', ts: Date.now(), node: process.version
    }));
  } catch (e) { /* non-fatal */ }
  console.log('[SF-SRV] ' + stage + (detail ? ' — ' + detail : ''));
}

// ── Load config.json from SD ────────────────────────────────────────────────
function loadConfig() {
  try {
    CFG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    setStatus('config-loaded', 'screenId=' + (CFG.screenId || '') + ' token=' + (CFG.screenToken ? 'set' : 'empty'));
    return true;
  } catch (e) {
    setStatus('config-error', e.message);
    CFG = null;
    return false;
  }
}

// ── Load cached manifest from SD (offline-first) ────────────────────────────
function loadCachedManifest() {
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    knownVersion = manifest.content_version || null;
    setStatus('manifest-cached', 'version=' + knownVersion);
  } catch (e) {
    manifest = null;
    setStatus('manifest-none', 'no cached manifest yet');
  }
}

// ── Stable device id (persisted on the SD card) ─────────────────────────────
// A random UUID written to sf-device-id.json on first boot and reused every
// boot after. No banned hardware API (roDeviceInfo). Re-flashing the card mints
// a new id — acceptable, since a re-flash is a deliberate re-provision.
function genUuid() {
  try { return require('crypto').randomUUID(); } catch (e) {}
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
function loadOrCreateDeviceId() {
  try {
    var d = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, 'utf8'));
    if (d && d.device_id) return d.device_id;
  } catch (e) { /* create below */ }
  var id = 'bs-' + genUuid();
  try { fs.writeFileSync(DEVICE_ID_FILE, JSON.stringify({ device_id: id, created: Date.now() })); } catch (e) {}
  return id;
}

// ── HTTP(S) POST helper (returns Promise of parsed JSON) ────────────────────
function postJson(fullUrl, bodyObj) {
  return new Promise(function (resolve, reject) {
    var u = urllib.parse(fullUrl);
    var body = JSON.stringify(bodyObj);
    var lib = u.protocol === 'http:' ? http : https;
    var req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 20000
    }, function (res) {
      var chunks = '';
      res.on('data', function (c) { chunks += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(chunks)); }
        catch (e) { reject(new Error('bad JSON from ' + fullUrl)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(new Error('timeout ' + fullUrl)); });
    req.write(body);
    req.end();
  });
}

// ── Download one file to MEDIA_DIR (skips if already present) ────────────────
// base44.app media URLs return a 302 redirect to media.base44.com, so this
// MUST follow redirects (up to 5 hops) — a bare get() that only accepts 200
// silently drops every file and leaves the cache empty.
function downloadMedia(url, localName) {
  var dest = path.join(MEDIA_DIR, localName);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return Promise.resolve(true);
  var tmp = dest + '.part';

  function fetchTo(u, hops) {
    return new Promise(function (resolve) {
      if (hops > 5) { resolve(false); return; }
      var lib = u.indexOf('https:') === 0 ? https : http;
      var req = lib.get(u, function (res) {
        var sc = res.statusCode;
        // Follow 301/302/303/307/308 redirects.
        if (sc >= 300 && sc < 400 && res.headers.location) {
          res.resume(); // drain
          var next = res.headers.location;
          if (next.indexOf('http') !== 0) next = urllib.resolve(u, next);
          resolve(fetchTo(next, hops + 1));
          return;
        }
        if (sc !== 200) { res.resume(); resolve(false); return; }
        var file = fs.createWriteStream(tmp);
        res.pipe(file);
        file.on('finish', function () {
          file.close(function () {
            try { fs.renameSync(tmp, dest); resolve(true); }
            catch (e) { resolve(false); }
          });
        });
        file.on('error', function () { try { fs.unlinkSync(tmp); } catch (e) {} resolve(false); });
      });
      req.on('error', function () { try { fs.unlinkSync(tmp); } catch (e) {} resolve(false); });
      req.setTimeout(60000, function () { req.destroy(); try { fs.unlinkSync(tmp); } catch (e) {} resolve(false); });
    });
  }

  return fetchTo(url, 0);
}

// ── Cache every media file referenced by the manifest ───────────────────────
function cacheManifestMedia(mf) {
  try { if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) {}
  var items = (mf && mf.native_media_manifest) ? mf.native_media_manifest : [];
  var chain = Promise.resolve();
  var done = 0;
  items.forEach(function (it) {
    if (!it.url || !it.name) return;
    chain = chain.then(function () {
      return downloadMedia(it.url, it.name).then(function (ok) { if (ok) done++; });
    });
  });
  return chain.then(function () { setStatus('media-cached', done + '/' + items.length + ' files'); });
}

// ── Poll screenPayload, update cache + manifest when version changes ─────────
function pollContent() {
  if (!CFG || !CFG.screenId) return Promise.resolve();
  var origin = CFG.apiOrigin || 'https://app.screenfleet.io';
  var payloadFn = CFG.payloadFn || 'screenPayload';
  return postJson(origin + '/functions/' + payloadFn, { screenId: CFG.screenId, native_mode: true })
    .then(function (payload) {
      if (!payload || payload.status === 'error' || payload.status === 'no_published_state') {
        setStatus('poll-nocontent', payload ? payload.status : 'null');
        return;
      }
      if (payload.content_version && payload.content_version !== knownVersion) {
        setStatus('poll-newversion', payload.content_version);
        return cacheManifestMedia(payload).then(function () {
          try { fs.writeFileSync(MANIFEST_FILE, JSON.stringify(payload)); } catch (e) {}
          manifest = payload;
          knownVersion = payload.content_version;
          setStatus('manifest-updated', knownVersion);
        });
      } else {
        setStatus('poll-unchanged', knownVersion || '');
      }
    })
    .catch(function (e) { setStatus('poll-offline', e.message); });
}

// ── Activation flow (empty token → show code → poll → claim) ─────────────────
// Backend: registerPlayerDevice (get code) → operator claims in CMS →
// pollPlayerActivation returns screen_id + screen_public_token → we write them
// into config.json and switch straight to content. device_id is the credential.
function origin() { return (CFG && CFG.apiOrigin) || 'https://app.screenfleet.io'; }

function startActivation() {
  setStatus('activation-start', DEVICE_ID);
  postJson(origin() + '/functions/registerPlayerDevice', {
    device_id: DEVICE_ID, player_version: PLAYER_VERSION, player_type: 'brightsign'
  }).then(function (r) {
    if (r && r.status === 'claimed') { applyClaim(r); return; }
    activation = { status: 'pending', activation_code: r && r.activation_code, activate_url: r && r.activate_url };
    setStatus('activation-pending', activation.activation_code || '');
    if (activationTimer) clearInterval(activationTimer);
    activationTimer = setInterval(pollActivation, 5000);
  }).catch(function (e) {
    setStatus('activation-error', e.message);
    activation = { status: 'offline' };
    setTimeout(startActivation, 15000);   // retry registration when offline
  });
}

function pollActivation() {
  postJson(origin() + '/functions/pollPlayerActivation', { device_id: DEVICE_ID })
    .then(function (r) {
      if (!r) return;
      if (r.status === 'claimed') { if (activationTimer) clearInterval(activationTimer); applyClaim(r); }
      else if (r.status === 'upgrade_required') { activation = { status: 'upgrade_required' }; setStatus('activation-upgrade', ''); }
    })
    .catch(function (e) { setStatus('activation-poll-offline', e.message); });
}

function applyClaim(r) {
  if (!CFG) CFG = {};
  if (r.screen_id) CFG.screenId = r.screen_id;
  if (r.screen_public_token) CFG.screenToken = r.screen_public_token;
  CFG.activationMode = false;
  activation = { status: 'claimed', screenId: CFG.screenId };
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(CFG, null, 2)); } catch (e) {}
  setStatus('activation-claimed', CFG.screenId || '');
  // Start the content loop now that we have a screen.
  pollContent();
  if (!pollTimer) {
    var interval = (CFG && CFG.pollIntervalMs) ? CFG.pollIntervalMs : 60000;
    pollTimer = setInterval(pollContent, interval);
  }
}

// ── Heartbeat (last-seen + version reporting) ────────────────────────────────
function sendHeartbeat() {
  if (!CFG || (!CFG.screenToken && !CFG.screenId)) return;   // nothing to report yet
  postJson(origin() + '/functions/reportHeartbeat', {
    screen_token: CFG.screenToken || '',
    screen_id: CFG.screenId || '',
    content_version: knownVersion || null,
    player_version: PLAYER_VERSION
  }).then(function () { setStatus('heartbeat-ok', knownVersion || ''); })
    .catch(function (e) { setStatus('heartbeat-offline', e.message); });
}

// ── Safe content+config OTA for player FILES (guarded) ───────────────────────
// Fetches player.js / index.html / server.js from CFG.updateBaseUrl when
// CFG.otaEnabled is true, writes to a .next temp, verifies it is non-trivial
// and (for .js) brace-balanced, keeps the old file as .prev for rollback, then
// swaps. autorun.brs is NEVER self-updated here — a bad launcher can brick boot.
// This runs opportunistically; if anything looks wrong the live file is kept.
function otaUpdateFiles() {
  if (!CFG || !CFG.otaEnabled || !CFG.updateBaseUrl) return;
  var files = ['player.js', 'index.html', 'server.js'];
  files.forEach(function (name) {
    var url = CFG.updateBaseUrl.replace(/\/$/, '') + '/' + name + '?t=' + Date.now();
    httpGetText(url).then(function (text) {
      if (!text || text.length < 50) return;                 // too small = bad fetch
      if (name.slice(-3) === '.js' && !bracesBalanced(text)) return; // not valid JS
      var dest = path.join(SD, name);
      try {
        var cur = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
        if (cur === text) return;                            // unchanged
        fs.writeFileSync(dest + '.next', text);
        if (cur) fs.writeFileSync(dest + '.prev', cur);      // rollback copy
        fs.renameSync(dest + '.next', dest);
        setStatus('ota-updated', name + ' (restart to apply)');
      } catch (e) { setStatus('ota-error', name + ': ' + e.message); }
    }).catch(function () { /* offline / 404 — keep current file */ });
  });
}
function bracesBalanced(s) {
  var depth = 0;
  for (var i = 0; i < s.length; i++) { var c = s[i]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth < 0) return false; } }
  return depth === 0;
}
function httpGetText(url) {
  return new Promise(function (resolve, reject) {
    var lib = url.indexOf('https:') === 0 ? https : http;
    var req = lib.get(url, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); resolve(httpGetText(res.headers.location)); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      var body = ''; res.on('data', function (c) { body += c; }); res.on('end', function () { resolve(body); });
    });
    req.on('error', reject);
    req.setTimeout(30000, function () { req.destroy(new Error('timeout')); });
  });
}

// ── Static file serving from SD root ────────────────────────────────────────
function serveFile(res, filePath) {
  fs.readFile(filePath, function (err, data) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── HTTP server ──────────────────────────────────────────────────────────────
function startServer() {
  http.createServer(function (req, res) {
    var p = urllib.parse(req.url).pathname;

    // API: config (what player.js needs to know about this screen)
    if (p === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(CFG || {}));
      return;
    }
    // API: current manifest (the render payload)
    if (p === '/api/manifest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(manifest || { status: 'waiting', zones: [] }));
      return;
    }
    // API: activation state (the page shows the code/QR while pending)
    if (p === '/api/activation') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(activation || { status: 'none' }));
      return;
    }
    // API: force an immediate poll (used by player on demand / debugging)
    if (p === '/api/refresh') {
      pollContent().then(function () {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: knownVersion }));
      });
      return;
    }
    // Media: serve cached file from SD
    if (p.indexOf('/media/') === 0) {
      serveFile(res, path.join(MEDIA_DIR, p.slice('/media/'.length)));
      return;
    }
    // Static files from SD root
    if (p === '/') p = '/index.html';
    serveFile(res, path.join(SD, p));
  }).listen(PORT, function () {
    setStatus('server-listening', 'http://localhost:' + PORT);
  });
}

// ── Boot sequence ────────────────────────────────────────────────────────────
function main() {
  setStatus('node-start', process.version);
  loadConfig();
  loadCachedManifest();
  DEVICE_ID = loadOrCreateDeviceId();
  setStatus('device-id', DEVICE_ID);
  startServer();

  var interval = (CFG && CFG.pollIntervalMs) ? CFG.pollIntervalMs : 60000;

  if (CFG && CFG.screenId) {
    // Already provisioned → go straight to content.
    activation = { status: 'claimed', screenId: CFG.screenId };
    pollContent();
    pollTimer = setInterval(pollContent, interval);
  } else {
    // Activation mode: register the device and poll until an operator claims it.
    startActivation();
  }

  // Heartbeat + opportunistic file OTA run regardless of mode.
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
  otaUpdateFiles();
  setInterval(otaUpdateFiles, 6 * 60 * 60 * 1000);   // check for file updates every 6h
}

main();
