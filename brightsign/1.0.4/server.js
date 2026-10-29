'use strict';
// ScreenFleet BrightSign Player — Node server (1.0.0)
// Versioning: semantic versions (MAJOR.MINOR.PATCH) from 1.0.0 on; "v32" was the last legacy build.
// Runs on BrightSign OS 9.x/10.x (Node 18) via roNodeJs in autorun.brs.
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
var crypto = require('crypto');

// ── Paths & constants ───────────────────────────────────────────────────────
var SD = process.env.SF_SD || '/storage/sd';   // SD card root on BrightSign (SF_SD only for tests)
var PORT = Number(process.env.SF_PORT || 13131);
var MEDIA_DIR = path.join(SD, 'media');
var MANIFEST_FILE = path.join(SD, 'sf-manifest.json');
var CONFIG_FILE = path.join(SD, 'config.json');
var STATUS_FILE = path.join(SD, 'sf-status.json');
var DEVICE_ID_FILE = path.join(SD, 'sf-device-id.json');
var PLAYER_VERSION = '1.0.4';
var HEARTBEAT_MS = 60000;
var UPDATE_FILE = path.join(SD, 'sf-update.json');      // pending-update state (shared with autorun.brs)
var BOOT_FILE = path.join(SD, 'sf-boot.json');          // unhealthy-boot counter (shared with autorun.brs)
var LAUNCHER_FILE = path.join(SD, 'sf-launcher.json');  // written by autorun.brs
var STAGING_DIR = path.join(SD, 'sf-staging');
var PREV_DIR = path.join(SD, 'sf-prev');
var REBOOT_REQUEST = path.join(SD, 'sf-reboot-request');
var BOOT_AT = Date.now();

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
var pageSeen = false;        // player.js has loaded and asked us for config/manifest this boot
var bootConfirmed = false;   // this boot has been reported healthy to autorun.brs
var updating = false;        // an update download is in progress

// ── Status breadcrumb (survives for diagnostics) ────────────────────────────
function safeWrite(dest, text) {
  // Crash-safe atomic write: signage players lose power uncleanly. A plain
  // writeFileSync truncates then writes, so a power-pull mid-write leaves a
  // half-written/zero-length file and next boot's JSON.parse throws. Write to a
  // temp file then rename (atomic): power loss leaves either the old file intact
  // or the new one complete, never a corrupt half-file.
  var tmp = dest + '.tmp';
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, dest);
    return true;
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
    return false;
  }
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    try { return JSON.parse(fs.readFileSync(file + '.tmp', 'utf8')); }
    catch (e2) { throw e; }
  }
}

function setStatus(stage, detail) {
  safeWrite(STATUS_FILE, JSON.stringify({
    stage: stage, detail: detail || '', ts: Date.now(), node: process.version
  }));
  console.log('[SF-SRV] ' + stage + (detail ? ' — ' + detail : ''));
}

// ── Load config.json from SD ────────────────────────────────────────────────
function loadConfig() {
  try {
    CFG = readJsonSafe(CONFIG_FILE);
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
    manifest = readJsonSafe(MANIFEST_FILE);
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

// ── HTTP(S) POST helper (returns Promise of parsed JSON) ────────────────────────────
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
// 1.0.2 (Oct 28 2026, Wilshire Lobby): on a slow link every 60 s poll started
// another media-download run for the same version; the runs finished out of
// order and flipped the screen between old and new content, and nothing showed
// at all until every file had downloaded. Now:
//   - only one download run at a time (cacheInFlight); later polls just record
//     the newest version and it is processed when the current run ends;
//   - a run only applies its payload if it is still the newest one seen, so an
//     older publish can never replace a newer one;
//   - with nothing on screen yet, the payload is shown immediately (player.js
//     streams from the CDN until the SD copies land).
var cacheInFlight = false;   // a media-download run is in progress
var latestPayload = null;    // newest payload seen from the server
function applyManifest(payload, why) {
  safeWrite(MANIFEST_FILE, JSON.stringify(payload));
  manifest = payload;
  knownVersion = payload.content_version;
  setStatus('manifest-updated', knownVersion + (why ? ' (' + why + ')' : ''));
}
function processLatest() {
  if (cacheInFlight || !latestPayload) return Promise.resolve();
  var payload = latestPayload;
  if (payload.content_version === knownVersion) return Promise.resolve();
  if (!manifest || !manifest.zones || !manifest.zones.length) applyManifest(payload, 'immediate');
  cacheInFlight = true;
  return cacheManifestMedia(payload).then(function () {
    cacheInFlight = false;
    if (latestPayload && latestPayload.content_version !== payload.content_version) {
      setStatus('manifest-superseded', payload.content_version + ' -> ' + latestPayload.content_version);
      return processLatest();
    }
    if (knownVersion !== payload.content_version) applyManifest(payload, 'cached');
  }, function (e) {
    cacheInFlight = false;
    setStatus('media-error', e && e.message);
  });
}

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
        latestPayload = payload;
        if (cacheInFlight) { setStatus('poll-newversion-queued', payload.content_version); return; }
        setStatus('poll-newversion', payload.content_version);
        return processLatest();
      } else {
        latestPayload = payload;
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
      else if (r.status === 'not_found') {
        // Code lapsed or the device was released in ScreenFleet: get a fresh code and show it.
        if (activationTimer) { clearInterval(activationTimer); activationTimer = null; }
        setStatus('activation-reregister', '');
        activation = { status: 'connecting' };
        startActivation();
      }
    })
    .catch(function (e) { setStatus('activation-poll-offline', e.message); });
}

function applyClaim(r) {
  if (!CFG) CFG = {};
  if (r.screen_id) CFG.screenId = r.screen_id;
  if (r.screen_public_token) CFG.screenToken = r.screen_public_token;
  CFG.activationMode = false;
  activation = { status: 'claimed', screenId: CFG.screenId };
  safeWrite(CONFIG_FILE, JSON.stringify(CFG, null, 2));
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

// ── Boot health confirmation (read by autorun.brs) ───────────────────────────
// A boot is healthy once the page has loaded and fetched from us and we have
// been up 90 s. Then: reset the unhealthy-boot counter (controller agent guard)
// and, if this boot is a freshly installed update, mark the update confirmed so
// the launcher does not roll it back. Network is NOT required: a truck parked
// without signal must not roll back a good update.
function maybeConfirmBoot() {
  if (bootConfirmed || !pageSeen || Date.now() - BOOT_AT < Number(process.env.SF_HEALTHY_AFTER_MS || 90000)) return;
  bootConfirmed = true;
  safeWrite(BOOT_FILE, JSON.stringify({ unhealthy: 0, confirmed_at: new Date().toISOString(), version: PLAYER_VERSION }));
  var st = null;
  try { st = readJsonSafe(UPDATE_FILE); } catch (e) { st = null; }
  if (st && st.pending === true && st.version === PLAYER_VERSION) {
    st.pending = false;
    st.confirmed_at = new Date().toISOString();
    safeWrite(UPDATE_FILE, JSON.stringify(st));
    setStatus('update-confirmed', PLAYER_VERSION);
  }
}

// ── Remote updates (1.0.0+) ──────────────────────────────────────────────────
// ScreenFleet's playerUpdate function publishes ONE current release: a manifest
// of files with SHA-256 hashes. When it is newer than this player we download
// every file to sf-staging/, verify each hash, keep the current files in
// sf-prev/, write sf-update.json { pending:true }, swap the files in and ask
// autorun.brs to reboot. autorun.brs (never updated remotely) rolls back if the
// new version crash-loops or is not confirmed healthy within 10 minutes.
function semverParts(v) {
  var m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function semverGreater(a, b) {
  var pa = semverParts(a), pb = semverParts(b);
  if (!pa) return false;
  if (!pb) return true;   // anything beats a legacy/unknown version
  for (var i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] > pb[i]; }
  return false;
}
function launcherVersion() {
  try { return (readJsonSafe(LAUNCHER_FILE) || {}).version || '0.0.0'; } catch (e) { return '0.0.0'; }
}
function updateUrl() {
  return (CFG && CFG.updateUrl) || (origin() + '/functions/playerUpdate');
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function httpGetBuffer(url, hops) {
  hops = hops || 0;
  return new Promise(function (resolve, reject) {
    if (hops > 5) { reject(new Error('too many redirects')); return; }
    var lib = url.indexOf('https:') === 0 ? https : http;
    var req = lib.get(url, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); resolve(httpGetBuffer(urllib.resolve(url, res.headers.location), hops + 1)); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      var chunks = []; res.on('data', function (c) { chunks.push(c); }); res.on('end', function () { resolve(Buffer.concat(chunks)); });
    });
    req.on('error', reject);
    req.setTimeout(60000, function () { req.destroy(new Error('timeout')); });
  });
}

function checkForUpdate() {
  if (updating || !CFG || CFG.otaEnabled === false || !CFG.screenToken) return Promise.resolve();
  var st = null;
  try { st = readJsonSafe(UPDATE_FILE); } catch (e) { st = null; }
  if (st && st.pending === true) return Promise.resolve();   // previous update still settling
  var q = '?manifest=1&current=' + encodeURIComponent(PLAYER_VERSION) + '&launcher=' + encodeURIComponent(launcherVersion())
    + '&token=' + encodeURIComponent(CFG.screenToken) + '&channel=' + encodeURIComponent(CFG.updateChannel || 'stable');
  updating = true;
  return httpGetBuffer(updateUrl() + q).then(function (buf) {
    var m = JSON.parse(buf.toString('utf8'));
    if (!m || !m.ok || !m.update || !semverGreater(m.version, PLAYER_VERSION)) { setStatus('update-none', PLAYER_VERSION); return; }
    if (st && st.rolled_back && st.failed_version === m.version) { setStatus('update-skipped', m.version + ' failed before'); return; }
    if (m.launcher_min && semverGreater(m.launcher_min, launcherVersion())) { setStatus('update-needs-launcher', m.launcher_min); return; }
    var files = Array.isArray(m.files) ? m.files : [];
    if (!files.length) return;
    setStatus('update-downloading', m.version);
    try { fs.mkdirSync(STAGING_DIR, { recursive: true }); } catch (e) {}
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        if (!/^[a-zA-Z0-9._-]+$/.test(f.name)) throw new Error('bad file name ' + f.name);
        return httpGetBuffer(updateUrl() + '?file=' + encodeURIComponent(f.name) + '&version=' + encodeURIComponent(m.version))
          .then(function (data) {
            if (sha256(data) !== f.sha256) throw new Error(f.name + ' failed its SHA-256 check');
            fs.writeFileSync(path.join(STAGING_DIR, f.name), data);
          });
      });
    });
    return chain.then(function () { applyUpdate(m.version, files.map(function (f) { return f.name; })); });
  }).catch(function (e) {
    setStatus('update-error', e.message);
  }).then(function () { updating = false; });
}

function applyUpdate(version, names) {
  try { fs.mkdirSync(PREV_DIR, { recursive: true }); } catch (e) {}
  names.forEach(function (n) {
    var cur = path.join(SD, n);
    // Not copyFileSync: it copies file permissions too, which the SD card's FAT file system refuses
    // with EPERM on BrightSign (seen on the P1.9 LS424 updating 1.0.0 -> 1.0.1, 2026-10-27).
    if (fs.existsSync(cur)) fs.writeFileSync(path.join(PREV_DIR, n), fs.readFileSync(cur));
  });
  safeWrite(UPDATE_FILE, JSON.stringify({
    pending: true, version: version, previous: PLAYER_VERSION, files: names, attempts: 0, applied_at: new Date().toISOString()
  }));
  names.forEach(function (n) { fs.renameSync(path.join(STAGING_DIR, n), path.join(SD, n)); });
  setStatus('update-installed', PLAYER_VERSION + ' -> ' + version + ' (rebooting)');
  safeWrite(REBOOT_REQUEST, '1');   // autorun.brs reboots within ~5 s
}


// ── Static file serving from SD root ────────────────────────────────────────────────
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
      pageSeen = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(CFG || {}));
      return;
    }
    // API: current manifest (the render payload)
    if (p === '/api/manifest') {
      pageSeen = true;
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
    // API: player + update + agent status (local diagnostics)
    if (p === '/api/status') {
      var read = function (f) { try { return readJsonSafe(f); } catch (e) { return null; } };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        player_version: PLAYER_VERSION, launcher_version: launcherVersion(), uptime_s: Math.round((Date.now() - BOOT_AT) / 1000),
        content_version: knownVersion, update: read(UPDATE_FILE), boot: read(BOOT_FILE), agent: read(path.join(SD, 'sf-agent-status.json'))
      }));
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
    activation = { status: 'claimed', screenId: CFG.screenId };
    pollContent();
    pollTimer = setInterval(pollContent, interval);
  } else {
    startActivation();
  }

  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);

  // Boot health: check every 15 s until confirmed.
  var healthTimer = setInterval(function () { maybeConfirmBoot(); if (bootConfirmed) clearInterval(healthTimer); }, Number(process.env.SF_HEALTH_TICK_MS || 15000));

  // Remote updates: first check 5 min after boot (only once the boot is confirmed
  // healthy), then every 6 hours. (SF_* env vars exist only for tests.)
  setTimeout(function () { if (bootConfirmed) checkForUpdate(); }, Number(process.env.SF_UPDATE_DELAY_MS || 5 * 60 * 1000));
  setInterval(function () { if (bootConfirmed) checkForUpdate(); }, 6 * 60 * 60 * 1000);
}

main();
