'use strict';
// ScreenFleet BrightSign Player — player.js (Node-native)
// Served over http://localhost:13131 by server.js. fetch() works normally,
// so there is NO config injection and NO file:// handling.
//   - Config:   GET /api/config    (served by the local Node server)
//   - Content:  GET /api/manifest  (local server keeps it current + cached)
//   - Media:    /media/<local_name> (local server serves the SD cache)
// The renderer (HDMI, canvas creative, slideshow, weather) is unchanged from v31.

window.__SF_NATIVE_PACKAGE__ = true;
window.__SF_VERSION__ = '1.0.4';

// SF-DIAG: capture script errors from the very start so remote diagnostics can report them.
var _sfErrors = [];
window.addEventListener('error', function (e) {
  try { _sfErrors.push(String((e && (e.message || (e.target && (e.target.src || e.target.tagName)))) || 'error').slice(0, 200)); } catch (x) {}
  if (_sfErrors.length > 20) _sfErrors.shift();
}, true);

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

// ── Schedule evaluation (on-device, timezone-aware, offline) ─────────────
// Each zone playback_track may carry schedule_blocks[], each with a schedule
// (days_of_week, start_time HH:MM, end_time HH:MM, play_all_day, priority,
// interrupt_others). We evaluate them locally in the asset time zone and play
// the winning block. All media is already cached, so this works with no network.
function pad2(n) { return (n < 10 ? '0' : '') + n; }

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

function scheduleActive(sched, dow, min) {
  if (!sched) return false;
  if (sched.is_active === false) return false;
  var days = sched.days_of_week;
  if (Array.isArray(days) && days.length && days.indexOf(dow) === -1) {
    var start0 = hhmmToMin(sched.start_time), end0 = hhmmToMin(sched.end_time);
    if (!(start0 != null && end0 != null && end0 < start0)) return false;
    var yday = (dow + 6) % 7;
    if (days.indexOf(yday) === -1 || min >= end0) return false;
    return true;
  }
  if (sched.play_all_day) return true;
  var start = hhmmToMin(sched.start_time), end = hhmmToMin(sched.end_time);
  if (start == null || end == null) return true;
  if (end >= start) return min >= start && min < end;
  return min >= start || min < end;
}

function activeBlockForZone(zone, dow, min) {
  var track = zone.playback_track || {};
  var blocks = track.schedule_blocks;
  if (!Array.isArray(blocks) || !blocks.length) {
    return { items: track.items || [], scheduleId: '__flat__' };
  }
  var matches = blocks.filter(function(b) { return scheduleActive(b.schedule, dow, min); });
  if (!matches.length) {
    return { items: [], scheduleId: '__none__' };
  }
  var interrupt = matches.filter(function(b) { return b.schedule && b.schedule.interrupt_others; });
  var pool = interrupt.length ? interrupt : matches;
  pool.sort(function(a, b) { return (b.schedule.priority || 0) - (a.schedule.priority || 0); });
  var win = pool[0];
  return { items: win.items || [], scheduleId: (win.schedule && win.schedule.id) || win.schedule_id || '__block__' };
}

async function boot() {
  console.warn('[SF 1.0.0] boot() — fetching config from local Node server');
  // Safety net: never sit on the "Starting player…" splash forever. Whatever
  // happens below (a hung manifest fetch, a blocked network, an empty asset),
  // lift the splash after a few seconds so the real screen state shows through.
  setTimeout(sfDismissSplash, 8000);
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

  // SF-DIAG: always send one report 30 s after boot, even if nothing rendered.
  setTimeout(function () { sfDiag('boot+30s'); }, 30000);

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
        fetch('/api/config', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (cfg) {
          CFG = cfg;
          loadFromServer();
          var interval = (CFG && CFG.pollIntervalMs) ? CFG.pollIntervalMs : 60000;
          setInterval(loadFromServer, interval);
        });
      } else if (a.status === 'upgrade_required') {
        showActivationMessage('Trial ended', 'This player needs a paid slot. Add one in ScreenFleet, then it will resume automatically.', true);
      } else if (a.status === 'pending' && a.activation_code) {
        showActivation(a.activation_code, a.activate_url);
      } else {
        showActivationMessage('Connecting…', 'Reaching ScreenFleet to get an activation code.');
      }
    }).catch(function () {
      if (!done) showActivationMessage('Can\u2019t reach ScreenFleet', 'Check this player\u2019s network cable or Wi-Fi. Retrying automatically.');
    });
  }
  tick();
  setInterval(tick, 5000);
}

// showActivation / showActivationMessage live in the sf-activation block at the end of this file.

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

// ── HDMI input element (BrightSign muted-autoplay pattern) ───────────────
// BrightSign required pattern (Sergio, OS 9.1.132, Series 4/5):
//   - the <video> MUST be autoplay AND muted, or Chromium blocks autoplay
//     (black screen / audio-only is exactly that block)
//   - unmute ~100ms after the canplay event, once playback has started
//   - hwz="true" puts it on the hardware video plane
// Source is tv:brightsign.biz/hdmi. Replug is handled by autorun.brs firing
// roHdmiInputChanged -> sfReloadHdmi().
function makeHdmiVideo(cssText) {
  var vid = document.createElement('video');
  vid.setAttribute('data-hdmi', 'true');
  vid.setAttribute('hwz', 'true');
  vid.autoplay = true;
  vid.playsInline = true;
  vid.muted = true;
  vid.style.cssText = cssText;
  var src = document.createElement('source');
  src.src = 'tv:brightsign.biz/hdmi';
  src.type = 'video/mp4';
  vid.appendChild(src);
  vid.addEventListener('canplay', function onCanPlay() {
    setTimeout(function() {
      try { vid.muted = false; vid.volume = 1.0; } catch (e) {}
    }, 100);
  });
  vid.onerror = function() { console.warn('[SF-HDMI] video error (signal not present yet)'); };
  return vid;
}

function startHdmiVideo(vid) {
  vid.muted = true;
  vid.play().catch(function(e) { console.warn('[SF-HDMI] initial play() rejected:', e.message); });
}

window.sfReloadHdmi = function() {
  console.warn('[SF-HDMI] sfReloadHdmi() — reloading HDMI video elements (hotplug)');
  document.querySelectorAll('video[data-hdmi]').forEach(function(v) {
    v.muted = true;
    v.load();
    v.play().catch(function(e) { console.warn('[SF-HDMI] reload play() rejected:', e.message); });
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
  sfFitStage(sw, sh);
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
  setTimeout(function () { sfDiag('render+8s'); }, 8000);

  startScheduleTicker();
}

// SF-FIT (Oct 25 2026): fit the screen canvas to the player's real drawing surface.
// Some BrightSign setups run a smaller graphics plane than the HDMI output (e.g. a
// 1280x720 plane upscaled to 2560x1440); the LED controller then scales the HDMI frame
// to the LED matrix. Drawing the full canvas into the window (non-uniform when the
// aspect differs) means the controller's own scaling lands it back 1:1 on the LEDs.
// No-op when the window already matches the canvas. HDMI-input video sits on the
// hardware plane and ignores this transform (none of the affected trailers use it).
function sfFitStage(sw, sh) {
  var stage = document.getElementById('stage');
  if (!stage) return;
  var ww = window.innerWidth, wh = window.innerHeight;
  var sx = ww / sw, sy = wh / sh;
  if (!ww || !wh || (Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01)) {
    stage.style.cssText = '';
    return;
  }
  stage.style.cssText = 'position:absolute;left:0;top:0;right:auto;bottom:auto;width:' + sw + 'px;height:' + sh +
    'px;transform-origin:0 0;transform:scale(' + sx + ',' + sy + ');';
  console.warn('[SF-FIT] canvas ' + sw + 'x' + sh + ' -> window ' + ww + 'x' + wh);
}
// autorun.brs (SF-RES) may resize the widget after load; refit when it does.
window.addEventListener('resize', function () {
  if (currentPayload) sfFitStage(currentPayload.screen_width || 1920, currentPayload.screen_height || 1080);
});

// ── Per-minute schedule re-evaluation ───────────────────────────
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
    if (zone.content_source_type === 'hdmi_input') return;
    var active = activeBlockForZone(zone, t.dow, t.min);
    if (activeBlockByZone[zone.id] === active.scheduleId) return;
    console.warn('[SF-SCHED] zone ' + zone.id + ' block ' +
      activeBlockByZone[zone.id] + ' -> ' + active.scheduleId);
    activeBlockByZone[zone.id] = active.scheduleId;
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

  // Evaluate the schedule NOW and play the active block items.
  var t = nowInZone(payloadTimeZone);
  var active = activeBlockForZone(zone, t.dow, t.min);
  activeBlockByZone[zone.id] = active.scheduleId;
  if (!active.items.length) return;   // nothing scheduled -> zone stays dark
  playTrack(el, zone, active.items, 0);
}

// ── Canvas Creative Renderer (unchanged from v31) ─────────────────────────────
function renderCanvasCreative(container, creative, zone, onLayerCycle) {
  if (!creative || !creative.layers_json) { console.warn('[SF-CC] No layers_json in creative'); return; }

  // ── Fold mode (clamshell trailers, SF-FOLD Oct 2026) ──
  // Bottom half = designed content. Top half = the same bottom-half content rotated
  // 180deg so it reads correctly when the top panel is folded down. HDMI layers are
  // NOT mirrored (hardware video plane ignores CSS transforms) — bottom half only.
  if (creative.fold_mode === true) {
    var fcw = creative.width || zone.width || 1920;
    var fch = creative.height || zone.height || 1080;
    var fscale = Math.min(zone.width ? zone.width / fcw : 1, zone.height ? zone.height / fch : 1);
    var fw = fcw * fscale, fhalf = (fch * fscale) / 2;
    var plain = {}; for (var k in creative) { if (Object.prototype.hasOwnProperty.call(creative, k)) plain[k] = creative[k]; }
    plain.fold_mode = false;
    var mirror = {}; for (var k2 in plain) { if (Object.prototype.hasOwnProperty.call(plain, k2)) mirror[k2] = plain[k2]; }
    mirror.layers_json = creative.layers_json.filter(function(l){ return l.type !== 'hdmi_input'; });
    var makeHalf = function(topPx, rotate, innerTopPx) {
      var box = document.createElement('div');
      box.style.cssText = 'position:absolute;left:0;top:'+topPx+'px;width:'+fw+'px;height:'+fhalf+'px;overflow:hidden;' + (rotate ? 'transform:rotate(180deg);' : '');
      var inner = document.createElement('div');
      inner.style.cssText = 'position:absolute;left:0;top:'+innerTopPx+'px;width:'+fw+'px;height:'+(fhalf*2)+'px;';
      box.appendChild(inner);
      container.appendChild(box);
      return inner;
    };
    var topInner = makeHalf(0, true, -fhalf);   // SF-FOLD2: rotated box clips in its own (pre-rotation) layout, so the mirror ALSO needs -fhalf
    var bottomInner = makeHalf(fhalf, false, -fhalf);
    console.log('[SF-CC] fold_mode render ' + fcw + 'x' + fch + ' scale=' + fscale.toFixed(3));
    renderCanvasCreative(bottomInner, plain, zone, onLayerCycle);
    renderCanvasCreative(topInner, mirror, zone, null);
    return;
  }
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
  // SF-004 (Oct 13 2026): el.innerHTML='' removed from here — each branch clears
  // the zone itself so plain images can crossfade without a black flash between items.
  var fit = fitCss(item.fit_mode || zone.fit_mode);

  if (item.content_type === 'canvas_creative') {
    // Canvas creatives replace the whole zone — clear immediately.
    el.innerHTML = '';
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
    // Videos replace immediately (no crossfade for video items).
    el.innerHTML = '';
    var v = document.createElement('video');
    v.setAttribute('data-sf-local', mediaUrl(item.local_name, item.file_url));
    v.src = mediaUrl(item.local_name, item.file_url);
    v.autoplay = true; v.playsInline = true; v.muted = (zone.volume === 0);
    v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:'+fit;
    // SF-003 (Oct 9 2026): a single looping video loops in place instead of being
    // torn down and rebuilt at the end of every pass (visible blink).
    var loopTrack = !zone.playback_track || zone.playback_track.loop !== false;
    if (items.length <= 1 && loopTrack) v.loop = true;
    v.onended = function(){ playTrack(el, zone, items, index + 1); };
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
    // SF-004 (Oct 13 2026): plain image crossfade — mirrors the renderSlideshow pattern.
    // Old nodes stay visible while the new image loads; they're removed after the fade.
    var fade4 = (item.transition === 'fade') || (zone.playback_track && zone.playback_track.default_transition === 'fade');
    var isFirst = el.childNodes.length === 0;
    var img = document.createElement('img');
    img.src = mediaUrl(item.local_name, item.file_url);
    img._sfTriedCdn = false;
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:'+fit+';display:block;' +
      (fade4 && !isFirst ? 'opacity:0;transition:opacity 0.4s ease;' : '');
    img.onerror = function(){
      if (!img._sfTriedCdn && usedLocalCache(img.src) && item.file_url && item.file_url !== img.src) {
        img._sfTriedCdn = true; img.src = item.file_url;
      } else {
        playTrack(el, zone, items, index + 1);
      }
    };
    var oldNodes = Array.prototype.slice.call(el.childNodes);
    el.appendChild(img);
    if (fade4 && !isFirst) {
      requestAnimationFrame(function(){ img.style.opacity = '1'; });
      setTimeout(function(){ oldNodes.forEach(function(n){ if (n.parentNode) n.parentNode.removeChild(n); }); }, 450);
    } else {
      oldNodes.forEach(function(n){ if (n.parentNode) n.parentNode.removeChild(n); });
    }
    // SF-003 (Oct 9 2026): a one-image track stays on screen. Re-running playTrack every
    // duration cleared the zone and reloaded the same image, which showed as a refresh/blink
    // every 8 s (canvas creatives already had this guard; plain playlist images didn't).
    if (items.length <= 1) return;
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
  sfDismissSplash();
  var c = document.getElementById('canvas');
  if (!c) return;
  c.innerHTML = '';
  c.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#13224D';
  c.innerHTML = '<div style="text-align:center"><div style="font:700 28px Segoe UI,sans-serif;color:#fff;letter-spacing:-0.01em"><span>Screen</span><span style="color:#B9C4DC;font-weight:600">Fleet</span></div><div style="margin-top:10px;color:#5B6B8C;font:500 15px Segoe UI,sans-serif">Waiting for content...</div><div style="margin-top:6px;color:#3a4a6a;font-size:12px">ScreenFleet 1.0.1</div></div>';
}

function showError(msg) {
  sfDismissSplash();
  var c = document.getElementById('canvas');
  if (c) c.innerHTML = '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#0a0a0a"><div style="color:#ef4444;font:500 14px monospace;text-align:center;padding:20px">' + msg + '</div></div>';
}

// ── SF-DIAG: remote render diagnostics ─────────────────────────────────────────────
// Posts what the page actually drew (browser version, viewport, element boxes, and
// whether each image/video loaded) to /functions/playerDiag, so a black screen can be
// diagnosed without pulling the SD card. CORS-simple request: no preflight needed.
// Never throws; at most one report per trigger.
function sfDiag(reason) {
  try {
    if (!CFG || !CFG.screenId || !CFG.screenToken) return;
    var box = function (el) {
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    };
    var media = [];
    var canvas = document.getElementById('canvas');
    if (canvas) {
      Array.prototype.forEach.call(canvas.querySelectorAll('img,video'), function (m, i) {
        if (i >= 10) return;
        media.push({
          tag: m.tagName, src: String(m.currentSrc || m.src || '').slice(-90),
          ok: m.tagName === 'IMG' ? (m.complete && m.naturalWidth > 0) : (m.readyState >= 2),
          nw: m.naturalWidth || m.videoWidth || 0, box: box(m),
          vis: getComputedStyle(m).visibility + '/' + getComputedStyle(m).opacity,
          triedCdn: !!m._sfTriedCdn
        });
      });
    }
    var report = {
      screen_id: CFG.screenId, screen_token: CFG.screenToken, reason: reason,
      ver: window.__SF_VERSION__, ua: navigator.userAgent,
      win: [window.innerWidth, window.innerHeight], scr: [screen.width, screen.height],
      stage: box(document.getElementById('stage')), canvas: box(canvas),
      splash: !!document.getElementById('splash'),
      manifest: knownVersion, zones: currentPayload && currentPayload.zones ? currentPayload.zones.length : 0,
      zoneEls: canvas ? canvas.children.length : 0, media: media, errors: _sfErrors.slice(-10),
      at: new Date().toISOString()
    };
    var origin = (CFG.apiOrigin || 'https://app.screenfleet.io').replace(/\/$/, '');
    fetch(origin + '/functions/playerDiag', {
      method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(report)
    }).catch(function () {});
  } catch (e) { /* diagnostics must never break playback */ }
}

window.addEventListener('load', boot);

// >>> sf-activation — GENERATED by activation-src/build-activation.mjs. Edit activation-src/ui.js, not this block. >>>
// ── Activation screen (player 1.0.3+) ───────────────────────────────────────
// Source for the activation block in player.js. Edit here, then run
//   node base44/functions/_genbuild/activation-src/build-activation.mjs
// which writes this file + the QR encoder + the embedded fonts into player.js
// between the "sf-activation" markers.
//
// Same design as the Android player: steps on the left, a large QR code and the
// short code on the right, ScreenFleet navy/orange branding, Montserrat (embedded,
// works offline). Sizes scale with the screen (vmin), so it reads on a 1080p TV
// and on a small or oddly shaped LED panel. Tall screens stack the QR under the steps.
var SF_ACT_CSS =
  '#sf-act{position:absolute;inset:0;background:#122849;color:#fff;font-family:Montserrat,"Segoe UI",Arial,sans-serif;overflow:hidden;-webkit-font-smoothing:antialiased}' +
  '#sf-act .lockup{position:absolute;left:4.4vmin;top:4vmin;display:flex;align-items:center}' +
  '#sf-act .lockup svg{width:5.2vmin;height:5.2vmin;display:block}' +
  '#sf-act .word{margin-left:1.6vmin;font-size:3.9vmin;line-height:1;letter-spacing:-0.02em;white-space:nowrap}' +
  '#sf-act .word b{font-weight:800;color:#fff}#sf-act .word i{font-style:normal;font-weight:300;color:#FD703B}' +
  '#sf-act .body{position:absolute;left:4.4vmin;right:4.4vmin;top:12vmin;bottom:8vmin;display:flex;align-items:center;justify-content:center;gap:6vmin}' +
  '#sf-act .steps{flex:0 1 auto;max-width:72vmin;min-width:0}' +
  '#sf-act h1{font-weight:800;font-size:5.4vmin;line-height:1.15;letter-spacing:-0.01em;margin:0 0 3.6vmin}' +
  '#sf-act .row{display:flex;align-items:center;margin-top:2.4vmin}' +
  '#sf-act .num{flex:0 0 auto;width:5.2vmin;height:5.2vmin;border-radius:50%;background:#FD703B;color:#122849;font-weight:800;font-size:2.7vmin;display:flex;align-items:center;justify-content:center}' +
  '#sf-act .txt{margin-left:2.4vmin;font-weight:600;font-size:3vmin;line-height:1.3}' +
  '#sf-act .help{margin-top:3.6vmin;color:#A5E2FF;font-weight:600;font-size:2.2vmin;line-height:1.4}' +
  '#sf-act .qrcol{flex:0 0 auto;display:flex;flex-direction:column;align-items:center}' +
  '#sf-act .qr{background:#fff;border-radius:2.2vmin;padding:2.2vmin;line-height:0}' +
  '#sf-act .qr svg{width:36vmin;height:36vmin;display:block}' +
  '#sf-act .lbl{margin-top:2.6vmin;color:#A5E2FF;font-weight:600;font-size:1.9vmin;letter-spacing:0.12em;text-transform:uppercase}' +
  '#sf-act .code{margin-top:0.6vmin;font-weight:800;font-size:6.6vmin;letter-spacing:0.22em;margin-right:-0.22em;line-height:1.1}' +
  '#sf-act .msg{max-width:60vmin;text-align:center;color:#A5E2FF;font-weight:600;font-size:2.6vmin;line-height:1.4}' +
  '#sf-act .msg strong{display:block;color:#fff;font-weight:800;font-size:4vmin;margin-bottom:1.6vmin}' +
  '#sf-act .foot{position:absolute;left:4.4vmin;bottom:3.4vmin;color:#7F97BD;font-weight:600;font-size:1.7vmin}' +
  '@media (max-aspect-ratio:1/1){#sf-act .body{flex-direction:column;top:14vmin;gap:5vmin}#sf-act .steps{max-width:84vw;flex:0 0 auto}#sf-act .qr svg{width:44vmin;height:44vmin}}';

// Mark: 4x4 grid, a lit "route" from top-left, orange square bottom-right (brand kit v1.0, reversed).
function sfMarkSvg() {
  var lit = { '0,0': 1, '1,0': 1, '1,1': 1, '2,1': 1, '2,2': 1, '3,2': 1 };
  var pos = [8, 29, 50, 71], s = '';
  for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) {
    var fill = (c === 3 && r === 3) ? '#FD703B' : (lit[c + ',' + r] ? '#FFFFFF' : '#2B4F85');
    s += '<rect x="' + pos[c] + '" y="' + pos[r] + '" width="17" height="17" rx="4" fill="' + fill + '"/>';
  }
  return '<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' + s + '</svg>';
}

// QR code as one SVG path (black on white, 2-module quiet zone inside the white card), ECC M.
function sfQrSvg(text) {
  var qr = sfQrLib()(0, 'M');
  qr.addData(String(text));
  qr.make();
  var n = qr.getModuleCount(), q = 2, d = '';
  for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
    if (qr.isDark(y, x)) d += 'M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z';
  }
  var v = n + q * 2;
  return '<svg viewBox="0 0 ' + v + ' ' + v + '" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><path d="' + d + '" fill="#000"/></svg>';
}

function sfActivationRoot() {
  sfDismissSplash();
  if (!document.getElementById('sf-act-style')) {
    var st = document.createElement('style');
    st.id = 'sf-act-style';
    st.textContent = sfBrandFontsCss() + SF_ACT_CSS;
    document.head.appendChild(st);
  }
  var c = document.getElementById('canvas');
  if (!c) return null;
  c.style.cssText = 'position:absolute;inset:0';
  return c;
}

function sfActivationFrame(right, host, noSteps) {
  return '<div id="sf-act">' +
    '<div class="lockup">' + sfMarkSvg() + '<div class="word"><b>Screen</b><i>Fleet</i></div></div>' +
    '<div class="body">' +
      (noSteps ? '' : '<div class="steps">' +
        '<h1>Let’s set up this screen</h1>' +
        '<div class="row"><div class="num">1</div><div class="txt">Scan the code with your phone’s camera</div></div>' +
        '<div class="row"><div class="num">2</div><div class="txt">Sign in to ScreenFleet</div></div>' +
        '<div class="row"><div class="num">3</div><div class="txt">Name this screen — your content starts playing here</div></div>' +
        '<div class="help">No phone handy? Go to ' + escapeHtml(host) + ' and enter the code.</div>' +
      '</div>') +
      '<div class="qrcol">' + right + '</div>' +
    '</div>' +
    '<div class="foot">ScreenFleet player ' + escapeHtml(window.__SF_VERSION__ || '') + ' · BrightSign</div>' +
  '</div>';
}

// "app.screenfleet.io/activate" from the activate_url the backend sends (which carries ?code=…).
function sfActivateHost(url) {
  var u = String(url || 'app.screenfleet.io/activate').replace(/^https?:\/\//, '');
  return u.split('?')[0].split('#')[0] || 'app.screenfleet.io/activate';
}

var _sfActShown = '';
function showActivation(code, url) {
  var key = 'code|' + code + '|' + url;
  if (_sfActShown === key && document.getElementById('sf-act')) return;   // polled every 5 s; don't redraw
  var c = sfActivationRoot();
  if (!c) return;
  var qrUrl = url || ('https://app.screenfleet.io/activate?code=' + encodeURIComponent(code));
  var qr = '';
  try { qr = '<div class="qr">' + sfQrSvg(qrUrl) + '</div>'; } catch (e) { qr = ''; }   // code alone still works
  c.innerHTML = sfActivationFrame(qr + '<div class="lbl">Activation code</div><div class="code">' + escapeHtml(code) + '</div>', sfActivateHost(url));
  _sfActShown = key;
}

// noSteps: for states where pairing isn't possible right now (e.g. the trial ended).
function showActivationMessage(title, sub, noSteps) {
  var key = 'msg|' + title + '|' + sub + '|' + (noSteps ? 1 : 0);
  if (_sfActShown === key && document.getElementById('sf-act')) return;
  var c = sfActivationRoot();
  if (!c) return;
  c.innerHTML = sfActivationFrame('<div class="msg"><strong>' + escapeHtml(title) + '</strong>' + escapeHtml(sub) + '</div>', sfActivateHost(''), noSteps);
  _sfActShown = key;
}

// QR Code Generator for JavaScript, Copyright (c) 2009 Kazuhiko Arase, MIT license (qrcode-generator@1.4.4).
// 'QR Code' is a registered trademark of DENSO WAVE INCORPORATED.
var _sfQr = null;
function sfQrLib() {
  if (_sfQr) return _sfQr;
  var module = { exports: {} }, exports = module.exports, define = undefined;
var qrcode=function(){var P=function(x,w){var g=236,l=17,n=x,s=O[w],t=null,r=0,h=null,i=[],v={},_=function(a,f){r=n*4+17,t=function(e){for(var u=new Array(e),o=0;o<e;o+=1){u[o]=new Array(e);for(var d=0;d<e;d+=1)u[o][d]=null}return u}(r),B(0,0),B(r-7,0),B(0,r-7),E(),T(),m(a,f),n>=7&&N(a),h==null&&(h=nr(n,s,i)),U(h,f)},B=function(a,f){for(var e=-1;e<=7;e+=1)if(!(a+e<=-1||r<=a+e))for(var u=-1;u<=7;u+=1)f+u<=-1||r<=f+u||(0<=e&&e<=6&&(u==0||u==6)||0<=u&&u<=6&&(e==0||e==6)||2<=e&&e<=4&&2<=u&&u<=4?t[a+e][f+u]=!0:t[a+e][f+u]=!1)},y=function(){for(var a=0,f=0,e=0;e<8;e+=1){_(!0,e);var u=k.getLostPoint(v);(e==0||a>u)&&(a=u,f=e)}return f},T=function(){for(var a=8;a<r-8;a+=1)t[a][6]==null&&(t[a][6]=a%2==0);for(var f=8;f<r-8;f+=1)t[6][f]==null&&(t[6][f]=f%2==0)},E=function(){for(var a=k.getPatternPosition(n),f=0;f<a.length;f+=1)for(var e=0;e<a.length;e+=1){var u=a[f],o=a[e];if(t[u][o]==null)for(var d=-2;d<=2;d+=1)for(var c=-2;c<=2;c+=1)d==-2||d==2||c==-2||c==2||d==0&&c==0?t[u+d][o+c]=!0:t[u+d][o+c]=!1}},N=function(a){for(var f=k.getBCHTypeNumber(n),e=0;e<18;e+=1){var u=!a&&(f>>e&1)==1;t[Math.floor(e/3)][e%3+r-8-3]=u}for(var e=0;e<18;e+=1){var u=!a&&(f>>e&1)==1;t[e%3+r-8-3][Math.floor(e/3)]=u}},m=function(a,f){for(var e=s<<3|f,u=k.getBCHTypeInfo(e),o=0;o<15;o+=1){var d=!a&&(u>>o&1)==1;o<6?t[o][8]=d:o<8?t[o+1][8]=d:t[r-15+o][8]=d}for(var o=0;o<15;o+=1){var d=!a&&(u>>o&1)==1;o<8?t[8][r-o-1]=d:o<9?t[8][15-o-1+1]=d:t[8][15-o-1]=d}t[r-8][8]=!a},U=function(a,f){for(var e=-1,u=r-1,o=7,d=0,c=k.getMaskFunction(f),p=r-1;p>0;p-=2)for(p==6&&(p-=1);;){for(var b=0;b<2;b+=1)if(t[u][p-b]==null){var C=!1;d<a.length&&(C=(a[d]>>>o&1)==1);var A=c(u,p-b);A&&(C=!C),t[u][p-b]=C,o-=1,o==-1&&(d+=1,o=7)}if(u+=e,u<0||r<=u){u-=e,e=-e;break}}},H=function(a,f){for(var e=0,u=0,o=0,d=new Array(f.length),c=new Array(f.length),p=0;p<f.length;p+=1){var b=f[p].dataCount,C=f[p].totalCount-b;u=Math.max(u,b),o=Math.max(o,C),d[p]=new Array(b);for(var A=0;A<d[p].length;A+=1)d[p][A]=255&a.getBuffer()[A+e];e+=b;var R=k.getErrorCorrectPolynomial(C),I=K(d[p],R.getLength()-1),S=I.mod(R);c[p]=new Array(R.getLength()-1);for(var A=0;A<c[p].length;A+=1){var X=A+S.getLength()-c[p].length;c[p][A]=X>=0?S.getAt(X):0}}for(var Z=0,A=0;A<f.length;A+=1)Z+=f[A].totalCount;for(var J=new Array(Z),Q=0,A=0;A<u;A+=1)for(var p=0;p<f.length;p+=1)A<d[p].length&&(J[Q]=d[p][A],Q+=1);for(var A=0;A<o;A+=1)for(var p=0;p<f.length;p+=1)A<c[p].length&&(J[Q]=c[p][A],Q+=1);return J},nr=function(a,f,e){for(var u=Y.getRSBlocks(a,f),o=G(),d=0;d<e.length;d+=1){var c=e[d];o.put(c.getMode(),4),o.put(c.getLength(),k.getLengthInBits(c.getMode(),a)),c.write(o)}for(var p=0,d=0;d<u.length;d+=1)p+=u[d].dataCount;if(o.getLengthInBits()>p*8)throw"code length overflow. ("+o.getLengthInBits()+">"+p*8+")";for(o.getLengthInBits()+4<=p*8&&o.put(0,4);o.getLengthInBits()%8!=0;)o.putBit(!1);for(;!(o.getLengthInBits()>=p*8||(o.put(g,8),o.getLengthInBits()>=p*8));)o.put(l,8);return H(o,u)};v.addData=function(a,f){f=f||"Byte";var e=null;switch(f){case"Numeric":e=$(a);break;case"Alphanumeric":e=W(a);break;case"Byte":e=V(a);break;case"Kanji":e=q(a);break;default:throw"mode:"+f}i.push(e),h=null},v.isDark=function(a,f){if(a<0||r<=a||f<0||r<=f)throw a+","+f;return t[a][f]},v.getModuleCount=function(){return r},v.make=function(){if(n<1){for(var a=1;a<40;a++){for(var f=Y.getRSBlocks(a,s),e=G(),u=0;u<i.length;u++){var o=i[u];e.put(o.getMode(),4),e.put(o.getLength(),k.getLengthInBits(o.getMode(),a)),o.write(e)}for(var d=0,u=0;u<f.length;u++)d+=f[u].dataCount;if(e.getLengthInBits()<=d*8)break}n=a}_(!1,y())},v.createTableTag=function(a,f){a=a||2,f=typeof f>"u"?a*4:f;var e="";e+='<table style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: "+f+"px;",e+='">',e+="<tbody>";for(var u=0;u<v.getModuleCount();u+=1){e+="<tr>";for(var o=0;o<v.getModuleCount();o+=1)e+='<td style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: 0px;",e+=" width: "+a+"px;",e+=" height: "+a+"px;",e+=" background-color: ",e+=v.isDark(u,o)?"#000000":"#ffffff",e+=";",e+='"/>';e+="</tr>"}return e+="</tbody>",e+="</table>",e},v.createSvgTag=function(a,f,e,u){var o={};typeof arguments[0]=="object"&&(o=arguments[0],a=o.cellSize,f=o.margin,e=o.alt,u=o.title),a=a||2,f=typeof f>"u"?a*4:f,e=typeof e=="string"?{text:e}:e||{},e.text=e.text||null,e.id=e.text?e.id||"qrcode-description":null,u=typeof u=="string"?{text:u}:u||{},u.text=u.text||null,u.id=u.text?u.id||"qrcode-title":null;var d=v.getModuleCount()*a+f*2,c,p,b,C,A="",R;for(R="l"+a+",0 0,"+a+" -"+a+",0 0,-"+a+"z ",A+='<svg version="1.1" xmlns="http://www.w3.org/2000/svg"',A+=o.scalable?"":' width="'+d+'px" height="'+d+'px"',A+=' viewBox="0 0 '+d+" "+d+'" ',A+=' preserveAspectRatio="xMinYMin meet"',A+=u.text||e.text?' role="img" aria-labelledby="'+F([u.id,e.id].join(" ").trim())+'"':"",A+=">",A+=u.text?'<title id="'+F(u.id)+'">'+F(u.text)+"</title>":"",A+=e.text?'<description id="'+F(e.id)+'">'+F(e.text)+"</description>":"",A+='<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>',A+='<path d="',b=0;b<v.getModuleCount();b+=1)for(C=b*a+f,c=0;c<v.getModuleCount();c+=1)v.isDark(b,c)&&(p=c*a+f,A+="M"+p+","+C+R);return A+='" stroke="transparent" fill="black"/>',A+="</svg>",A},v.createDataURL=function(a,f){a=a||2,f=typeof f>"u"?a*4:f;var e=v.getModuleCount()*a+f*2,u=f,o=e-f;return er(e,e,function(d,c){if(u<=d&&d<o&&u<=c&&c<o){var p=Math.floor((d-u)/a),b=Math.floor((c-u)/a);return v.isDark(b,p)?0:1}else return 1})},v.createImgTag=function(a,f,e){a=a||2,f=typeof f>"u"?a*4:f;var u=v.getModuleCount()*a+f*2,o="";return o+="<img",o+=' src="',o+=v.createDataURL(a,f),o+='"',o+=' width="',o+=u,o+='"',o+=' height="',o+=u,o+='"',e&&(o+=' alt="',o+=F(e),o+='"'),o+="/>",o};var F=function(a){for(var f="",e=0;e<a.length;e+=1){var u=a.charAt(e);switch(u){case"<":f+="&lt;";break;case">":f+="&gt;";break;case"&":f+="&amp;";break;case'"':f+="&quot;";break;default:f+=u;break}}return f},ar=function(a){var f=1;a=typeof a>"u"?f*2:a;var e=v.getModuleCount()*f+a*2,u=a,o=e-a,d,c,p,b,C,A={"\u2588\u2588":"\u2588","\u2588 ":"\u2580"," \u2588":"\u2584","  ":" "},R={"\u2588\u2588":"\u2580","\u2588 ":"\u2580"," \u2588":" ","  ":" "},I="";for(d=0;d<e;d+=2){for(p=Math.floor((d-u)/f),b=Math.floor((d+1-u)/f),c=0;c<e;c+=1)C="\u2588",u<=c&&c<o&&u<=d&&d<o&&v.isDark(p,Math.floor((c-u)/f))&&(C=" "),u<=c&&c<o&&u<=d+1&&d+1<o&&v.isDark(b,Math.floor((c-u)/f))?C+=" ":C+="\u2588",I+=a<1&&d+1>=o?R[C]:A[C];I+=`
`}return e%2&&a>0?I.substring(0,I.length-e-1)+Array(e+1).join("\u2580"):I.substring(0,I.length-1)};return v.createASCII=function(a,f){if(a=a||1,a<2)return ar(f);a-=1,f=typeof f>"u"?a*2:f;var e=v.getModuleCount()*a+f*2,u=f,o=e-f,d,c,p,b,C=Array(a+1).join("\u2588\u2588"),A=Array(a+1).join("  "),R="",I="";for(d=0;d<e;d+=1){for(p=Math.floor((d-u)/a),I="",c=0;c<e;c+=1)b=1,u<=c&&c<o&&u<=d&&d<o&&v.isDark(p,Math.floor((c-u)/a))&&(b=0),I+=b?C:A;for(p=0;p<a;p+=1)R+=I+`
`}return R.substring(0,R.length-1)},v.renderTo2dContext=function(a,f){f=f||2;for(var e=v.getModuleCount(),u=0;u<e;u++)for(var o=0;o<e;o++)a.fillStyle=v.isDark(u,o)?"black":"white",a.fillRect(u*f,o*f,f,f)},v};P.stringToBytesFuncs={default:function(x){for(var w=[],g=0;g<x.length;g+=1){var l=x.charCodeAt(g);w.push(l&255)}return w}},P.stringToBytes=P.stringToBytesFuncs.default,P.createStringToBytes=function(x,w){var g=function(){for(var n=rr(x),s=function(){var T=n.read();if(T==-1)throw"eof";return T},t=0,r={};;){var h=n.read();if(h==-1)break;var i=s(),v=s(),_=s(),B=String.fromCharCode(h<<8|i),y=v<<8|_;r[B]=y,t+=1}if(t!=w)throw t+" != "+w;return r}(),l=63;return function(n){for(var s=[],t=0;t<n.length;t+=1){var r=n.charCodeAt(t);if(r<128)s.push(r);else{var h=g[n.charAt(t)];typeof h=="number"?(h&255)==h?s.push(h):(s.push(h>>>8),s.push(h&255)):s.push(l)}}return s}};var D={MODE_NUMBER:1,MODE_ALPHA_NUM:2,MODE_8BIT_BYTE:4,MODE_KANJI:8},O={L:1,M:0,Q:3,H:2},L={PATTERN000:0,PATTERN001:1,PATTERN010:2,PATTERN011:3,PATTERN100:4,PATTERN101:5,PATTERN110:6,PATTERN111:7},k=function(){var x=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],w=1335,g=7973,l=21522,n={},s=function(t){for(var r=0;t!=0;)r+=1,t>>>=1;return r};return n.getBCHTypeInfo=function(t){for(var r=t<<10;s(r)-s(w)>=0;)r^=w<<s(r)-s(w);return(t<<10|r)^l},n.getBCHTypeNumber=function(t){for(var r=t<<12;s(r)-s(g)>=0;)r^=g<<s(r)-s(g);return t<<12|r},n.getPatternPosition=function(t){return x[t-1]},n.getMaskFunction=function(t){switch(t){case L.PATTERN000:return function(r,h){return(r+h)%2==0};case L.PATTERN001:return function(r,h){return r%2==0};case L.PATTERN010:return function(r,h){return h%3==0};case L.PATTERN011:return function(r,h){return(r+h)%3==0};case L.PATTERN100:return function(r,h){return(Math.floor(r/2)+Math.floor(h/3))%2==0};case L.PATTERN101:return function(r,h){return r*h%2+r*h%3==0};case L.PATTERN110:return function(r,h){return(r*h%2+r*h%3)%2==0};case L.PATTERN111:return function(r,h){return(r*h%3+(r+h)%2)%2==0};default:throw"bad maskPattern:"+t}},n.getErrorCorrectPolynomial=function(t){for(var r=K([1],0),h=0;h<t;h+=1)r=r.multiply(K([1,M.gexp(h)],0));return r},n.getLengthInBits=function(t,r){if(1<=r&&r<10)switch(t){case D.MODE_NUMBER:return 10;case D.MODE_ALPHA_NUM:return 9;case D.MODE_8BIT_BYTE:return 8;case D.MODE_KANJI:return 8;default:throw"mode:"+t}else if(r<27)switch(t){case D.MODE_NUMBER:return 12;case D.MODE_ALPHA_NUM:return 11;case D.MODE_8BIT_BYTE:return 16;case D.MODE_KANJI:return 10;default:throw"mode:"+t}else if(r<41)switch(t){case D.MODE_NUMBER:return 14;case D.MODE_ALPHA_NUM:return 13;case D.MODE_8BIT_BYTE:return 16;case D.MODE_KANJI:return 12;default:throw"mode:"+t}else throw"type:"+r},n.getLostPoint=function(t){for(var r=t.getModuleCount(),h=0,i=0;i<r;i+=1)for(var v=0;v<r;v+=1){for(var _=0,B=t.isDark(i,v),y=-1;y<=1;y+=1)if(!(i+y<0||r<=i+y))for(var T=-1;T<=1;T+=1)v+T<0||r<=v+T||y==0&&T==0||B==t.isDark(i+y,v+T)&&(_+=1);_>5&&(h+=3+_-5)}for(var i=0;i<r-1;i+=1)for(var v=0;v<r-1;v+=1){var E=0;t.isDark(i,v)&&(E+=1),t.isDark(i+1,v)&&(E+=1),t.isDark(i,v+1)&&(E+=1),t.isDark(i+1,v+1)&&(E+=1),(E==0||E==4)&&(h+=3)}for(var i=0;i<r;i+=1)for(var v=0;v<r-6;v+=1)t.isDark(i,v)&&!t.isDark(i,v+1)&&t.isDark(i,v+2)&&t.isDark(i,v+3)&&t.isDark(i,v+4)&&!t.isDark(i,v+5)&&t.isDark(i,v+6)&&(h+=40);for(var v=0;v<r;v+=1)for(var i=0;i<r-6;i+=1)t.isDark(i,v)&&!t.isDark(i+1,v)&&t.isDark(i+2,v)&&t.isDark(i+3,v)&&t.isDark(i+4,v)&&!t.isDark(i+5,v)&&t.isDark(i+6,v)&&(h+=40);for(var N=0,v=0;v<r;v+=1)for(var i=0;i<r;i+=1)t.isDark(i,v)&&(N+=1);var m=Math.abs(100*N/r/r-50)/5;return h+=m*10,h},n}(),M=function(){for(var x=new Array(256),w=new Array(256),g=0;g<8;g+=1)x[g]=1<<g;for(var g=8;g<256;g+=1)x[g]=x[g-4]^x[g-5]^x[g-6]^x[g-8];for(var g=0;g<255;g+=1)w[x[g]]=g;var l={};return l.glog=function(n){if(n<1)throw"glog("+n+")";return w[n]},l.gexp=function(n){for(;n<0;)n+=255;for(;n>=256;)n-=255;return x[n]},l}();function K(x,w){if(typeof x.length>"u")throw x.length+"/"+w;var g=function(){for(var n=0;n<x.length&&x[n]==0;)n+=1;for(var s=new Array(x.length-n+w),t=0;t<x.length-n;t+=1)s[t]=x[t+n];return s}(),l={};return l.getAt=function(n){return g[n]},l.getLength=function(){return g.length},l.multiply=function(n){for(var s=new Array(l.getLength()+n.getLength()-1),t=0;t<l.getLength();t+=1)for(var r=0;r<n.getLength();r+=1)s[t+r]^=M.gexp(M.glog(l.getAt(t))+M.glog(n.getAt(r)));return K(s,0)},l.mod=function(n){if(l.getLength()-n.getLength()<0)return l;for(var s=M.glog(l.getAt(0))-M.glog(n.getAt(0)),t=new Array(l.getLength()),r=0;r<l.getLength();r+=1)t[r]=l.getAt(r);for(var r=0;r<n.getLength();r+=1)t[r]^=M.gexp(M.glog(n.getAt(r))+s);return K(t,0).mod(n)},l}var Y=function(){var x=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],w=function(n,s){var t={};return t.totalCount=n,t.dataCount=s,t},g={},l=function(n,s){switch(s){case O.L:return x[(n-1)*4+0];case O.M:return x[(n-1)*4+1];case O.Q:return x[(n-1)*4+2];case O.H:return x[(n-1)*4+3];default:return}};return g.getRSBlocks=function(n,s){var t=l(n,s);if(typeof t>"u")throw"bad rs block @ typeNumber:"+n+"/errorCorrectionLevel:"+s;for(var r=t.length/3,h=[],i=0;i<r;i+=1)for(var v=t[i*3+0],_=t[i*3+1],B=t[i*3+2],y=0;y<v;y+=1)h.push(w(_,B));return h},g}(),G=function(){var x=[],w=0,g={};return g.getBuffer=function(){return x},g.getAt=function(l){var n=Math.floor(l/8);return(x[n]>>>7-l%8&1)==1},g.put=function(l,n){for(var s=0;s<n;s+=1)g.putBit((l>>>n-s-1&1)==1)},g.getLengthInBits=function(){return w},g.putBit=function(l){var n=Math.floor(w/8);x.length<=n&&x.push(0),l&&(x[n]|=128>>>w%8),w+=1},g},$=function(x){var w=D.MODE_NUMBER,g=x,l={};l.getMode=function(){return w},l.getLength=function(t){return g.length},l.write=function(t){for(var r=g,h=0;h+2<r.length;)t.put(n(r.substring(h,h+3)),10),h+=3;h<r.length&&(r.length-h==1?t.put(n(r.substring(h,h+1)),4):r.length-h==2&&t.put(n(r.substring(h,h+2)),7))};var n=function(t){for(var r=0,h=0;h<t.length;h+=1)r=r*10+s(t.charAt(h));return r},s=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-48;throw"illegal char :"+t};return l},W=function(x){var w=D.MODE_ALPHA_NUM,g=x,l={};l.getMode=function(){return w},l.getLength=function(s){return g.length},l.write=function(s){for(var t=g,r=0;r+1<t.length;)s.put(n(t.charAt(r))*45+n(t.charAt(r+1)),11),r+=2;r<t.length&&s.put(n(t.charAt(r)),6)};var n=function(s){if("0"<=s&&s<="9")return s.charCodeAt(0)-48;if("A"<=s&&s<="Z")return s.charCodeAt(0)-65+10;switch(s){case" ":return 36;case"$":return 37;case"%":return 38;case"*":return 39;case"+":return 40;case"-":return 41;case".":return 42;case"/":return 43;case":":return 44;default:throw"illegal char :"+s}};return l},V=function(x){var w=D.MODE_8BIT_BYTE,g=x,l=P.stringToBytes(x),n={};return n.getMode=function(){return w},n.getLength=function(s){return l.length},n.write=function(s){for(var t=0;t<l.length;t+=1)s.put(l[t],8)},n},q=function(x){var w=D.MODE_KANJI,g=x,l=P.stringToBytesFuncs.SJIS;if(!l)throw"sjis not supported.";(function(t,r){var h=l(t);if(h.length!=2||(h[0]<<8|h[1])!=r)throw"sjis not supported."})("\u53CB",38726);var n=l(x),s={};return s.getMode=function(){return w},s.getLength=function(t){return~~(n.length/2)},s.write=function(t){for(var r=n,h=0;h+1<r.length;){var i=(255&r[h])<<8|255&r[h+1];if(33088<=i&&i<=40956)i-=33088;else if(57408<=i&&i<=60351)i-=49472;else throw"illegal char at "+(h+1)+"/"+i;i=(i>>>8&255)*192+(i&255),t.put(i,13),h+=2}if(h<r.length)throw"illegal char at "+(h+1)},s},j=function(){var x=[],w={};return w.writeByte=function(g){x.push(g&255)},w.writeShort=function(g){w.writeByte(g),w.writeByte(g>>>8)},w.writeBytes=function(g,l,n){l=l||0,n=n||g.length;for(var s=0;s<n;s+=1)w.writeByte(g[s+l])},w.writeString=function(g){for(var l=0;l<g.length;l+=1)w.writeByte(g.charCodeAt(l))},w.toByteArray=function(){return x},w.toString=function(){var g="";g+="[";for(var l=0;l<x.length;l+=1)l>0&&(g+=","),g+=x[l];return g+="]",g},w},z=function(){var x=0,w=0,g=0,l="",n={},s=function(r){l+=String.fromCharCode(t(r&63))},t=function(r){if(!(r<0)){if(r<26)return 65+r;if(r<52)return 97+(r-26);if(r<62)return 48+(r-52);if(r==62)return 43;if(r==63)return 47}throw"n:"+r};return n.writeByte=function(r){for(x=x<<8|r&255,w+=8,g+=1;w>=6;)s(x>>>w-6),w-=6},n.flush=function(){if(w>0&&(s(x<<6-w),x=0,w=0),g%3!=0)for(var r=3-g%3,h=0;h<r;h+=1)l+="="},n.toString=function(){return l},n},rr=function(x){var w=x,g=0,l=0,n=0,s={};s.read=function(){for(;n<8;){if(g>=w.length){if(n==0)return-1;throw"unexpected end of file./"+n}var r=w.charAt(g);if(g+=1,r=="=")return n=0,-1;if(r.match(/^\s$/))continue;l=l<<6|t(r.charCodeAt(0)),n+=6}var h=l>>>n-8&255;return n-=8,h};var t=function(r){if(65<=r&&r<=90)return r-65;if(97<=r&&r<=122)return r-97+26;if(48<=r&&r<=57)return r-48+52;if(r==43)return 62;if(r==47)return 63;throw"c:"+r};return s},tr=function(x,w){var g=x,l=w,n=new Array(x*w),s={};s.setPixel=function(i,v,_){n[v*g+i]=_},s.write=function(i){i.writeString("GIF87a"),i.writeShort(g),i.writeShort(l),i.writeByte(128),i.writeByte(0),i.writeByte(0),i.writeByte(0),i.writeByte(0),i.writeByte(0),i.writeByte(255),i.writeByte(255),i.writeByte(255),i.writeString(","),i.writeShort(0),i.writeShort(0),i.writeShort(g),i.writeShort(l),i.writeByte(0);var v=2,_=r(v);i.writeByte(v);for(var B=0;_.length-B>255;)i.writeByte(255),i.writeBytes(_,B,255),B+=255;i.writeByte(_.length-B),i.writeBytes(_,B,_.length-B),i.writeByte(0),i.writeString(";")};var t=function(i){var v=i,_=0,B=0,y={};return y.write=function(T,E){if(T>>>E)throw"length over";for(;_+E>=8;)v.writeByte(255&(T<<_|B)),E-=8-_,T>>>=8-_,B=0,_=0;B=T<<_|B,_=_+E},y.flush=function(){_>0&&v.writeByte(B)},y},r=function(i){for(var v=1<<i,_=(1<<i)+1,B=i+1,y=h(),T=0;T<v;T+=1)y.add(String.fromCharCode(T));y.add(String.fromCharCode(v)),y.add(String.fromCharCode(_));var E=j(),N=t(E);N.write(v,B);var m=0,U=String.fromCharCode(n[m]);for(m+=1;m<n.length;){var H=String.fromCharCode(n[m]);m+=1,y.contains(U+H)?U=U+H:(N.write(y.indexOf(U),B),y.size()<4095&&(y.size()==1<<B&&(B+=1),y.add(U+H)),U=H)}return N.write(y.indexOf(U),B),N.write(_,B),N.flush(),E.toByteArray()},h=function(){var i={},v=0,_={};return _.add=function(B){if(_.contains(B))throw"dup key:"+B;i[B]=v,v+=1},_.size=function(){return v},_.indexOf=function(B){return i[B]},_.contains=function(B){return typeof i[B]<"u"},_};return s},er=function(x,w,g){for(var l=tr(x,w),n=0;n<w;n+=1)for(var s=0;s<x;s+=1)l.setPixel(s,n,g(s,n));var t=j();l.write(t);for(var r=z(),h=t.toByteArray(),i=0;i<h.length;i+=1)r.writeByte(h[i]);return r.flush(),"data:image/gif;base64,"+r};return P}();(function(){qrcode.stringToBytesFuncs["UTF-8"]=function(P){function D(O){for(var L=[],k=0;k<O.length;k++){var M=O.charCodeAt(k);M<128?L.push(M):M<2048?L.push(192|M>>6,128|M&63):M<55296||M>=57344?L.push(224|M>>12,128|M>>6&63,128|M&63):(k++,M=65536+((M&1023)<<10|O.charCodeAt(k)&1023),L.push(240|M>>18,128|M>>12&63,128|M>>6&63,128|M&63))}return L}return D(P)}})(),function(P){typeof define=="function"&&define.amd?define([],P):typeof exports=="object"&&(module.exports=P())}(function(){return qrcode});
  _sfQr = qrcode;
  return _sfQr;
}

// Montserrat 300/600/800 (latin, woff2, @fontsource/montserrat@5.3.0), SIL Open Font License 1.1.
function sfBrandFontsCss() {
  return '@font-face{font-family:Montserrat;font-style:normal;font-weight:300;src:url(data:font/woff2;base64,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) format("woff2")}@font-face{font-family:Montserrat;font-style:normal;font-weight:600;src:url(data:font/woff2;base64,d09GMgABAAAAAEkAABIAAAAAvzQAAEiVAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGoE6G4GYYByKJAZgP1NUQVREAIVMCHwJnxQRCAqBiDjtSguFAgABNgIkA4oABCAFhSwHjzMMgygbEK41jNtrhdsByL902RNHI2K3Q45H358yMhBsHEBiRk72/39PkENkQaoXYFur/gcSwqQqnNtFdRAuXDGuxhfRHV0Tdfczqq23uoJWbYkGyUiuhRkSwctAHpQDSAg2+Ygnthc+iYxGnLiTBSsnka5oyV4ZyZvY++Gb0T9gkczt9JdKe+3mqxyTruT3mYUDdHKY/53mRE/u+qhB8rozsG3kT3LyEv+035d1br/5s4CgN6gAkOWqELjIsIpCtMR9PD9d/3POvTdyo9I01pKm8RapKWIVD5QgolUF1tDHR0QL2w3QLVrEtOBr+E+H5+fWs4YzUWDEWAVj2Wz7q79KchssWENv0KJSitlX4VXJFRfttZdehqdXJUSxpNXds0dOCnw0KgqJJTss0mIU2ViM4t3X+F+69P2vldiEF1iPshu4OIg7lu0AGVkBAgVIwTJFmVIOUNGnrK8AwBffmS8lzcCKh4yW1WuKsMfQ394Y+FJVtW6e1/StDVvmUqobU5jCnA4pcIHEQNK9ZENkXmJepP8A/zkP///ZMu8fqbZnn6AEf6HWdvnMaUMbOjFTqCA1xo4BQ8xSAkgJcn4N8A8y0WI6K4clDzmkYro1y1C/tJWvMeGco62SoVUdatcx4SyaFurcmjNIi+WYPofYP0uePurCTwkoADB0ze0JF2k4lOFAvikq13lhsKRmNssqgW///3WW7b+G3b/E3q2ANEuJs0UToBLLlKlycvqnLw/80cCfYdtLYAWtoJWwAgBVasTqawllLdoBIreBosnpU/QpytT1dCmqQFT79dq32zWB3dC7C6EiFOY2+M79GBnhHh39+Qw6QMIxqFRUlERQLipCxkVFKJn/M9Ws/N4MRiApOWkkOWTRKdOhV7iYa4fOddr9fxaD2b8LrJbSE4JAisIlEEogeYHSBSxI0IsFw+ky5RBCFSIdYizvuYpVLN26j52bEnZu7UquOveuCpsM08pI2ORjG1t1VEoJYKxwz+vnXlXv6FjXsYiLFyIIXSl2SPbH33SS3o3o/7fLLdzRvfeedVZWkpWVjIwxMpLkiX+MzQbD5S/91oWBgoByikOMzx+ZwEzANOBqLJiQEIIVKYaQUPqC8SEKiIoVYtcT0lsuxG0CZJJCyD8I8wUBEQIxwhgaScfIlY9RGjzGbuiOuxoFghDAImCGFiFSajwnGIySiAPIK0pgRakZcfCnHwABk8QrR+74zOYDphMKerPAdMq0eAaozxzanwcmJKAbgoxDALXNS57xrjcPuonhEiwHxrPGL1Yi38fCxAIGBBKFARQM0GAg2Av/qEawNCevmSaKZ5pJMQghNAyN/cIMaHgAl7gysuHDldeFYfLlSNNHsljhQtmEM1U/UGztAKVbW0AJVGNt7Rw2m+OD4xXxsnhpvICJPyVivhCIQjQSIIlKNWrVG6hZuw6dugwxNEGG1Pg0MknmkUPgY8nZSETXi32oOwIKCBY0tJIPDUK4MDEGXMNgQIXxLXDlmEcQ+I53alyJ5UQj3/ARyQGGj33pA1jM2sk4o3NmcEhb7y5usQlN4yI93msb42hGPl0Q5BjzGEcz8hEimCZI7OtLf/e2F5J91J1MXiu9Fzpda96aiGJ5u9va+la2tN+aV23lFdaPcvIlZw0eVmuBXFnSp/ZeaaHZMqVfStVJ42MWxigD/fCTH33tMx94yyue0+xJW0ri4Gb3u9PNrnW5i7n8X2y02lKL9po1YcRmfTo0n7atU2k3XVoMVKtSMTbMRQwE8DcUa96ZnxjNyjXaqjhn9sZcLO9IkYNzeUO1oA1DJ6OfgyVezrDWmprn+Ia8hU8iNXbCcOmMJiTRGwe9R7HEyzmp263uACsetViZO9Vf6xp7aeUc8pKiW8NJJe0wGhaHMMII09AvwinmasVSsxtuEYYFCxbNyqv2XYG6+5qhivnymVCdNwWU2rLCpnaQzGQ22vHUhmyYCgootWWFg0V633QXkPetuqoVUGrLSt8CrGSgekTx4MGjFWA2y7UoIWaZWTm4nyHG7UTG0xhTFdkdQIGF7mTpGM7+P8wUDDzzfbI33jhsQRDjNbZbLCUt7hkuD3Y7yXjJ1Fr53gn5/OLf29/6wkf73/GaFzy9c6tem7wQ7v7UVte70qX+5rx/O9da7h0LT+03v+0Bx9ixptXA6V1a1KvuhPvJUJMRMn9mUu8L1UrlIxbC/w6DHz756PWVz6CIgMABtLRhIMMiz2cX+wRPVW8pOzhgEEgIbZT3a+TO6bx4YytrQLEyjHCKCSAv6ptT0gEOKBR2kplsx1M+G7hPri1wVvksYjED8VBDIcttUesYqCCgxskBrnlfWlZ+HHoKJohMMlBkvK8RCGAOMG2XSMQrJzZA3NTZWND39xsDE+BpNkgw/YNLE7CyAPHiFYVKAABKGUwAM8AehnY/Aow9qDmKITGi4NgLwAmecIwSrR1KLReCDypAvVPiY+Zl2Jm7HbXBIjmt32gK4xguYHRzXdeASIjwpNjJH16EuoypU7hSIkofI+49raFcKKd4I4olk8f1MTlcdQSjLQhcPfBVUG11Z+pvNvvjCWSgGpFym95TQkgMSrkw+w7miisiem+rRDibh4aSM5l/AAA6mFWjTCTMoLTKS9A7rYAgABVA76kec35IA9zqmnEZ7GlvagmeEJ0XzVxpFRFRmHltc0LInqHzHBUREZSnIMaH7QCC+/R47ZFMqgokWwfEHdY1V0RmszH1sNAwVi7L8CvnkTM3E8IJnh8p98gzfMX0eQC4udx5GQpbt1aZDKrIOmq10zA0QiTwRQBR7jDCoDyOpGMoHzSBvqUQ4Qe7VFJQTR2TzxO6RNG49nBUwwynccmW9ijeay1U4e9izzLICo11TSkuTIs4SKlBBqEj0OmOVh828DG6XaBTBjYr3TFpjSLHKiAZRMyn4KhDxkww7ZvgQiXjivKps2+qXo24lT8N4WbBMvlqxEuYZE60DLW/aW3czKsilMYFHnDi8YO4mB3bFEd811mJ12OxQo8UlBKdwWR8doBfFELl7Qs3EpYbkXubXnCp8qCtDwR88RFs4MBWGUAyZWM1elOvYFcRNRDx46kGU6bbBFucA4lV4YZSbidf7cZaOOXTwiw5sIUO2iXw3O2xdZ70K5l5y41lZZiy05IrNR1mRjYpB10aF5aLmXRoZY1fMjDCT2PKk8umkY7B4HdxepDidq+z0LD6JHpUu0rmMmUSlOQXd2bJZPlOiAAUHwU8X/1kFxHKEOnYcvDYfNhU+WLOtxbB1gqU8906G4qLtY30disfrzbwljNyQgtBIxKJClyIPQVU5ViWX7G4975+uo9gIhBPazfvMqTE6jOdci0tPOvUq76qyUu/o0W/QTpqmU7NviwhS8DURwuroDuZ7Sj7Y9m0DDMDOkgd+B2zlrSA4yfXtaI8f4MNLAeXZRDNVNRxND2jL7C2ias7mlo5W+EIIYwCkzChXgfYJG8kHQYIG+UiX+cZy3400pND9BZHevjKcO3+sAttnlRXU0OL9Em+Mvbx0Ig00LKh3Hqpg8wFf6XOeVJ4ZOo0rag+nHh0KcvrRrNIQx/yCHjCy9+zV72FXuTanKNxwXN67T4K97e/Jfjks0TffNc0mEYPWJTyRdIqpFalDFIlO6mWGjXST62k1clA9ZKvwfjzSk0oBx3C9DskpVmq/SEFvNLo8FCpI45CWqRCq2Q7NpTjpFOQNml2RuqdlQbnJdcFqXRxKNcll1GuSJarUuaaZLkuZW5I5KYUuiWR20OF7riL4Z7E7ku5B1Ln4dAAjzyGPZEmT4eqPPMcQ7skvZKE15LnjSS8lWLvZLD3E9k++AhBuxqSXyALUuS7ApUAbFh0RYYBMyb06FDTCSEyCNgQaBERoMoFFpzduY47QUEwxkmpc6Q8BQ8NBDQqaFQqBlXFcMIE4QdJIIgg/GHCh0IAAwkW5YAHRm7oaRAQfycNEthfIIwA9IsB2wKB6SIFY6LREB4pRE4D0TJCrGwQBwcUqV+m/wgEYROiNvxy/VD1cbKIQSvGTdr9FyZ9+vAZSCUDTODgvBYvhefzHFzkvcdBdeqd1aMGfik+zcp33Et7qV6oct7jMK4J8sAQ2bjxQrHmIrU8rs+yU4qud1Da39c3irjZsPnmLB2AsNBv7sVdhFi6/Xi6dsXm2HWiH+SG/Mb3NTCaYNRg7SUASEk4/Ffo1Nm89JxLXMiFuqtp6Mvv/FvTSGR3WQQ38hh9Zg90K+NoXcnGo3b3Gnd01qTrJ4f1I6FCZZqot5bu4XYBIaP/gtAa1H+VWyjd2H3rgC1QI17HBGb7fLkUWqh8U9n7ScLCiVh7S0NlU4XrwvaxPjYUAKD096HqzFsLgXMjA33mN4HTdA+Yk49Lfs8uOnaHyTtlX9yRlkuZxODEg3ETOg4ecKNVj7UPc12E2DrKLgbezJl3Z18oJN+XJMY0F0DZvin9eV5+sELKppcKlapUq1GrTjOvNmdcdN9DTzz1LjFgEjY2SC+9MFSoQKtUSaRKFUFtItjEqkqIX3cQs+Igbk0hxMSpIIisBQhXAcST/0JIlLQvSBKzXAdCVK+ZcukRpi570AjKHlNLoIkVdVJHvsgLESK6U6T5WjFNNFmuNuMK1+mzCpNrhLCWR9Es8E/qqtH4rE/STb2ATBvej1wCq9cwLho+tWp0W0n5Kj8MdtWaqyV6YYXiZznxW6O7BJ0x7aI8qF4V6b+oGu0ihgo2Cs0U6Vz5h09TnIujrHcipH3Pk1qU3bLWa4qv4imq/TMbPHKFegeCcjRtLMe1O7EzJ5H8ok4FWB6Cy1iMvaOdwNSXX94XrTT4RE3sbqJjDGuV0eAspI2ySvNBWaCbyPLBfQz3CqbfaQzMu59t76M6d3m0Xw2faKejtea7foLQ3AH1kgSX7kxbtAQ6409Tzw8iYTGAOzavS0nVdU4t+ukYBqodTLmiyt3wWFRwgkePlrioiqt3/ujgJrC8xewqibmPQZAkLGpQ5UygOr1yiQWyHZQcjXttGOeZelNUz6z+c+1pPeJDyO4m+FGQ5GC+/arrn6SU2tMW4yASqNkNI7HcgW2x2ETrDRI8323ofwfX+HehBxW90Ya8jNTk2KjW3dSMB3pKlvb0Be8HMmE1DmXVykVHpx/qWJUmPX6ww+nSgfs94CEPe8RTnvacF7zsVa953Rve874Pfeozn/vCl772re987wc/+8WvfvO7P/2jGhZOldLCgQMR0Oz78kP2OkNii/bC06E+EG13gMRRUcRSHKYjXR+xK0Tq9IhBHBODOCaqqLQeHa33b2ijcyM2xRrt9Gxo2a0RGRvquzVzPY1HL9noNN2RSJqLU6IRuoR2oLT1UGn7GhtsSck7PbwsUjQeUKQkht/JnN3LoZknBqJfD7ipbcw/EMFvfsLz8GvKndcjUCpiJc80TPNleFhvz5ZtzFSS4ivyeddgkziyoR5/5jEfgiK78sqtjOi6PlSxARxhcL5hRFHkrs1nLUMuzLRIdjbqrJhw3JQE8tH6WbilVAk8k9uhHRUgJ8C0iSTwm6uSj956x8fqEkMVhfLAsx+P5ULeue4123vBkTBPB8NGA+GihOH0PfggH8poCc+a9nC/TB3ew0qt71JeMuTz2HxJiSJkmzCcE46kju71dMDsv6OhXoGL/yXkOlftECEEDLUqbloSNK12JQvEqUGs4Y580+NisUpKzlVEWb0znzjcooz6CEodva/qOG2sAhrBraqUVlVVR1jtGXyXh9i658JqORbD4+/WWPYTiJWL6jjfBC6ZN14Y/6yWpw4DFm8FgdW1DRsJgO2yWtC1mZplvbcqr+sLX/F2be5VSZdxPUjCNDsBa9+T9iyJ3+HR3LEZti1ZdrhahEb7qOo4ogV00exgxsEdBR3AzGW0DsHUjlRUHoitA1wTcnamtOT6FU1Zn8tQbVIA084Jv+0RDp3TO0BxcZtPqYuNDER8I6f474WEqKA2rBnVgIa2+XGnZriZMBzP3IyWmmwnBUY35+VzXNL1xOLTrW9ZcjpMWGYoJE8HhAHEG2gIspQFNZ5vU4LrMoZOzT2E2kQPKIVvXEbCehGEPQQShnRBXddDbfk5MVE8vJF2eLtyKKTajUWY1N1ngnnGNvdJ0pN7BOfXbgvwB514bgtnaz+Vdsv7cc817bFg5io0ObmeN7ftThKdLNV/BunGH0L0ol+Lwoaocuso0au41+5QGYpcTYTw65ohV0aq458YxpwA22YeJu6iG9+uAeizWE0OZE0XX3WRo6G6BtH0HfOv7cNUzvxnFqX0a642gNRv90NZiIa9Oq4v4/DfXIFkpy8BZFZGsXUhNipfYCy4Bv8SGc6355xgPz3s2xLoJNF6t4sib73dvlljUiFeL1g1FJzezqW2bcLmIv+mz3fpasZsd+seZnsMIA/Taj/4iBw1tG8ukPOkwG/Ou2OdDWt/V/2y9lROSmrmDlrnuA6EJeRscMjKBe3HMIhL4p76mLRxwR9mzDxlbii/AbDatRpjfGi2hLGqOC8zM2lHeOWVpboVwuqX/uNLG/ROrB46u+iYbS13nFkNvaWrrvqTPi0l15Xbyqb5HIcoMOig0Dbydn2jdRSVWF3lRLXIow78dRIzVv088k4OjoRr2+jqvL0jf0SKCfloalENUme3PM19OyTK7BB3r7Tok5ZGI0CXcKd4yHQFwT5NrW2yjFdzqY7mzMCmoAxVqKOTH4tnKy51V8bPqUxiwDW6lo6KNkz9GPBowfSABsprSXb5FTVuQkgHYl6N8qZ1SS9ukv85agXJhX2+XyTrz2XVzOwF3r+eqlifQXCaMwJOhQP1VDQ+TyWj21Q2/E4VY+9UOZxNVWPZVD2QTTWD6qKON6z/rPH/debBxkLYWGg0hIOLwCOFyMgQ5DQQf/40tIyQABYEKxvEzo7g4IA4Ocm4uHCE6IqpmzB84cLxRIgkFyWKRLQkbMmSkbrrD0uRwl+qVFiadKQMGSiZ8pDcBhAYKB9pkMEoQ4yGjTEGZayxSOOMg403HmWCCYQmmog0ySQik03HMMNMtFlmUZitgFKhQlJFiomUKGVRrpxRhQrhKlVKUKVKnGrVuqlRo6tatYzq1IlVr55JgwZhDmji56BDdH73Oz/NmnXxhz8E8fKKdthhdkccxdWiRYhWrQyOOSbAcSfYnHQKV5s2ic44I9JZZ0U577xAF1wQ6qKLAl1ymZ8rrtC76iqHa67Ru+46hxtu4LrpJrNbbuG67TazO+7Suucesfvuc3rggQgPPRTjkcfEnngi3lNPdfbMc1rt2qm98orKa6918sYbKu+8k+S99ww++Ijrb3/j+uQLrm++Cfbdd9bEGIMrscaih8VDWFjY2JhoNB4OLikePoKABJOMjIicAqKkxKBCI2fAm+sqKnpk8mBjgWSyxvX4FBqhFGrBEFwhFn5cWEuEJSFPobTWg1xPEJuSRUoaJJY+lC1TLraBUief2CvHDzsKabTRYgzgUyg2lcX5yBQCQUuOYmLjioyIIiNySIIQkmSfjPklSWZJklPyzyYF5JH8MyIkJCG+kOQNbXqJmFYC0zTZbqV5Cy/9XCcYZYgBRknTA8InZeeCC2D6aUmRLks2t3HewrJoZaNhbmoDqCHZKIhXAORYf4qUDsmikc0gVwJClgDZdHIFIGUxy6aS01/KJUWcSAru4Vgru/fsdwlpUwqCXy+9yC0/KHbZuJKBfYH9gAOAA4GDgUOAQ4EjgCOB04CzgGhjhoBJWpMFMVtMrKbVU8U+jNQvWNu9NuBh1g5a3yaH7OC5x6w9tM1r97bpS30O1J7kgR7rtoPh9OvWBXRjAYERmFjYaMvWGVun0mSZBNZ+pnp8rZwT3uS6QfWJ+a4cKD25tz0KZpyZ6mwHk87simbBmF8xTORPyzl7INcL0s6dSqDPheoRk4GQCangC1qwBUewuPy2b4RExEAIgDGgkBiYFC1njF3OW2Ve//acR/zFUTLUyIdP2l3zCXnva5Q8LiQW9CT1/rAYF0NxOV8R7a6OICkQ8Ln1erTxizP6JzCk0QLwNLGtP3QGUExoBEQMcQABZsOQhVYADaKBiO1ypU08nZtvcl+cT6p1mZTUeQ9aeHm5hlhuHYhpPEiOgaG+Ob+OHIHtEtGplwRT75IPrQdTFFBMHJ36tgxhTIfbCXkDxERS2CaT8mDuD1dy/1fCVDKje4ychoINzaNK4iludSxF/m88PTgVluzbIkc/FkIEKT5WROAQSAjmixgcCkgackJ0+IAjQFyn4AheDSHDiEIgyEwoQgZ1+PvgGaPSLQHDPRUtbl55YHp5eQzx8RuxQJAgoZmFFZCJeY2gjCBufOMq1fqp0V+tOvUaNBpgoJ00GaTZ4JuEuSXCRLs1EmXfVJxEzqrinAM8JIWOAhSbgzdMJsQy4W8+bJSoKGvcbdvUkk7nXdLitucuAu1WdiMrqUYoULfrBrDHG8/RhCYe/cTXglOA031PDtpTi4cWsGoucXopYDjIZ+4DegSg5uUFrFgUhstgzi9bc9glH5L9ywD4nyYOW4YBkSK9BnG0gFrrQObGU6EAoTk+sEuyDv2g7yoehQVM5RSh1HYdEQoxs8VOdqd7gwiSYBMBE3yfrT+vv6FX67V6o96k76yP1CfrtxuMhl8NC4xio6yjA2AqPZdIq+0MgpuQ0bk5QDSCNeO6XqnXnHKoPuI7sN9GYF8APdYA8P/5vrAvBAD//XSyuPmm+wFfPnXBvVcd8Wjqw5aH4x+WHzze/G1AADsCx2oPAPK0qwHIk0ejOkN51OX83/K8Znf86bXv7rvrjLNafNDkpANaHXTIf/7xL697EBoHj4CUjJyCPy0dPYMAVnYOTi4hugkTLkKUC4656Ku2dCNasu566i1FqjTp3AbKN4jHEGOMM94Ek0w2w0yzzFbonBfO+2y3P7R765V3XnqYrjxS4oYvHieKpz7ZYWfC+OaBI4lmu1I3bbXFNocxYCQWChMbl4SQiJiGipofPqMggToJZvIXs65CddZFJJuJ4sWIlShOgiQ99NdHX/3kypQlWy+DjTDUMKMM97eRpptiqmnmGKuAxeiojWGqvC+SURH70tCI93K9gCgvTCFlgWtA/0uN/m9jhU0cmWbV40lIfuNS31Xy0Cp4QpRZlvCJPzll9ST39zxbwmksR48cPjQzvX3b1qktkxPjY6Mjw0PFwuBAf19vT3dXPpfNpFPJzkQ8Fu1oj4RDba0tzU2NwYDf53W7nA67zWqBzSYj3VRwrT7jr60WwyDhx5sznV2zGIQKfVNnOyszCieBWw1OeIKZipvMpHlinQuWHQyEavy1aa3p3aZglGaAxjxdyP6+JnOeTFuhRuewXcQWFzopdyM681EAJ76IXu+bl+KAJuJgE+KHEK3IBPRpfjLDUq2qsZneP7Kd/DKOEz4wFjw7lo1tWvYQdSzi49gXrVTJATihUosF2Ze+4kJoWiuQc9swNFbBCucp84Kt8ZfBFxQhUyI4ipcvRTsKmmN7KWfCwbxtWDqRQiiVPzWUny67XjczunJMb/qzqd4MtlJq0Vz5zZD8ysRJfBTyCm81mBQmxUAglJKD5kh1ZEYebcEWc0xkJK6QVNNCuBUeOxwgrGKvtpCUtpucVwlhbOJiledllOlV3EvVTjoEE4q1OoYZjfLRHpyxzSlz2pzjKi5luja/uvf4jwCf8D2iKqqxTMx2/6Fs0TZsCxd/9sQzuBUZ7tcwmplkxx+q1LFh5Q8fbuW3CFVUerG77qPjW+h1m8zHPZu0JQWwqjDaE4PlMLMMsbUXzoVuLFoX1iA8GYOW9VmS8MZyyI2NerXJtbWPJ5pM23aGh6l5/oSOXs0NjKzA9S2eBkuNVtyP+2MMoVYzei2s9sllF4z29zjVfe1tEW7CAZo/rPJLzCRUtc/sWyR2oiKIN48Qxo8iN+w3+1MOc3eBmgH/shtuqPNeU14SwbyUnd2GBJnCcIKIH52/IoEu50Kn6uxSk3HcP+l1J9NsXviXB1Iw2kiad9P4MZ1WaXGZJ86y0/svHHc/CdTZhoPCWEzsDjQBWRmuXNrDidbN6VMIRcAgf4dtS3/wohWNTvISzOVn8EANhVWyUg9Wx1dg737S61YrM7HjjskhLtt7Ua22n1OLxELk5RVYZsvbxB02W0MEhzwuCt8E1fQwN+su+Nk0XcVKZuJoHcwlRJ/LmGWKTSlLNVKMR7R290WabGdfjqLFGdJ/1u37gxFCXUcSamJ6LYfzFheDj39vCdkCqazlW/yMGfmADYz9VcrS1DG5TruzX/j4yiRL6wKEfjOnrc1ydq6FLMNlzw6604k0JA6synIQsj6KYTWxwfoDZ5XbJdomw4Iul15WxXrKVqiYdHAsxLj9jMEdkkOFDbsMbilACo0CxRbGwLEVgFKex3lB44Xph2kEW8PRoyesD7nqOW0g50RlJSCffcRTYIDTpbZhF6r2DDCC1vYUxsLzZ55qPE+Yjh622tP6XO7UsUNM1+ZAsNqvWSN1qqlP9Rwkm4EG3BEKwm2oVAO+wrx4vpbGJZ+nT6obhbZf8SnXePryBAwI+uLJxczOXiuK3HJjB0peoIH2TKKWQlhxwSiOMBM6m7NK4CHsi507yubbG8yCyA3HlMuoKkKnQHLOImI+84LLHtY7EA1zKEuGHwQgsaJnlndNephDMT5Fpmw/hkpCbXaqLwTpodFLJrF/kC2VljSJYWRkMRRNXiFAjWxJF1Ba2Hb39ACR+pwKaSR/5B4FmFx1IVqVp8PWugauXCotoKmFWkNkxVI/WqRjc+wUO+utc/gnnHeRaHWxPmk60Zh2IM6xO1mqcJ6aCINe02p5PwLqjR2DHa9BVS+bXtjkEDSjQHywet5tZEFTAOb+6hD+lUFefGPF/ImZyS2ouSM6qD4f5Smv2+O6l258KcCO0p06aML4jM3q3u6WJg3J8dKxcXOxCu9OfZJ+gVhN3Dv2mHNBdL3onHqoRcxIDgd4Adz9VI6bIfcKYh6FZ9dH6Ihugj715B2tnezYhK/eEa5mLIDBnkPNu7VSnr5gncVI77UaLyFQN+EKKIiwZB+2Q/QVS94NrsKFlMIP62ybOls1tY3+Nmv7J3eZQyUKWJdLpUNlpFQaAAwH+5KJUzmxZQI2YXL7vokfbh85VuSftdDOyOFr1syHc4uYPDOCXt5nbuoiyMQfayHHSsfHEWiqYalbUGb11bh5oLt2LXVQymY8onno+oHUDwFjRpZHxbhevSPwyPe6mntVkYmnIui85zSwX/Wm7jiPwniQIEymLjAsuX7tT7oOW333v7sBAKLVxmvrsgVrpAPP5bmBQ87kS2t2On229Vwu5DsAqfh/kXIqnWjnG/vfhoKwfe+44ke57ncNa579VvDy2JLeJ4ikisO5GBTlPBntC3ZwRc3nK276VF9hsp0pnMwmxivMW+Gaqj1mTxUs2/mOcZAQhJLKoTcDaK5UXmlcFfZ87sBvWKiU9V7d0mz9XJ7HS9060cS3FlfgaAo72r+25zkNKH7IOc6PzCH0t7HsmcmcmfSXqxv9pRznUt5DQXHBWf7SwdBQMMNfuVoDQ8rXcmQF4A+OXQ6ay8WNv0kN78sLxjBiG2BEcp1sgZYt7eQrFv0SWtB8qWzTxE5k/1N+Bz5yurXmrZ8Bcwtp8gXPWI1JBTsKxFLYr47YRp3SCXa84y47KFXwklXbR1Ca1II/fEOgSioAkDEAOANoq0Htf2j5CjjdBmKHAQAGV47buOcomRDVFA00j2HoIC996SK5vdnpJE2tF3GR5mOrGC3OiehQsXaEqpMwuZ1XoCtD+twMfr4cuu3Wj0cQxSGlqhbaHz9me2pSXb85ldf/AOlK4Ac/hQCgEJWsdhowh74jvui3nus3jWdZ1ZYwq3mUX2uq2gALI5emtK3ryx6NLY5uxEx/OzWllKFFqAtKUzzqp02WFEnjP10uSTMWnBJyvHSEBgDTYziPyObUhZ3Nwf3bNqO3goxpbEiZzldarKxebZs6C4RP62O1X67f7Gn2921+inXLtc8KW0PZeLG8WSxWb3iMoxVhcXAI57O1kT4trfEjWx6PpSwLSu1oc5VOLlGsX+b5z4MV5NL5rUH7IxjrLaAsAxokEdnwY+oYZYQxrqyYzfNnaKHHkqdDae35qkIlVaaiiOZQAiWkAMaTAd8xeWJ0pXoIwGc1VMH7YMpSPcYqUgpnhVQNPdZiFVvFbrjc3J2CGqC1ANr71an8Hgf0MCt49pQjEQLHwA9FYlucVnpNrEtNPQo1EaA2pPZAaYrcSLwUXXL+Z5N/1iJCRkuWd+QMOVNruwr11Ci2QFkTHtmj85LLixyCnKpNj6kIhVWeHBeUlKwNqXJUHVWK4LN1CjVLt13X0hSJoIIEPqNV1CDsVysdXAHfrVYKQppJvBFJr1iXbzdOkTOPGy9pxp9TAkRo8kraEqcPCFPqzu5zVpcDyBxJaby5mf8ep9EoQRPJU9gUlBSo1yZ4P4YuU0lVqKjjFFMJf21Uxa9EBchT3azgGmIOyKJ2OefqsxGHsNLdx6ZQ7KFBYwesiir1s/cEL4OT0GVrZB+NGu7Kp8G95bYTs43wnEfQTGVa+ajHHdJECmzj3QfybWCVAyMYOKGXgTibdvscwyBGmWm05jSV4ebsPeR09KF8nkGSzRkymmg8hIPBXx+jVr6kRelh/0KREZnhNFr9U5m3r0hedX/80NtsTUEo1UEYf7Ph70GxuF6IlW0KeeQMuRR34cqt3vV/jAp95ITbtsIfFkx6M/GroNjxvn1nkjUPQKusLR6wvB5ewJnfmz4UTeui29LoHCYhgFsb15LFOzjpERh2Ak6QZl1DcuZSorDObQ7UC+9ShK1UswDzOzShxrK3g0H51B/59uEDuPEOiifhiwfETUG+7Uhi8y51D8A9+3UKTl3sRe8/q5kSZCyVNXunfPycbyFN1gveYSGFg88DitulH33DACy2QIHZCqwkZqUM7ewO9O4D5EQxthoqbfvBeRDs458zYWGwjxqyQzQUsA1Wl6p27jXCepjHGqp9HRKWs+LNrjp2Zs4BWPQry5vxBh/2lCv13/222pdtyFAiZc7vc7lCHSIs3Nvtk4wOso/SLp9kRlgJQhjKcLUDY18w+VcQLFDWNgWDguSkNNupIdDgS3jW+m1ymamTbxwI7ad4P+UGbo9sN3C+zzYTKtP9laAcX3O+1l1BPAiSmAYNhp9guCp2mGzDEk2kiLjt25fewqDGdiEtW4+sIFhfn/vSuwAWmR6bLnBM+8bje7tmD72TzdjHsbuN7oltfwq9c5y+G4AXLdIeB4xljIgA2NZOcyevI2dGQW55Llu6C8/tlpyjnOJPMgM0PDQMmmoPIBOdxQS+fmBA4TG6KSW7sWujaFBTzZTZfeApJZTzZ0dBgf1s6wE8Tlpr61e07DhWNm5QMNifCkIN4ZHswym+o2Ev8Rx+iErKNuPTK+mzu4HSjnFt+jP/R5oBbHBjzLdY7TZjAIvZkq1Yc+ua5eKtMdvbGYlQ2MS+cEB18d1uqUb3HonnHtnAv40jTkMmVesqpU9Jnh75yPu4RYNt14tvZF+FwuUCuNLzQFobK7AexK0smTbPwCBWtG2ZEhS12BSSyvJW+Rb/ot9Tf9IfAZ9IUBfUgH6xOQDiVlQW+mx2xI/ZsKUNN1XEqjm1M1bMTGSml9nXR+GV4gxMUxru8VWjd2ssPFmeJW85HWRABj3Xx4DiholCtMbrJTfQN0o5ld/VUchYpVvXiLFta8R6BsTGlxCh8DfTTFcpTD2nEzDktx5jvm71eCJfn2i8yjf5u9uLsSXz/BGm+8IGA2Ho/bC8GpFii7ose6d/jt2nbCfoBspTIVt2B7gUaHk7ypd9ZnEhX7bWixdfvrwZKl9Y7LVVHBaZ692n6jRzMqGPy/QtNCet+9LzCF5ML7kayKc5IJgzcdlu3QenoBR0lZ2WVcEdbnldYFQjdPzvJ88BlNNDgmtxXSsdPw2cG7VlCsL9odyQGgQuOdE2xqzGmLpllK0lrXCEeSkp3XAmKOfw+wII2CzVZfp3uIb7vsWmIMtBXC5F2FSqP6KGLw3rcqqQT6c0lIoaApmWkbypK9gsou4hHkEQbZKygmAG0piC79JfLAk8eJLn9xRq17udWNhJqRBe7oxw3l9X+iyDPmpHaubNDlOFipEagUHCckDmm4v+yAEKgw275GQsskAyxisKxtVus0qjJU4IGQlYIWvaWbQFex4396VaUqVLoxnmpJyx1X4P5cmTqqa3U4dw+IyKEyeo3upI+0ECNVSmHLOwGsZGI7TTm+zMtHWqlvYZSSYGiJyghLpdaQaAxgoVK7Xy5kHfZsNvpDwevDb8F/1ekbybKoXV25WePCoT/3k3iHinh7wMvSF0ximjC95qm5GgX/2vzdnBsAC8CbfmE28tmvw6Sv+qDnRyf/bIgbel6tdgKtfjkHRNy65ZEfcl6q9ZvJor+WxH7iALjGvNgNCieXxrh1cqcAQYgjJFG0PsVjXPRWffi78B2zkioZ0Lfxhf0ps5XJ6Zo38IXIN0zQpjEclWh0MOIR6ZEboDC3Kk19HYRpdImkk6LblJLCY3afhmkkTSRm/yOlcvKIBnkd97WzB8PJ0Knzjpe+/M3eroU6gzZlidPq1x3ApCEmUPsDLOuti0c83afFseXI/0zArjoqIkInNCT9MuWYnbORuiyiRtJGjGRBVAuhaSVBjBPwBHMnuYzzUOlyJGgGVxajEv7jX1XRNdIEQfEjAirJN1V7jR8wkcv6mlPTm7dSpl2zVrtmq3TG0ZfXh6dursrH73QYMXkVC3gAs3Pqen1eW2pP/Kjbw2WhwCr1+POJof3ceFTI5f6YtTi4m1an/IfpJ11pHP3yJleP9Lmf9nwLkR8HfN1VvbFbdi/7l37gM1IvQWVAo2ID1zonhEcrzJIaSUlro9s5eprfHwrKZH1ETS6siNYjETEzsiUSNJx6KkAnWCrdocdyKZnnZt/oS9n8Nm0kvZT+QJi/+jWFsJvm2bwtRltwvRAba9e6Lkr5VvBAJmHRQwBd44DZYK+fvDufvz5+iG5x2duILOboCqdrhBLLTP+3ZR9KU6qkl9do50H/OXGgNNYTJ4/KACo5pE1mUjeofAs4jbeWrrgN2U3yZve/dYifmu/3bc/d+bX1a8EQjAstWEGOk5yL6PGdszUq+VQJV/1uAvmFGNZY01ZgbLJJUpQ6PSSMMI7iI99n20hi3WVX+Lxj9rrmgqb6w21zFNEqkyNCYFbx3f5D35bxxgHrnn2muO7piazra2+/0t7dnpyR1Hi+8zYPHOLZQW3WXFKe45sOLrczPni9CFYvG1ovbN4ujX5+Yfk5OflAM29WBH1cz+1wh3nScuoCZD9COHPhAo3hUAuqLWyfl9xy8HHL8dmOT8jnFWgODgU7RPXs5rn9+Py59OAseziUclWiXECqDf5TafGcRr+sfz/TIMQtlE55rZLIapvc593LtP8xCWGOSyzXV/lluwrQJAIBI9LTCDod87kGOevQ3P15I7eQ0GjbAg0Sp1bE412dDSBZVpr1s3rHfIO6iwiR5VrltRuejpf39FPWQg0ahGEtMgKufWww6aiGVAX4Rslny9Xp0lu+1jFrAestg6sKAAoU8plMW2kLqQlmudRcg45PUah4r6QcRXYzbkwoqF8WujLCOtzioQ1lk0xWKZaEooyAnVgB4I35QRHnG64OEpg88xqP4hLBnQk+hsONm0Eik2PW8aaOi/H9QAAcI+rDcMeb0SeRiyQym5qhBqUxRTClGaZaQxrAIhg7kITFBOVFvno+MrF5ALttGvQPUqa7dU2WmAJB1xkUHSxuhbrWksziRdJL8kw73mUPCBDq9+aAyyR9UWg1wOG9UqWC9XwMbwzMuTd74MbIimbUbziNNlHB41uBxDkGHEt3rF6ke9I8j1NIOexmJLjmrk6qomnDQhy4R+VGeTZZlguNDXEWslnFUT2t6Xl9GG65WSx946G4vFAPS8ZSf1aUkbM02UNLpd7jCyuKI4VXhm7/7Z45/YhjXGPofd2DfcYNNnRJqepiZNb0bMTXFgKl3PYuFiMJnDsZDnPxQLFWR8NRa57Z602KiJ8WQJN3+MaNIZlEyIRDaKNwAPagwFYp8najaGCS33MUhpBmmM6gvFoOdRo6i50OzslrOzL83sAkHN86RLYVLr00xi84EK8Y2RBHhwcPkJ1LJDP/yoFX91+UXJV6ilyynRtT7goX0GHlRhF3xdQqSz5uFNFnC8YHJqOniS4l9PZZDXfU40iDcikf6B7bGquUaL8EwYRPgJg8c7aTAPuZ3mkUmjJ8020ehWgZBu0SUstrENEfzS/ybPkAEadjmhkSGje3YiNsv1S7pp0qh3ZFpbMDiddWl4xNtzy3qqGQiDaENEzBRkg3O7KUBo0wp1sS2kLKTkelNvGtbC4CPvFsbvTwW5oD5BwTc44+m/ecyBtFr+BMgwPNmQlCuhZoJWU3qYrlW9/AsUte11Ft4FeyDc//5AQmIv9LxWYvJ6PCvA7whomCjlhMRRDF/hRKPEx41IY+keCVsgsyTpZnGuUsQJBWylVFl7TZXkpHG1YdMdEhZfDmfo4GcE9s9EaUJ8EEufvUwS2sUaSacWWDVizl9yjdlk/G3s24C+b1BmsWVEshY5m2Q6o68hLdckWIqgRqcO5XlAjWgMNzd9PPYhNUVi3E9sdF/hPWQRUQUIfSdflnTxxvBmjVHJ1JDIJtGGsdayles6xeDRFxVTT1/QvHSh+PW9B6efqhi86YL0zgupWy9Ibr/Q9XRF8fgZyqkzAPkdb5nuY+qOE6+LTr4+8ykVJH7LW7j+I/E174Cx52n26kO8Fvwv1cS9lVjDqRfeKf6l2aE0WNCa+y/Tp556GVCd5oV0c+yx+TOfz8TA2ls0LT2kyTpMj/qP61womt0NGR9eXNHwex1DK7BGBUHKyrLyciz24P5XD54Fb94gdtdxYA6XY/YwhKmfwTY7xYbLgsjI1DHM/cx6z8hre4D7yXfH8GZt6UIP7FZ/3wehiCJ7XfCYFKQivdu81jN9fULqeH1bvbZERKTzdvNMQnrO56dnNcXjmIXK78sJ3zGwfH7+lRxqEZCCFSX4TbeWcbVCjcBDeqvZMD2vDNi6ucomNXGTjgf/d+nJmaN5UIK07GT8JomFMhSF0S7lcU0Sl6bpuR9BMXcx6D4MiEbbMtnbrFBEh5XAcKq5cWmHd0lTVp//69TpFbmF4WOgLDMTs2xtGxwyHmGZp9p8C2n0eC4DqWpqIeVCclwsj6hViviwCgxAhmdcpqM9xcANx/xxUaQCxWlf0m2gRPuGCmWbm0aqvgqgBYaMsCGiNUDxPokjTv+QQpZYGzSMSwYSvkKDA2vwM9ULHz0w9CU+uDEG9MjghMAQ0mggCsVqappk6RsbNMbQpCAQN3sVIqEYzGa3Qig6ZJNabRKyOLBAqTQJOCyjUOl09zHUHrlSExjg2B2yXBtQyvPdDTDAB6QoXEHltC9BG8hKzb3692y0UJ+9ihGK9UtMkelSHOpRv2CE8b+YSCi/yqF/SKZIrA1gEDK4PWA9091jPa0ymAiqpzsnlAa6uRYxI+v1yiNhMS+oDjTmvj4anH8/R547+lYO+ILYEjzvkTL8vw+yxY1Nl3Zol7LZ2cdVH36zVmBh/frZx2XbMCP9uxhfqeITCarB4jsZ3BIP1PS28Vjuqlz7UTtk69xoVXSC2foFSwvr8s/X5X+9bmVVbmbwAICRgvjmIAnpI+3qpTTwDdVOAoEbrLHfQx69LTfq1dUod+enxarRqvi4YTayfYfT8kPx8mbDHdMin7AdVcGJ3WsopRrTEkXGUQGZNy39no+VmntEmohGb4gXpe54nabWQCYLdRgmA8L0k7FUAwFcEs8gb63F0eogrU4rsnmbwJxuDG5ltbVtZxkVHCpXNMftTSDJ2h0BEFbY1ZAd05wCrcaRZhXqnP4iQ1MEBYY4bg+kHqM1nuG/jo8UtKMonNi9xlKKKSVVpB0VetOmezRi1R49JLWXZ4OokXodZoCEoxgIPJU5SVQCbiD8qZ54TKRfeSyu8VlYUr3JJIVYCqim9MBuOvVLNrFgenLnL3tMgCm95/h6XWnlLhbR/9sPFUGayh00iLDP/bV4q3ONCTyPELejryfq9lkrGPz/a9CvcIXyrbNPrDLB0q0zsxi3D5KQjnvIQNgiX1odfXr1CafpmpbWEqPddRmcHKsTqbmBqN3CeRuirINGqr4tM/36tei2r6NmL15KJpMBqR0RSWXaDbJoSmwm/JjBQXUvVOntZtV6Jiu8aKGKWUbcUSr9UStRpKM/hcU+zagjYzep9oGBZ8a2r03mXTv7pI8kwNsIuQ/3NZn2tg+tUPrRb9PIX/txci1Ph67V8Ti6WjSfc67+UlXVfwzGh1VVH+/3tkpFwrDG5Y5ohaI2CViLwP+XwUGyh6v0dlgpdvw5C+3Q6xZtRF4kle7Qy2IpMf4LBgWzSbWPQH8Dh3kbPHvxXPv6HoMhBPF/MvVfIvFfKvl/4Dok+7AUJn1Hof5AJF2krBEvHOLvBE1fV755oOpN7qXXqHj8hyTSIh7/KNAerXwuWvUcjCZ9iCMsP24CbhFc/JpSaLnBW6hmQAKZxEW7PqI+MqNpg3MMlUtO35F9ID6CVV8ivYLHv8yin3edZecDUDol9LnMDdF5zAR5sPl6b6GKouPJJW76/rB6dkbTSSHyH0YkFy8sEf+jUv7L3ouLFOpFcOPNtegn8Lgn0LXYtU/g8E+sBbfEwa5nJyw0aBpGrYej6Sesz4HdtsM9N2ml6rfDKC0VmrQ8C3aBucC5llPJy7e0FFuW3eJPhOA7HmgZBM0AEy2/7o5u6QOEDw9EwnTWYhIYqqS2E5jduGN4wlEcbo6AnwfiT5NlSfCj51ePZ9+Ettl+tYFXnpQ3qy/Nz6svyxsLypz0iy1bmHQNqHhSFSJ8hgVFo+ry/LzqkqIZsJ/0+b3O89WDFYQEoaJQdd7l9/j4sQqKifwYXXF9eWnZDQr6Y2QTpSIGSp9sxahzWw+uKF15wMqoiu8/vveu81WFcmKCWD5Yfd7p9/pB25M3/xTr/aR3/ZL0fNITu3RzE4ceupN8kbyOfHJauOCSXdxoIX1AoXwIuA8kVsq+F3QhyWupOw8JFsCD8MITC0/2zD85/wTAwJ9N80QXev3vDRpuLCnPri4H1Evps9DYCHRjNArdMD50J5TpvE0z2q8/HQmwRn1aldoMG2XS1Vt6u3zUSxXops1uuUu8NRHayfcHF8TxqHjW7RXNxTp2iIPsePmFGueFQqXrGUNGo+61WlS92QYDFJVLujweUU9UzonUa8lUE49P1WvJ9UwdhWzg8sgGHRWMW7N7ovRweS2PZ2mhq2QeMlvPZdQZGxtgYvrqvQWm/s96TVJq6tnojeHLY4k9B+1tcB9H65Xw651hs4V8u67+JhT2AI3xDWHTq5X/93SAz6LvPBFiiTxSmdTTyTQYLJ0/7PgB/JCmuzfq0S5y6+p2PJe/nVBd26PbAG1upzNlahsPVlFfINRgp6ANurItVUyeyBatV/xnVYnfv4zeotv4WUxWMgUSa7beijOt0VWEyc1GdzlTdR+xct2kboOuvL+GJVDbwY7l1glROCKcsFhEE6qZFFmtk8JQWDiuBdFkJDKRRxZrMiyXqz7X0FCfcTjTTI0my3S4mZmZ3unOMOE2VVggalEqhehvUCULsDvNHOQfWjzzCwrlCyYe+wfSzEoGOEIK2OPthwLrg3kiVth3wBubv94RhBu0QZPDUQSPWBhvEQhvMixgsfa05Ska7XGaBZwKAtymE1cY11ypwI8H9sGT8L4AeK2fa2MyrWyOkOa5HHtwcCyrlcnRYl48gcGcegFT+95ZLObsewYnEbGMXXshjF713by5ZkJ9oV7Y3YRfg7c+3o1wI0CbXBKhmU11IbFYSJdH6BIprn1ZTOM3GC093eg0BpeE7qmytyBNE9vKYJvrWWxYzWRgwqx6prn7X1Lqf8HPJ5scz93uvh38gXTPCqO/xpFSeg53YJf8L8+vf6AciRLocf65S8G5alQbq+c+qwbTG2/wmofndVFVGFWgp1Z5SjmBoNNx43cbc76cV9id6em8Wq/9o/nNc+6yua1fARgvz9xpLDVunKPtgCujS5kl9B2xV2JAU++5bzqgNxvNuoV+BalHpm1bX32MKeLwgxjsIB5XxBz4wXEFXsBRD9d3vXwluNCfvOGkfHUnX74nC9b3XwiZxuXAlaf3Z+5DPz1epdnoK1GwYxm55akMCluLci1rsgeV5Oy9IxU4FsIJsgK4duTuDugrQMLCPacTd5/uODkqWqeCXRfPdZTSdDwrp84vlwtpP09gSUN8CoKGb6g7r1Ccr6P91H7Mn6787CGUBUX/OFb0MZ12SaG4BPyrEm/tvrA7cWE7p627oxsI6Rf2XM5+a3sCwb/X7ExV49FoQnU1Ybsn/gPjAtY0roBbFXaG9DOgLHR2dv/0LHgnNK3sbCEb2j7bS6nOmd7IVkF9EI7Yl2s9myUUimm5J1BWq4DhIjjfwOG/UBOIjrfwuDcdm2sF6FphbQ2EQQvA9FBVx3f3bqg4jYYwUhOvqu/be9dXnF0DIWVmMD5mbbYCqWXhlV1l5TdVYpduCDfU4OmLONptYMPn6Pfr0n+UlGH6SjduqcXVxPXv3HcHngnzwUhH2xk3feZg+Cf0wTW/CVEHkfA6pUtYe2Dtr0LUttWmtXIXaBFEzkTAsKH2KXOs9l4zqM+RXsLhXySRnscRFsF8fAJSlVB1urhSoVeq9NeeuAr0AAuPXtI/3dMPHhw9VenyTwhmHFMz+b87+fKXlP5k/qnh9ViJzE3qZpTSi4zNRhB30F8yzeG7rsjGu/+ekwa1GfyjYc7p1Uh1F6vuIPU92ENFcNPRudnuNdWR7w0cHHB80ZrTCngdCBgPBX0sZrDSW7j6Hqb9GT7UhzBsWXhmFP0rSHCc7LPjTYotX3GvICahJQXMOr6lIVB0pTqmB8w6vqUhegzp2E+9AXEpkIAW5WihQAt5+FLr9VzKfpEQhkhIi3JcaxeiNyIEnUaLzVP/j6lhJviSIWrZ0HR3sgv0TlAcYRZ8tQ1CM5J5xbYjqYRU2CXsHGIhegcoxvV4krR2hjxFyUwNM8GXDJFQrNI2Jj9FmVDDfJoPEDoby6n2RXwRmJTz62WkL9k5brJ8aVx+eoAah4UgS1UWyWJZIkvlf7JM/k+W2xWbCLLoz23OTsC4xTUUYFl61CWNVGQXdskppnEgvgrG3VCJmpx13Zqdr4jGh/MP6yVUL7nGNbnGdbnOreotl7gtt7mbbrv/CWoEraZsep32zF5yAB6lhU7z1YSYpyqO86TfL975n4eOXcB2O+DR0BE4W3L3hoRIyN0Exc71pfo6DPDvmxiJ+/sSbwEf8HAFaUcZJ5Wrq7VOc48JaW86shQR5x1wLOtJYRNqpXM/LYLOuNclhf0qBM6rpUVwn5CQFnV1QBQ9S5HpBcl+YV4Po7dG+FaN4gsKJmxoBFYWuz76Ja6BbW7/WHS2RAc9iR6cMA4+fgi0XuoTwAUrADO8q33dUfatoW+/A/XzlKr71VdNe3QFybNha7B1TYc6CQO0hXnxgDrD4kftQ8T6qpyMIfuIHT0E3LRV7xJ7G/jF135fMvtptPDRtyyoojmJiVge77AftRXQRfYzUE+HPNHXRLXTbTylERPmfYOpa7KmAUH26vlQ++ekjwe+aiTEgBxy6tg3YFsOgbPt+T2hN/Bhfd0zwHfsrNswXlidDFDH/hlCAoN99C0/r2JP0kNWpCD3ukRoUJfZDz2sHrTo53BAHTgrt7ddP6KM3MUdo38wQ44yaYy/5VLekjWASC6BlAFVUge5oCf1wIKGUOkH/DytP2hfCY0/k/L0/jE52FcovZO9Q554t+duc//KudIgPtaEoaOsYkl5hlWG7HZlL3gO0ghRmj75y/No8WPl4dnkyBb3SV/u8ulDRo8tPxSVNcpnZgILFe8El1XY98bNrIr6uqIBny9YVBEvztSjmyDdjMHWqRg8ofLnPcTpexRBZzKit/m5AXpnCqisH544MCxU3CTCb9kPjIK3fEqZVX95Occt/I0GPL1kUf3u/YOJBDbZXdbKvT2DwdaNOJiDceVNddOG2c/zHur0bfFzjfOFnjKqwk7Wzi3Fz5iI770HK90zE8acvJpPekNZjftebezrGpfA5MxBLte7nA/hzNeHgIngt+emSwcLlP9YHKId4NPfbQd8s8WCiVcjl3kMOkoAjGCAgF1INV3a4f9nWwHXfv0TZ9usmOvdfv/gR9AR+oqnzmPTtEg8TQ+jVqo/5FhbruwzS0ca0P8GfVV8dOwjALtvl6Djn26zDNrkOU4yTpMFGx/GT6kbeIjMhLu/5wABNQCyycijHdZ7+/2Yg18dgF2L9vPHWbWE4BqMjbfHi9ROMsqACbvOrAdDTcLkylQ41UTuHWSEQDyEZjFD9g3jcHqvZ89UT5JD23XorMhN4ANmRJ09Tdsx8SHYSiWDrCnrdeoKkNX2N5yb4dQWUhCk2++zBLJiYKf2D3CkmGqhfUML4GQphmxEI3nFa7ClBFb1oPJQbcJYveDVdGw1BE3Nw5wcZXnpCjSiC7rBjnDEtya5nLDsRInW/hpyiCCDrlVPd4mfj8G+HnkIMkrg2v7bkwKZDbgdQNUDfmVmWGJmXi+nRE7U5OoOWTcmGqKTGrQaYZ1Cken7RKLdUg/cB3IdYfkXaD8COjBHkJVW5JlGGKaJ4sHTLIrRldOAuSFe3lIKTNOmJxajNisIdy/SQIOtWgmuZYjSAcqmxvZxuYEHZNYR5BZ+K+PEQ9YimPOiWcxdLRBt/Uq5y/s51TWVQgIw/JgS7G465yRxNntaK4bKI4emeYB7cD0exDX4DifjYnyI21rPsuN1XHpbV+Dorml9QwIvY/rtnBzDX/7OnCGXfK31SBc+bX0Qt/zCH19ho3Nz5fGzYBRuYSIOYg7KztkXBM5ZJPfrx49AtsWNoQcSJuS0DFQTVEFAwDQ7EdDABvBCUswsxBXtLIwf4SxCogu3JN2zKGr7ZzE41M7i6yZtlpBW6EwRIeMlEMAUctxSZoN/ki5HC32kteyvS067PFi/pmelRAXF37HYKVkaL5sczn9vdLpkxdh1yevXJ65Xr3b98HySUvLelh/arY8cB8fivXF5iZcKDSe8WmTr8l07w+lHMut2CniU+6TWyXgybNx30+ddU8HPRksRlnuKnQbCy9CuV5rJ+IsEpTo6pBe4q+PxcfHwrjw3cfiAxhWLXdIlRdei1oCaJEGaR8ejw1rulHJOHtCBLZrFMocl8nJKPJfkT2LrnGqd5fRT67vx/VFnW8AaL2QnHc6KusMeFFQxNN+ii3vei15Sh6EeM+PuFee9OpmwnMCfrfyJO71przvdReBHQqKZhZ/rW96WdIGMnILS91T0UotJ+3LOmYnRvKv+HbNuMCo94ImAn/wd/QYVUCIrYWZWQf8gZh3+RJgjQ4EixQqtUWKPTO9lyZajQa48pcpVKOM2wED53mo2SIs/rbAyTJDMXfSVcwvHNWEh9gzR1Yj7UfhIgISKFCtRqtCet2Ka6VXw+td/Pk01DSD8D4QWrdq0IyLgT2sb0jpGax1Th4dBLC4OnQjttU8iDi6PIWLFO+6E/ROt6wdtsfVhKPpeBWCrV2uuRvNUxWUIg7WrdhgzodRYnM7wm8T/5kP0DHQWGGq9hAhhpavdDDPcCCONMtoYY40zXq06IfUaNGrSLKxFqzbtOnTq0q1Hrz79BgzaaJPNtthqmyHDRmy3w6gx4ybsNGnKtBmz5vhJkvluue+2Ox5kkl3Gphuh7eiND8ZL4fboQH88bGFnu6JZh02PTBV7fR5raaq9L31YyUA+xeULJHqPQAeVnOH4hP4Eoisfvwr7CxVaPWhQ27slRxOKajg16FrXlyriUZPCIw6AFB7X5VN5QkrBlqDN6qBGwABaw8iEZCyQ0QcYgax+kNVYwAjFsA1pAI4ACAVkBBYIBAAfFJAVEAgsMDcVrk6m0/xVgjVaLgwE9nbjuuWQZ+X/WeuhhlTqR4+lFSf5SwFpfeg2uJRSHmKIqh7iSE3dlWcChIIVPk8U0dKgvbdSLQx0IwFHU6pmXYUrXQtb4lyzKc8X+h0pQV4sq874Pzfl3HBuKEQuHBFLnOfv83Va/Ea1yP5UNuaJbzulZZZ8WL75qeVTnwB0em1zTzYVpoT19cmurswQVUGgui7W1X9sqvAsSnbwJWqVrCKQrus8Tt54aYZa1rbIE8L8hk5EXJtwdYci2ISX6bqGzhSiv6p7WKRf4PRiMyGqlrUtcgWvc/OEQ+7YlL3mXzhCICoJqY9ccCrs1Mb84IJ7SQD2bXrQDd0NjUwXNRyBPmFnxV/LWHIb4lB+fnfK4kl+ZgPWo4N0QhcCgjRXJwkVfhkthpPSruIkVOFiikZE+RsnpPhwAnJSfBI4j8i5hCIO4SYcGw/OwikmFqoeO8IZGFWHsXF6LSdUc3yNxCnHojimErXFaGX11Ral0g9tUccUA6KsWoO62vw986bEcRM5uen2m4S9CSK3cNeQOjFVJESZOIqHQbApCLUBu1qHaVOHt90b+OtDtNtxSwY+GgW4K0zmZ+/8dfKQLdRhqgRlrOKx7R5bdmbPze4arOOpnOAyPtq7hibC4i3z4Dj9oc/FkJ9g+8AEft8B6E2hBr8KZtrCmcrGcHsgmejj+PcfPmBp1wSfB+VXC99FITMn0x0urKJHH0wZ5QfIPpQ+mvKH7UNTJvvGoShevV3XlO9RKQUEvjbcDgAAAA==) format("woff2")}@font-face{font-family:Montserrat;font-style:normal;font-weight:800;src:url(data:font/woff2;base64,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) format("woff2")}';
}
// <<< sf-activation <<<
