'use strict';
// ScreenFleet BrightSign Player — player.js v32 (Node-native)
// Served over http://localhost:13131 by server.js. fetch() works normally,
// so there is NO config injection and NO file:// handling.
//   - Config:   GET /api/config    (served by the local Node server)
//   - Content:  GET /api/manifest  (local server keeps it current + cached)
//   - Media:    /media/<local_name> (local server serves the SD cache)
// The renderer (HDMI, canvas creative, slideshow, weather) is unchanged from v31.

window.__SF_NATIVE_PACKAGE__ = true;
window.__SF_VERSION__ = 'v32';

// Splash — dismissed after content renders, minimum 3 seconds display time
var _sfSplashStart = Date.now();
function sfDismissSplash() {
  var elapsed = Date.now() - _sfSplashStart;
  var remaining = Math.max(0, 3000 - elapsed);
  setTimeout(function() {
    var splash = document.getElementById('splash');
    if (splash) {
      splash.classList.add('hidden');
      setTimeout(function() {
        if (splash.parentNode) splash.parentNode.removeChild(splash);
      }, 900);
    }
  }, remaining);
}

var CFG = null;
var currentPayload = null;
var knownVersion = null;
var zoneTimers = {};
var scheduleTimer = null;        // per-minute schedule re-evaluation
var activeBlockByZone = {};      // zone.id -> schedule_id currently playing (change detection)
var payloadTimeZone = null;      // asset time zone from payload (schedules evaluate in it)

// ── Schedule evaluation (on-device, timezone-aware, offline) ─────────────────
// Each zone's playback_track may carry schedule_blocks[], each with a schedule
// (days_of_week, start_time "HH:MM", end_time "HH:MM", play_all_day, priority,
// interrupt_others). We evaluate them locally in the asset time zone and play
// the winning block. All media is already cached, so this works with no network.
//
// Returns { items, scheduleId } for the block to play now, or the flattened
// playback_track.items when there are no blocks / nothing matches.
function pad2(n) { return (n < 10 ? '0' : '') + n; }

// Current {dow 0-6, minutes-since-midnight} in the given IANA time zone.
// Falls back to local device time if the zone is missing or Intl rejects it.
function nowInZone(tz) {
  var d = new Date();
  try {
    if (tz) {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
      }).formatToParts(d);
      var map = {};
      parts.forEach(function(p) { map[p.type] = p.value; });
      var dowMap = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
      var dow = dowMap[map.weekday];
      var hh = parseInt(map.hour, 10); if (hh === 24) hh = 0;
      var mm = parseInt(map.minute, 10);
      if (dow != null && !isNaN(hh) && !isNaN(mm)) return { dow: dow, min: hh * 60 + mm };
    }
  } catch (e) { /* fall through to local */ }
  return { dow: d.getDay(), min: d.getHours() * 60 + d.getMinutes() };
}

function hhmmToMin(s) {
  if (!s || typeof s !== 'string') return null;
  var p = s.split(':');
  var h = parseInt(p[0], 10), m = parseInt(p[1] || '0', 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

// Is a single schedule active at {dow, min}? Handles all-day, normal windows,
// and overnight windows (end < start, e.g. 20:00–02:00).
function scheduleActive(sched, dow, min) {
  if (!sched) return false;
  if (sched.is_active === false) return false;
  var days = sched.days_of_week;
  if (Array.isArray(days) && days.length && days.indexOf(dow) === -1) {
    // For an overnight window, "today" can be covered by yesterday's block.
    var start0 = hhmmToMin(sched.start_time), end0 = hhmmToMin(sched.end_time);
    if (!(start0 != null && end0 != null && end0 < start0)) return false;
    // overnight: check if yesterday is a scheduled day and we're before end_time
    var yday = (dow + 6) % 7;
    if (days.indexOf(yday) === -1 || min >= end0) return false;
    return true;
  }
  if (sched.play_all_day) return true;
  var start = hhmmToMin(sched.start_time), end = hhmmToMin(sched.end_time);
  if (start == null || end == null) return true; // no window = always
  if (end >= start) return min >= start && min < end;        // normal window
  return min >= start || min < end;                           // overnight window
}

// Pick the winning schedule_block for a zone right now.
function activeBlockForZone(zone, dow, min) {
  var track = zone.playback_track || {};
  var blocks = track.schedule_blocks;
  if (!Array.isArray(blocks) || !blocks.length) {
    return { items: track.items || [], scheduleId: '__flat__' };
  }
  var matches = blocks.filter(function(b) { return scheduleActive(b.schedule, dow, min); });
  if (!matches.length) {
    // Nothing scheduled right now → zone is dark (BrightAuthor behavior).
    return { items: [], scheduleId: '__none__' };
  }
  // interrupt_others wins outright; otherwise highest priority; stable by order.
  var interrupt = matches.filter(function(b) { return b.schedule && b.schedule.interrupt_others; });
  var pool = interrupt.length ? interrupt : matches;
  pool.sort(function(a, b) { return (b.schedule.priority || 0) - (a.schedule.priority || 0); });
  var win = pool[0];
  return { items: win.items || [], scheduleId: (win.schedule && win.schedule.id) || win.schedule_id || '__block__' };
}

async function boot() {
  console.warn('[SF v32] boot() — fetching config from local Node server');
  // Config comes from the local server over http — plain fetch, always works.
  try {
    var rc = await fetch('/api/config', { cache: 'no-store' });
    CFG = await rc.json();
    console.warn('[SF] Config loaded. screenId=' + CFG.screenId);
  } catch (e) {
    showError('Cannot read /api/config: ' + e.message);
    return;
  }

  // If the screen isn't provisioned yet, run the activation UI. server.js does
  // the registration + polling; the page just shows the code until claimed.
  if (!CFG.screenId) {
    pollActivationUntilClaimed();
    return;
  }

  // First manifest: ask the local server (it serves the cached copy instantly,
  // offline-safe, and keeps it fresh in the background).
  await loadFromServer();

  // Re-check the local manifest on an interval. The Node server does the real
  // network polling + media caching; the player just re-renders when the
  // version it serves changes.
  var interval = (CFG && CFG.pollIntervalMs) ? CFG.pollIntervalMs : 60000;
  setInterval(loadFromServer, interval);
}

// Poll /api/activation; show the code until the operator claims the device,
// then switch to the content loop (server.js has written screenId into config).
function pollActivationUntilClaimed() {
  var done = false;
  function tick() {
    fetch('/api/activation', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (a) {
      if (done) return;
      if (a.status === 'claimed') {
        done = true;
        sfDismissSplash();
        // Re-read config (now has screenId) and start content.
        fetch('/api/config', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (cfg) {
          CFG = cfg;
          loadFromServer();
          var interval = (CFG && CFG.pollIntervalMs) ? CFG.pollIntervalMs : 60000;
          setInterval(loadFromServer, interval);
        });
      } else if (a.status === 'upgrade_required') {
        showActivationMessage('Trial ended', 'This player needs a paid slot. Add one in ScreenFleet, then it will resume automatically.');
      } else if (a.status === 'pending' && a.activation_code) {
        showActivation(a.activation_code, a.activate_url);
      } else {
        showActivationMessage('Connecting…', 'Reaching ScreenFleet to get an activation code.');
      }
    }).catch(function () {
      if (!done) showActivationMessage('Offline', 'Waiting for a network connection to activate.');
    });
  }
  tick();
  setInterval(tick, 5000);
}

function showActivation(code, url) {
  sfDismissSplash();
  var c = document.getElementById('canvas');
  if (!c) return;
  var activateUrl = url || 'app.screenfleet.io/activate';
  c.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#0B1F4A;font-family:Segoe UI,Arial,sans-serif';
  c.innerHTML =
    '<div style="text-align:center;color:#fff">' +
      '<div style="font:700 34px Segoe UI,sans-serif;letter-spacing:1px;color:#F2C230;margin-bottom:8px">ScreenFleet</div>' +
      '<div style="font-size:19px;color:#94a3b8;margin-bottom:22px">Enter this code at ' + escapeHtml(activateUrl.replace(/^https?:\/\//, '')) + '</div>' +
      '<div style="font-size:92px;font-weight:800;letter-spacing:14px;color:#fff;background:#1e3a8a;display:inline-block;padding:14px 36px;border-radius:14px">' + escapeHtml(code) + '</div>' +
      '<div style="margin-top:22px;font-size:16px;color:#64748b">Waiting for activation…</div>' +
    '</div>';
}

function showActivationMessage(title, sub) {
  sfDismissSplash();
  var c = document.getElementById('canvas');
  if (!c) return;
  c.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#0B1F4A;font-family:Segoe UI,Arial,sans-serif';
  c.innerHTML =
    '<div style="text-align:center;color:#fff">' +
      '<div style="font:700 30px Segoe UI,sans-serif;color:#F2C230;margin-bottom:12px">' + escapeHtml(title) + '</div>' +
      '<div style="font-size:18px;color:#94a3b8;max-width:70vw;margin:0 auto">' + escapeHtml(sub) + '</div>' +
    '</div>';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

async function loadFromServer() {
  try {
    var r = await fetch('/api/manifest', { cache: 'no-store' });
    var data = await r.json();
    if (!data || data.status === 'waiting' || !(data.zones && data.zones.length)) {
      if (!currentPayload) showWaiting();
      return;
    }
    if (data.content_version && data.content_version !== knownVersion) {
      console.warn('[SF] New manifest version: ' + data.content_version);
      knownVersion = data.content_version;
      currentPayload = data;
      renderPayload(data);
    }
  } catch (e) {
    console.warn('[SF] loadFromServer failed:', e.message);
    if (!currentPayload) showWaiting();
  }
}

// Resolve a media item to a local-server URL, falling back to its CDN url.
// The Node server caches media under /media/<name> from the SD card.
function mediaUrl(localName, cdnUrl) {
  if (localName) return '/media/' + localName;
  return cdnUrl || '';
}

// ── HDMI input element (BrightSign muted-autoplay pattern) ───────────────────
// BrightSign's required pattern (Sergio, OS 9.1.132, Series 4/5):
//   - the <video> MUST be autoplay AND muted, or Chromium blocks autoplay
//     (black screen / audio-only is exactly that block)
//   - unmute ~100ms after the 'canplay' event, once playback has started
//   - hwz="true" puts it on the hardware video plane
// The source is tv:brightsign.biz/hdmi. Replug is handled by autorun.brs firing
// roHdmiInputChanged -> sfReloadHdmi().
function makeHdmiVideo(cssText) {
  var vid = document.createElement('video');
  vid.setAttribute('data-hdmi', 'true');
  vid.setAttribute('hwz', 'true');          // hardware video plane
  vid.autoplay = true;
  vid.playsInline = true;
  vid.muted = true;                          // REQUIRED for autoplay
  vid.style.cssText = cssText;
  var src = document.createElement('source');
  src.src = 'tv:brightsign.biz/hdmi';
  src.type = 'video/mp4';
  vid.appendChild(src);
  // Unmute shortly after playback can begin (routes HDMI audio out).
  vid.addEventListener('canplay', function onCanPlay() {
    setTimeout(function() {
      try { vid.muted = false; vid.volume = 1.0; } catch (e) {}
    }, 100);
  });
  vid.onerror = function() { console.warn('[SF-HDMI] video error (signal not present yet)'); };
  return vid;
}

function startHdmiVideo(vid) {
  // Start muted so autoplay is allowed; canplay handler unmutes.
  vid.muted = true;
  vid.play().catch(function(e) { console.warn('[SF-HDMI] initial play() rejected:', e.message); });
}

window.sfReloadHdmi = function() {
  console.warn('[SF-HDMI] sfReloadHdmi() — reloading HDMI video elements (hotplug)');
  document.querySelectorAll('video[data-hdmi]').forEach(function(v) {
    // Re-run the muted-autoplay dance so the signal re-locks after a replug.
    v.muted = true;
    v.load();
    v.play().catch(function(e) { console.warn('[SF-HDMI] reload play() rejected:', e.message); });
    // canplay listener (added in makeHdmiVideo) will unmute again once ready.
  });
};

function renderPayload(payload) {
  console.warn('[SF] renderPayload zones=' + (payload.zones || []).length);
  Object.values(zoneTimers).forEach(function(t) { clearTimeout(t); });
  zoneTimers = {};
  activeBlockByZone = {};
  payloadTimeZone = payload.time_zone || null;

  var canvas = document.getElementById('canvas');
  var hdmiLayer = document.getElementById('hdmi-layer');
  if (!canvas || !hdmiLayer) { console.error('[SF] Missing #canvas or #hdmi-layer'); return; }

  var sw = payload.screen_width || 1920;
  var sh = payload.screen_height || 1080;
  canvas.style.width = sw + 'px';
  canvas.style.height = sh + 'px';
  canvas.innerHTML = '';
  // Preserve existing HDMI video elements across re-renders — destroying and
  // recreating them causes the interrupted-play cascade (audio only, black video).
  var existingHdmi = Array.from(hdmiLayer.querySelectorAll('video[data-hdmi]'));
  hdmiLayer.innerHTML = '';
  existingHdmi.forEach(function(v) { hdmiLayer.appendChild(v); });

  var zones = payload.zones || [];
  if (!zones.length) { showWaiting(); return; }
  zones.forEach(function(zone) { renderZone(canvas, hdmiLayer, zone); });
  sfDismissSplash();

  startScheduleTicker();
}

// ── Per-minute schedule re-evaluation ────────────────────────────────────────
// Every minute, re-evaluate each zone's active schedule block. When a zone's
// winning block changes (a window opened or closed), re-render just that zone
// from its new items. HDMI zones are left alone (no schedule). This is what
// makes content switch at window boundaries with no network.
function startScheduleTicker() {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = setInterval(scheduleTick, 60000);
}

function scheduleTick() {
  if (!currentPayload || !currentPayload.zones) return;
  var canvas = document.getElementById('canvas');
  var hdmiLayer = document.getElementById('hdmi-layer');
  if (!canvas || !hdmiLayer) return;
  var t = nowInZone(payloadTimeZone);

  currentPayload.zones.forEach(function(zone) {
    if (zone.content_source_type === 'hdmi_input') return; // HDMI has no schedule
    var active = activeBlockForZone(zone, t.dow, t.min);
    if (activeBlockByZone[zone.id] === active.scheduleId) return; // no change
    console.warn('[SF-SCHED] zone ' + zone.id + ' block ' +
      activeBlockByZone[zone.id] + ' -> ' + active.scheduleId);
    activeBlockByZone[zone.id] = active.scheduleId;

    // Clear this zone's running playback timers, then re-render just this zone.
    Object.keys(zoneTimers).forEach(function(k) {
      if (k.indexOf(zone.id + '_') === 0) { clearTimeout(zoneTimers[k]); delete zoneTimers[k]; }
    });
    var el = document.getElementById('zone-' + zone.id);
    if (el) {
      el.innerHTML = '';
      if (active.items.length) playTrack(el, zone, active.items, 0);
    }
  });
}

function renderZone(canvas, hdmiLayer, zone) {
  var x = zone.x || 0, y = zone.y || 0, w = zone.width || 0, h = zone.height || 0, z = zone.z_index || 1;

  if (zone.content_source_type === 'hdmi_input') {
    console.warn('[SF-HDMI] HDMI zone x=' + x + ' y=' + y + ' w=' + w + ' h=' + h);
    var vid = makeHdmiVideo(
      'position:absolute;left:'+x+'px;top:'+y+'px;width:'+w+'px;height:'+h+'px;z-index:'+z+';object-fit:fill;background:#000'
    );
    hdmiLayer.appendChild(vid);
    startHdmiVideo(vid);
    return;
  }

  var el = document.createElement('div');
  el.id = 'zone-' + zone.id;
  el.style.cssText = 'position:absolute;left:'+x+'px;top:'+y+'px;width:'+w+'px;height:'+h+'px;z-index:'+z+';background:'+(zone.background_color||'#000')+';overflow:hidden';
  canvas.appendChild(el);

  // Evaluate the schedule NOW and play the active block's items.
  var t = nowInZone(payloadTimeZone);
  var active = activeBlockForZone(zone, t.dow, t.min);
  activeBlockByZone[zone.id] = active.scheduleId;
  if (!active.items.length) return;   // nothing scheduled -> zone stays dark
  playTrack(el, zone, active.items, 0);
}

// ── Canvas Creative Renderer (unchanged from v31) ─────────────────────────────
function renderCanvasCreative(container, creative, zone, onLayerCycle) {
  if (!creative || !creative.layers_json) { console.warn('[SF-CC] No layers_json in creative'); return; }
  var cw = creative.width || zone.width || 1920;
  var ch = creative.height || zone.height || 1080;
  var layers = creative.layers_json;

  var hasHdmiLayer = layers.some(function(l) { return l.type === 'hdmi_input'; });
  if (hasHdmiLayer) {
    container.style.background = 'transparent';
    console.warn('[SF-CC] HDMI layer detected — container set to transparent');
  }

  var scaleX = zone.width  ? zone.width  / cw : 1;
  var scaleY = zone.height ? zone.height / ch : 1;
  var scale  = Math.min(scaleX, scaleY);

  var sorted = layers.slice().sort(function(a, b) { return (a.z_index || 1) - (b.z_index || 1); });

  sorted.forEach(function(layer) {
    var lx = (layer.x || 0) * scale;
    var ly = (layer.y || 0) * scale;
    var lw = (layer.width  || 100) * scale;
    var lh = (layer.height || 100) * scale;
    var lz = layer.z_index || 1;
    var p  = layer.props || {};
    var baseStyle = 'position:absolute;left:'+lx+'px;top:'+ly+'px;width:'+lw+'px;height:'+lh+'px;z-index:'+lz+';overflow:hidden;';

    if (layer.type === 'hdmi_input') {
      var hdmiLayer = document.getElementById('hdmi-layer');
      if (!hdmiLayer) return;
      var absX = (zone.x || 0) + lx;
      var absY = (zone.y || 0) + ly;
      // Reuse an existing HDMI element across re-renders (recreating causes the
      // interrupted-play cascade). Re-run the muted-autoplay dance on reuse.
      var existing = hdmiLayer.querySelector('video[data-hdmi]');
      if (existing) { existing.muted = true; existing.load(); existing.play().catch(function(){}); return; }
      var absVid = makeHdmiVideo(
        'position:absolute;left:'+absX+'px;top:'+absY+'px;width:'+lw+'px;height:'+lh+'px;z-index:'+(zone.z_index||1)+';object-fit:'+(p.fit==='fit'?'contain':'fill')+';background:#000;'
      );
      hdmiLayer.appendChild(absVid);
      startHdmiVideo(absVid);
      return;
    }

    if (layer.type === 'image') {
      if (!p.src) return;
      var img = document.createElement('img');
      img.src = mediaUrl(p.local_name, p.src);
      img.style.cssText = baseStyle + 'object-fit:' + fitCss(p.objectFit) + ';';
      if (layer.opacity != null && layer.opacity !== 1) img.style.opacity = layer.opacity;
      img._sfTriedCdn = false;
      img.onerror = function() { if (!img._sfTriedCdn && usedLocalCache(img.src) && p.src && p.src !== img.src) { img._sfTriedCdn = true; img.src = p.src; } };
      container.appendChild(img);
      return;
    }

    if (layer.type === 'video') {
      if (!p.src) return;
      var v = document.createElement('video');
      v.src = mediaUrl(p.local_name, p.src);
      v.autoplay = true; v.playsInline = true;
      v.muted = p.muted !== false; v.loop = p.loop !== false;
      v.style.cssText = baseStyle + 'object-fit:' + fitCss(p.objectFit) + ';';
      if (layer.opacity != null && layer.opacity !== 1) v.style.opacity = layer.opacity;
      v._sfTriedCdn = false;
      v.onerror = function() { if (!v._sfTriedCdn && usedLocalCache(v.src) && p.src && p.src !== v.src) { v._sfTriedCdn = true; v.src = p.src; v.load(); v.play().catch(function(){}); } };
      container.appendChild(v);
      return;
    }

    if (layer.type === 'text') {
      var d = document.createElement('div');
      d.style.cssText = baseStyle +
        'display:flex;' +
        'align-items:' + (p.verticalAlign === 'bottom' ? 'flex-end' : p.verticalAlign === 'middle' ? 'center' : 'flex-start') + ';' +
        'justify-content:' + (p.textAlign === 'center' ? 'center' : p.textAlign === 'right' ? 'flex-end' : 'flex-start') + ';' +
        'padding:' + ((p.padding || 4) * scale) + 'px;' +
        'font-size:' + ((p.fontSize || 24) * scale) + 'px;' +
        'font-weight:' + (p.bold ? 'bold' : 'normal') + ';' +
        'font-style:' + (p.italic ? 'italic' : 'normal') + ';' +
        'font-family:' + (p.fontFamily || 'sans-serif') + ';' +
        'color:' + (p.color || '#ffffff') + ';' +
        'line-height:' + (p.lineHeight || 1.2) + ';' +
        'word-break:break-word;box-sizing:border-box;';
      if (layer.opacity != null && layer.opacity !== 1) d.style.opacity = layer.opacity;
      d.textContent = p.text || '';
      container.appendChild(d);
      return;
    }

    if (layer.type === 'slideshow') {
      var ss = document.createElement('div');
      ss.style.cssText = baseStyle + 'background:#000;';
      if (layer.opacity != null && layer.opacity !== 1) ss.style.opacity = layer.opacity;
      container.appendChild(ss);
      renderSlideshow(ss, p, onLayerCycle ? function() { onLayerCycle(layer.id); } : null);
      return;
    }

    if (layer.type === 'shape') {
      var shp = document.createElement('div');
      shp.style.cssText = baseStyle +
        'background:' + (p.fillColor || '#3b82f6') + ';' +
        'border-radius:' + (p.shape === 'circle' ? '50%' : ((p.borderRadius || 0) * scale) + 'px') + ';' +
        (p.borderWidth ? 'border:' + (p.borderWidth * scale) + 'px solid ' + (p.borderColor || '#fff') + ';' : '');
      if (layer.opacity != null && layer.opacity !== 1) shp.style.opacity = layer.opacity;
      container.appendChild(shp);
      return;
    }

    if (layer.type === 'weather_widget') {
      var wd = document.createElement('div');
      wd.style.cssText = baseStyle +
        'background:' + (p.background_color || 'rgba(10,20,40,0.92)') + ';' +
        'overflow:hidden;font-family:Arial,sans-serif;box-sizing:border-box;display:flex;';
      container.appendChild(wd);

      var wLat = p.latitude, wLon = p.longitude;
      var wUnits = p.units || 'F', wAccent = p.accent_color || '#3b9eff';
      var wText = p.text_color || '#ffffff', wLoc = p.location_name || '';
      var wFdays = Math.min(p.forecast_days || 5, 7);
      var wShowIcon = p.show_icon !== false, wShowCond = p.show_condition !== false, wShowFcast = p.show_daily_forecast !== false;
      var wH = lh, wW = lw, base2 = Math.max(wH * 0.14, 8);
      var sz2 = { temp:base2*2.2, icon:base2*2.0, cond:base2*0.7, loc:base2*0.55, day:base2*0.65, ficon:base2*1.4, hi:base2*0.85, lo:base2*0.7 };
      var WMO = {0:'Clear',1:'Mostly Clear',2:'Partly Cloudy',3:'Overcast',45:'Fog',48:'Icy Fog',51:'Drizzle',53:'Drizzle',55:'Heavy Drizzle',61:'Rain',63:'Rain',65:'Heavy Rain',71:'Snow',73:'Snow',75:'Heavy Snow',80:'Showers',81:'Showers',82:'Heavy Showers',95:'Thunderstorm',96:'T-Storm+Hail',99:'T-Storm+Hail'};
      var DAYS2 = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      function wmoLabel(c){ return WMO[c]||'Unknown'; }
      function fmtTemp(c){ if(c==null)return '--'; return wUnits==='C'?Math.round(c)+'°':Math.round(c*9/5+32)+'°'; }
      function weatherIconSvg(code, size){
        var c=Math.round(size);
        var s='width="'+c+'" height="'+c+'" viewBox="0 0 32 32" fill="none"';
        if(code===0||code===1)return '<svg '+s+'><circle cx="16" cy="16" r="6" fill="#FFD700"/>'+[0,45,90,135,180,225,270,315].map(function(a){return '<line x1="16" y1="4" x2="16" y2="7" stroke="#FFD700" stroke-width="2" stroke-linecap="round" transform="rotate('+a+' 16 16)"/>';}).join('')+'</svg>';
        if(code===2)return '<svg '+s+'><circle cx="13" cy="14" r="5" fill="#FFD700"/>'+[0,60,120,180,240,300].map(function(a){return '<line x1="13" y1="5" x2="13" y2="8" stroke="#FFD700" stroke-width="1.5" stroke-linecap="round" transform="rotate('+a+' 13 14)"/>';}).join('')+'<rect x="8" y="17" width="16" height="9" rx="4.5" fill="#B0C4DE"/><rect x="12" y="14" width="12" height="7" rx="3.5" fill="#C8D8E8"/></svg>';
        if(code===3)return '<svg '+s+'><rect x="4" y="16" width="24" height="11" rx="5.5" fill="#8A9BB0"/><rect x="8" y="11" width="18" height="10" rx="5" fill="#A0B4C8"/></svg>';
        if(code===45||code===48)return '<svg '+s+'><rect x="4" y="10" width="24" height="3" rx="1.5" fill="#A0A0A0" opacity="0.7"/><rect x="6" y="15" width="20" height="3" rx="1.5" fill="#A0A0A0" opacity="0.6"/><rect x="4" y="20" width="24" height="3" rx="1.5" fill="#A0A0A0" opacity="0.5"/></svg>';
        if([51,53,55,61,63,65,80,81,82].indexOf(code)>=0)return '<svg '+s+'><rect x="5" y="7" width="22" height="11" rx="5.5" fill="#7A9BBF"/><rect x="9" y="4" width="16" height="9" rx="4.5" fill="#8FB0D0"/>'+[10,16,22].map(function(x){return '<line x1="'+x+'" y1="21" x2="'+(x-2)+'" y2="28" stroke="#5B8DB8" stroke-width="2" stroke-linecap="round"/>';}).join('')+'</svg>';
        if([71,73,75].indexOf(code)>=0)return '<svg '+s+'><rect x="5" y="7" width="22" height="11" rx="5.5" fill="#B0C8E0"/>'+[10,16,22].map(function(x){return '<circle cx="'+x+'" cy="24" r="1.5" fill="white" opacity="0.9"/>';}).join('')+'</svg>';
        if([95,96,99].indexOf(code)>=0)return '<svg '+s+'><rect x="4" y="6" width="24" height="12" rx="6" fill="#4A5568"/><rect x="8" y="3" width="18" height="10" rx="5" fill="#5A6478"/><polygon points="18,16 13,24 17,24 14,31 22,21 17,21" fill="#FFE135"/></svg>';
        return '<svg '+s+'><rect x="13" y="6" width="6" height="16" rx="3" fill="#C0C0C0"/><circle cx="16" cy="24" r="4" fill="#E05555"/><rect x="14" y="14" width="4" height="10" fill="#E05555"/></svg>';
      }
      function renderWeather(data){
        var cur=data.current_weather||{}, daily=data.daily||{};
        var curTemp=fmtTemp(cur.temperature), curCode=cur.weathercode||0;
        var curPanel='<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 '+(base2*1.2)+'px;border-right:1px solid rgba(255,255,255,0.12);flex-shrink:0;gap:'+(base2*0.2)+'px;min-width:'+(wW*0.22)+'px;">';
        if(wShowIcon)curPanel+=weatherIconSvg(curCode,sz2.icon);
        curPanel+='<div style="color:'+wText+';font-size:'+sz2.temp+'px;font-weight:800;line-height:1;letter-spacing:-0.02em">'+curTemp+'</div>';
        if(wShowCond)curPanel+='<div style="color:'+wAccent+';font-size:'+sz2.cond+'px;font-weight:600;text-align:center">'+wmoLabel(curCode)+'</div>';
        curPanel+='<div style="color:'+wText+';font-size:'+sz2.loc+'px;opacity:0.55;text-align:center;margin-top:'+(base2*0.1)+'px">'+wLoc+'</div></div>';
        var fcastPanel='';
        if(wShowFcast&&daily.time&&daily.time.length){
          fcastPanel='<div style="display:flex;flex:1;align-items:stretch;">';
          for(var i=0;i<Math.min(wFdays,daily.time.length);i++){
            var dateStr=daily.time[i];
            var dayName=i===0?'Today':DAYS2[new Date(dateStr+'T12:00:00').getDay()];
            var hi2=fmtTemp(daily.temperature_2m_max?daily.temperature_2m_max[i]:null);
            var lo2=fmtTemp(daily.temperature_2m_min?daily.temperature_2m_min[i]:null);
            var dCode=daily.weathercode?daily.weathercode[i]:0;
            var border=i<wFdays-1?'border-right:1px solid rgba(255,255,255,0.07);':'';
            fcastPanel+='<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;'+border+'padding:'+(base2*0.3)+'px '+(base2*0.2)+'px;gap:'+(base2*0.15)+'px;">';
            fcastPanel+='<div style="color:'+wText+';font-size:'+sz2.day+'px;font-weight:700;opacity:0.7;text-transform:uppercase;letter-spacing:0.04em">'+dayName+'</div>';
            if(wShowIcon)fcastPanel+=weatherIconSvg(dCode,sz2.ficon);
            fcastPanel+='<div style="color:'+wText+';font-size:'+sz2.hi+'px;font-weight:700;line-height:1">'+hi2+'</div>';
            fcastPanel+='<div style="color:'+wAccent+';font-size:'+sz2.lo+'px;opacity:0.85;font-weight:500">'+lo2+'</div></div>';
          }
          fcastPanel+='</div>';
        }
        wd.innerHTML=curPanel+fcastPanel;
      }
      if(!wLat||!wLon){ wd.innerHTML='<div style="display:flex;align-items:center;justify-content:center;width:100%;color:'+wText+';font-size:'+sz2.cond+'px;opacity:0.5">Set location in Studio</div>'; return; }
      var preloaded=p.weather_data;
      if(preloaded){ renderWeather(preloaded);
        var wUrl2='https://api.open-meteo.com/v1/forecast?latitude='+wLat+'&longitude='+wLon+'&current_weather=true&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto&forecast_days='+wFdays;
        setInterval(function(){ fetch(wUrl2).then(function(r){return r.json();}).then(renderWeather).catch(function(){}); }, 600000);
        return;
      }
      wd.innerHTML='<div style="display:flex;align-items:center;justify-content:center;width:100%;color:'+wText+';font-size:'+sz2.cond+'px;opacity:0.5">Loading weather...</div>';
      var wUrl='https://api.open-meteo.com/v1/forecast?latitude='+wLat+'&longitude='+wLon+'&current_weather=true&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto&forecast_days='+wFdays;
      fetch(wUrl).then(function(r){return r.json();}).then(function(data){ renderWeather(data);
        setInterval(function(){ fetch(wUrl).then(function(r){return r.json();}).then(renderWeather).catch(function(){}); }, 600000);
      }).catch(function(){ wd.innerHTML='<div style="display:flex;align-items:center;justify-content:center;width:100%;color:'+wText+';font-size:'+sz2.cond+'px;opacity:0.5">'+wLoc+' — Weather unavailable</div>'; });
      return;
    }

    var dbg = document.createElement('div');
    dbg.style.cssText = baseStyle + 'background:rgba(99,102,241,0.15);border:1px dashed #6366f1;display:flex;align-items:center;justify-content:center;';
    dbg.innerHTML = '<span style="color:#818cf8;font-size:' + (10 * scale) + 'px;font-family:monospace">' + (layer.type||'unknown') + '</span>';
    container.appendChild(dbg);
  });
}

// ── Slideshow (unchanged from v31, media via mediaUrl) ────────────────────────
function renderSlideshow(el, p, onCycle) {
  var items = (Array.isArray(p.items) && p.items.length) ? p.items
    : (Array.isArray(p.slides) ? p.slides.map(function(s){ return { id:s.id, mediaType:'image', src:s.src, local_name:s.local_name, name:s.name, dwellSeconds:s.dwellSeconds, dwellMode:'fixed' }; }) : []);
  items = items.filter(function(it){ return it && (it.src || it.local_name); });
  if (!items.length) { console.warn('[SF-SS] Slideshow has no media'); return; }

  var defaultDwell = Math.max(1, p.defaultDwellSeconds != null ? p.defaultDwellSeconds : 5);
  var fit = p.objectFit || 'cover';
  var muteVideos = p.muteVideos !== false;
  var loopVideos = p.loopVideos === true;
  var fade = p.transition === 'fade';
  var idx = 0, timer = null;

  function schedule(fn, ms){ clearTimeout(timer); timer = setTimeout(function(){ if (el.isConnected) fn(); }, ms); }
  function release(node){ if (node.tagName==='VIDEO'){ node.pause(); node.removeAttribute('src'); node.load(); } if (node.parentNode) node.parentNode.removeChild(node); }
  function advance(){ if (items.length<=1){ if(onCycle)onCycle(); return; } var next=(idx+1)%items.length; if(next===0&&onCycle)onCycle(); if(!el.isConnected)return; idx=next; show(); }
  function show(){
    var item = items[idx];
    var media;
    if (item.mediaType === 'video') {
      media = document.createElement('video');
      media.autoplay = true; media.muted = muteVideos; media.playsInline = true;
      media.loop = loopVideos && items.length === 1;
      if (item.dwellMode !== 'fixed') media.onended = function(){ clearTimeout(timer); advance(); };
      media.onerror = function(){
        if (!media._sfTriedCdn && usedLocalCache(media.src) && item.src && item.src !== media.src) {
          media._sfTriedCdn = true; media.src = item.src; media.load(); media.play().catch(function(){});
        } else { schedule(advance, 1500); }
      };
    } else {
      media = document.createElement('img');
      media.onerror = function(){
        if (!media._sfTriedCdn && usedLocalCache(media.src) && item.src && item.src !== media.src) {
          media._sfTriedCdn = true; media.src = item.src;
        } else { media.style.display='none'; schedule(advance, 1500); }
      };
    }
    media._sfTriedCdn = false;
    media.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:'+fit+';display:block;' + (fade?'opacity:0;transition:opacity .3s ease;':'');
    media.src = mediaUrl(item.local_name, item.src);
    var old = Array.prototype.slice.call(el.childNodes);
    el.appendChild(media);
    if (fade) { requestAnimationFrame(function(){ media.style.opacity='1'; }); setTimeout(function(){ old.forEach(release); }, 350); }
    else { old.forEach(release); }
    if (items.length <= 1) return;
    var upcoming = items[(idx+1)%items.length];
    if (upcoming.mediaType !== 'video') { var pre=new Image(); pre.src=mediaUrl(upcoming.local_name, upcoming.src); }
    if (item.mediaType === 'video' && item.dwellMode !== 'fixed') schedule(advance, 60000);
    else schedule(advance, Math.max(1, item.dwellSeconds != null ? item.dwellSeconds : defaultDwell) * 1000);
  }
  show();
}

function playTrack(el, zone, items, index) {
  var item = items[index % items.length];
  if (!item) return;
  el.innerHTML = '';
  var fit = fitCss(item.fit_mode || zone.fit_mode);

  if (item.content_type === 'canvas_creative') {
    var cc = item.canvas_creative;
    if (cc && cc.layers_json) {
      var hasHdmi = cc.layers_json.some(function(l){ return l.type==='hdmi_input'; });
      if (hasHdmi) el.style.background = 'transparent';
    }
    var next = index + 1;
    var hasMore = items.length > 1 && (next < items.length || (!zone.playback_track || zone.playback_track.loop !== false));
    var sync = (cc && cc.sync_mode) || 'independent';
    var cyclic = (cc && cc.layers_json ? cc.layers_json : []).filter(function(l){ return l.type==='slideshow'||l.type==='video_carousel'; });
    var followCycles = hasMore && sync !== 'independent' && cyclic.length > 0 && cyclic.every(function(l){ return l.type==='slideshow'; });
    var onLayerCycle = null;
    if (followCycles) {
      var doneLayers = {}, moved = false;
      onLayerCycle = function(layerId){ if(moved||!el.isConnected)return; doneLayers[layerId]=true; if(sync==='shortest'||Object.keys(doneLayers).length>=cyclic.length){ moved=true; playTrack(el,zone,items,next); } };
    }
    if (cc && cc.layers_json) renderCanvasCreative(el, cc, zone, onLayerCycle);
    else console.warn('[SF] canvas_creative item missing layers_json. id=' + item.canvas_creative_id);
    if (hasMore && !followCycles) {
      var dur = ((item.duration != null ? item.duration : 8)) * 1000;
      zoneTimers[zone.id + '_' + index] = setTimeout(function(){ playTrack(el, zone, items, next); }, dur);
    }
    return;
  }

  if (item.file_type === 'video') {
    var v = document.createElement('video');
    v.setAttribute('data-sf-local', mediaUrl(item.local_name, item.file_url));
    v.src = mediaUrl(item.local_name, item.file_url);
    v.autoplay = true; v.playsInline = true; v.muted = (zone.volume === 0);
    v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:'+fit;
    v.onended = function(){ playTrack(el, zone, items, index + 1); };
    // Fallback ladder, each tried at most once, so a bad source can't thrash:
    //   /media/ (cache)  ->  file_url (CDN)  ->  advance.
    // NOTE: a set .src is reported back ABSOLUTE (http://localhost:13131/media/..),
    // so test the cache path with a substring, not startsWith.
    v._sfTriedCdn = false;
    v.onerror = function(){
      if (!v._sfTriedCdn && usedLocalCache(v.src) && item.file_url && item.file_url !== v.src) {
        v._sfTriedCdn = true; v.src = item.file_url; v.load(); v.play().catch(function(){});
      } else {
        playTrack(el, zone, items, index + 1);
      }
    };
    el.appendChild(v);
  } else {
    var img = document.createElement('img');
    img.src = mediaUrl(item.local_name, item.file_url);
    img._sfTriedCdn = false;
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:'+fit;
    img.onerror = function(){
      if (!img._sfTriedCdn && usedLocalCache(img.src) && item.file_url && item.file_url !== img.src) {
        img._sfTriedCdn = true; img.src = item.file_url;
      } else {
        playTrack(el, zone, items, index + 1);
      }
    };
    el.appendChild(img);
    var dur = ((item.duration != null ? item.duration : 8)) * 1000;
    var loop = !zone.playback_track || zone.playback_track.loop !== false;
    var next2 = index + 1;
    if (loop || next2 < items.length) {
      zoneTimers[zone.id + '_' + index] = setTimeout(function(){ playTrack(el, zone, items, next2); }, dur);
    }
  }
}

// True when a media element current src is the local cache (/media/...).
// A DOM element reports .src absolute, so match the path anywhere in the URL.
function usedLocalCache(src) { return !!src && src.indexOf('/media/') !== -1; }

function fitCss(m) {
  switch(m) { case 'fit': return 'contain'; case 'stretch': return 'fill'; case 'center': return 'none'; default: return 'cover'; }
}

function showWaiting() {
  var c = document.getElementById('canvas');
  if (!c) return;
  c.innerHTML = '';
  c.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#13224D';
  c.innerHTML = '<div style="text-align:center"><div style="font:700 28px Segoe UI,sans-serif;color:#fff;letter-spacing:-0.01em"><span>Screen</span><span style="color:#B9C4DC;font-weight:600">Fleet</span></div><div style="margin-top:10px;color:#5B6B8C;font:500 15px Segoe UI,sans-serif">Waiting for content...</div><div style="margin-top:6px;color:#3a4a6a;font-size:12px">v32 Node-native</div></div>';
}

function showError(msg) {
  var c = document.getElementById('canvas');
  if (c) c.innerHTML = '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#0a0a0a"><div style="color:#ef4444;font:500 14px monospace;text-align:center;padding:20px">' + msg + '</div></div>';
}

window.addEventListener('load', boot);
