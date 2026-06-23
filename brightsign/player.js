'use strict';
// ScreenFleet BrightSign Player — player.js v31
// Offline-first: reads sf-manifest.json from SD card on boot.
// HDMI: <video src="tv:brightsign.biz/hdmi"> at zone coordinates.
// sfLoadManifest() and sfReloadHdmi() called by autorun.brs via InjectJavascript.
window.__SF_NATIVE_PACKAGE__ = true;
window.__SF_ASSET_ID__ = '69c206e32a609433ec805b6d';

// Splash — dismissed after content renders, minimum 3 seconds display time
var _sfSplashReady = false;
var _sfContentReady = false;
var _sfSplashStart = Date.now();
function sfDismissSplash() {
  _sfContentReady = true;
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
window.__SF_VERSION__ = 'v31';

var CFG = null;
var currentPayload = null;
var knownVersion = null;
var zoneTimers = {};

async function boot() {
  console.warn('[SF v31] boot()');
  try {
    var r = await fetch('./config.json');
    CFG = await r.json();
    console.warn('[SF] Config loaded. screenId=' + CFG.screenId);
  } catch(e) {
    showError('Cannot read config.json: ' + e.message);
    return;
  }

  // Service Worker only works on http/https — skip on file:// (BrightSign local mode)
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    try {
      await navigator.serviceWorker.register('./sw.js', { scope: './' });
      await navigator.serviceWorker.ready;
      console.warn('[SF] SW registered');
    } catch(e) { console.warn('[SF] SW failed (non-fatal):', e.message); }
  } else {
    console.warn('[SF] SW skipped (file:// protocol — using local SD card files)');
  }

  // Read manifest from SD card (written by autorun.brs after network fetch)
  var manifest = await loadLocalManifest();
  if (manifest) {
    console.warn('[SF] Local manifest found. version=' + manifest.content_version);
    knownVersion = manifest.content_version;
    currentPayload = manifest;
    renderPayload(manifest);
  } else {
    console.warn('[SF] No local manifest — showing waiting screen');
    showWaiting();
  }

  // Background network refresh
  await networkRefresh();
  setInterval(networkRefresh, (CFG && CFG.pollIntervalMs) ? CFG.pollIntervalMs : 60000);
}

async function loadLocalManifest() {
  try {
    var r = await fetch('./sf-manifest.json', { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch(e) { return null; }
}

async function networkRefresh() {
  if (!CFG || !CFG.screenId) return;
  try {
    var r = await fetch(CFG.apiOrigin + '/functions/screenPayload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screenId: CFG.screenId, native_mode: true })
    });
    var data = await r.json();
    if (!data || data.status === 'error') { console.warn('[SF] networkRefresh: payload error'); return; }
    if (data.content_version && data.content_version !== knownVersion) {
      console.warn('[SF] New version: ' + data.content_version);
      knownVersion = data.content_version;
      currentPayload = data;
      renderPayload(data);
    } else {
      console.warn('[SF] Network: version unchanged (' + data.content_version + ')');
    }
  } catch(e) { console.warn('[SF] networkRefresh failed (offline?):', e.message); }
}

window.sfLoadManifest = async function() {
  console.warn('[SF] sfLoadManifest() called by autorun.brs');
  var manifest = await loadLocalManifest();
  if (manifest && manifest.content_version !== knownVersion) {
    knownVersion = manifest.content_version;
    currentPayload = manifest;
    renderPayload(manifest);
  }
};

window.sfReloadHdmi = function() {
  console.warn('[SF-HDMI] sfReloadHdmi() — reloading HDMI video elements');
  document.querySelectorAll('video[data-hdmi]').forEach(function(v) {
    v.load();
    v.play().catch(function(e) { console.warn('[SF-HDMI] play() rejected:', e.message); });
  });
};

function renderPayload(payload) {
  console.warn('[SF] renderPayload zones=' + (payload.zones || []).length);
  Object.values(zoneTimers).forEach(function(t) { clearTimeout(t); });
  zoneTimers = {};

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
  // We clear non-HDMI content and let renderCanvasCreative reuse existing HDMI elements.
  var existingHdmi = Array.from(hdmiLayer.querySelectorAll('video[data-hdmi]'));
  hdmiLayer.innerHTML = '';
  // Re-attach preserved HDMI elements immediately so they are available when
  // renderCanvasCreative checks for them via querySelector.
  existingHdmi.forEach(function(v) { hdmiLayer.appendChild(v); });

  var zones = payload.zones || [];
  if (!zones.length) { showWaiting(); return; }
  zones.forEach(function(zone) { renderZone(canvas, hdmiLayer, zone); });
  sfDismissSplash();
}

function renderZone(canvas, hdmiLayer, zone) {
  var x = zone.x || 0, y = zone.y || 0, w = zone.width || 0, h = zone.height || 0, z = zone.z_index || 1;

  if (zone.content_source_type === 'hdmi_input') {
    console.warn('[SF-HDMI] HDMI zone x=' + x + ' y=' + y + ' w=' + w + ' h=' + h);
    var vid = document.createElement('video');
    vid.setAttribute('data-hdmi', 'true');
    vid.autoplay = true; vid.playsInline = true; vid.muted = false;
    vid.style.cssText = 'position:absolute;left:'+x+'px;top:'+y+'px;width:'+w+'px;height:'+h+'px;z-index:'+z+';object-fit:fill;background:#000';
    var src = document.createElement('source');
    src.src = 'tv:brightsign.biz/hdmi'; src.type = 'video/mp4';
    vid.appendChild(src);
    vid.onerror = function() { console.warn('[SF-HDMI] video error (signal not present yet)'); };
    hdmiLayer.appendChild(vid);
    vid.play().catch(function(e) { console.warn('[SF-HDMI] initial play() rejected:', e.message); });
    return;
  }

  var el = document.createElement('div');
  el.id = 'zone-' + zone.id;
  el.style.cssText = 'position:absolute;left:'+x+'px;top:'+y+'px;width:'+w+'px;height:'+h+'px;z-index:'+z+';background:'+(zone.background_color||'#000')+';overflow:hidden';
  canvas.appendChild(el);

  var items = (zone.playback_track && zone.playback_track.items) ? zone.playback_track.items : [];
  if (!items.length) return;
  playTrack(el, zone, items, 0);
}


// ── Canvas Creative Renderer ──────────────────────────────────────────────────
// Renders a CanvasCreative (layers_json) into a container element.
// Handles all layer types from the Studio: image, video, text, shape,
// and hdmi_input (renders as tv:brightsign.biz/hdmi video element).
// Called from playTrack when item.content_type === 'canvas_creative'.
function renderCanvasCreative(container, creative, zone) {
  if (!creative || !creative.layers_json) {
    console.warn('[SF-CC] No layers_json in creative');
    return;
  }
  var cw = creative.width || zone.width || 1920;
  var ch = creative.height || zone.height || 1080;
  var layers = creative.layers_json;

  // If any layer is hdmi_input, the creative container must be transparent
  // so the BrightSign hardware HDMI video plane shows through underneath.
  // Non-HDMI layers render on top with their own backgrounds.
  var hasHdmiLayer = layers.some(function(l) { return l.type === 'hdmi_input'; });
  if (hasHdmiLayer) {
    container.style.background = 'transparent';
    console.warn('[SF-CC] HDMI layer detected — container set to transparent');
  }

  // Scale creative to fit zone if different sizes
  var scaleX = zone.width  ? zone.width  / cw : 1;
  var scaleY = zone.height ? zone.height / ch : 1;
  var scale  = Math.min(scaleX, scaleY);

  console.warn('[SF-CC] Rendering creative="' + (creative.name||'') + '" ' + cw + 'x' + ch + ' scale=' + scale.toFixed(3) + ' layers=' + layers.length);

  // Sort by z_index
  var sorted = layers.slice().sort(function(a, b) { return (a.z_index || 1) - (b.z_index || 1); });

  sorted.forEach(function(layer) {
    var lx = (layer.x || 0) * scale;
    var ly = (layer.y || 0) * scale;
    var lw = (layer.width  || 100) * scale;
    var lh = (layer.height || 100) * scale;
    var lz = layer.z_index || 1;
    var p  = layer.props || {};
    var baseStyle = 'position:absolute;left:'+lx+'px;top:'+ly+'px;width:'+lw+'px;height:'+lh+'px;z-index:'+lz+';overflow:hidden;';

    // ── HDMI Input layer ───────────────────────────────────────────────────────
    // Renders as <video src="tv:brightsign.biz/hdmi"> at this layer's position.
    // nodejs_enabled + websecurity:false in autorun.brs make this work on BrightSign.
    if (layer.type === 'hdmi_input') {
      // HDMI video is placed in #hdmi-layer at absolute screen coords (zone offset + layer offset).
      // CRITICAL: Check if element already exists before creating a new one.
      // Re-creating on every playlist loop causes interrupted-play cascade (audio only, black video).
      // If it already exists, just call load()+play() to reconnect signal.
      var hdmiLayer = document.getElementById('hdmi-layer');
      if (!hdmiLayer) return;

      var absX = (zone.x || 0) + lx;
      var absY = (zone.y || 0) + ly;
      console.warn('[SF-CC-HDMI] HDMI layer abs=' + absX.toFixed(0) + ',' + absY.toFixed(0) + ' w=' + lw.toFixed(0) + ' h=' + lh.toFixed(0));

      // Re-use existing HDMI video element if present
      var existing = hdmiLayer.querySelector('video[data-hdmi]');
      if (existing) {
        console.warn('[SF-CC-HDMI] Reusing existing HDMI video element');
        existing.load();
        existing.play().catch(function(e) { console.warn('[SF-CC-HDMI] reuse play() rejected:', e.message); });
        return;
      }

      // First render — create the element.
      // Do NOT call play() immediately — HDMI signal may not be locked yet at boot.
      // autorun.brs will call sfReloadHdmi() via InjectJavascript when
      // roHdmiInputChanged fires (signal locked). That triggers load()+play().
      // autoplay=true handles the case where signal is already present.
      var absVid = document.createElement('video');
      absVid.setAttribute('data-hdmi', 'true');
      absVid.autoplay = true;
      absVid.playsInline = true;
      absVid.muted = false;
      absVid.style.cssText = 'position:absolute;left:'+absX+'px;top:'+absY+'px;width:'+lw+'px;height:'+lh+'px;z-index:'+(zone.z_index||1)+';object-fit:'+(p.fit==='fit'?'contain':'fill')+';background:#000;';
      var absVidSrc = document.createElement('source');
      absVidSrc.src  = 'tv:brightsign.biz/hdmi';
      absVidSrc.type = 'video/mp4';
      absVid.appendChild(absVidSrc);
      absVid.onerror = function() { console.warn('[SF-CC-HDMI] video error (signal not locked yet — waiting for roHdmiInputChanged)'); };
      hdmiLayer.appendChild(absVid);
      // Attempt play after a short delay to allow HDMI signal to stabilize
      setTimeout(function() {
        absVid.load();
        absVid.play().catch(function(e) { console.warn('[SF-CC-HDMI] deferred play() rejected:', e.message); });
      }, 3000);
      return; // Don't add to container — in hdmi-layer at absolute coords
    }

    // ── Image layer ────────────────────────────────────────────────────────────
    if (layer.type === 'image') {
      if (!p.src) return;
      var img = document.createElement('img');
      img.src = p.src;
      img.style.cssText = baseStyle + 'object-fit:' + fitCss(p.objectFit) + ';';
      if (layer.opacity != null && layer.opacity !== 1) img.style.opacity = layer.opacity;
      container.appendChild(img);
      return;
    }

    // ── Video layer ────────────────────────────────────────────────────────────
    if (layer.type === 'video') {
      if (!p.src) return;
      var v = document.createElement('video');
      v.src = p.src;
      v.autoplay = true;
      v.playsInline = true;
      v.muted = p.muted !== false;
      v.loop = p.loop !== false;
      v.style.cssText = baseStyle + 'object-fit:' + fitCss(p.objectFit) + ';';
      if (layer.opacity != null && layer.opacity !== 1) v.style.opacity = layer.opacity;
      container.appendChild(v);
      return;
    }

    // ── Text layer ─────────────────────────────────────────────────────────────
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

    // ── Shape layer ────────────────────────────────────────────────────────────
    if (layer.type === 'shape') {
      var sh = document.createElement('div');
      sh.style.cssText = baseStyle +
        'background:' + (p.fillColor || '#3b82f6') + ';' +
        'border-radius:' + (p.shape === 'circle' ? '50%' : ((p.borderRadius || 0) * scale) + 'px') + ';' +
        (p.borderWidth ? 'border:' + (p.borderWidth * scale) + 'px solid ' + (p.borderColor || '#fff') + ';' : '');
      if (layer.opacity != null && layer.opacity !== 1) sh.style.opacity = layer.opacity;
      container.appendChild(sh);
      return;
    }

    // ── Weather Widget layer ──────────────────────────────────────────────────
    // Full port of WeatherWidgetLayer.jsx — horizontal strip with SVG icons,
    // current conditions, and multi-day forecast. Same Open-Meteo API, same
    // response shape (current_weather + daily), same WMO code mapping.
    if (layer.type === 'weather_widget') {
      var wd = document.createElement('div');
      wd.style.cssText = baseStyle +
        'background:' + (p.background_color || 'rgba(10,20,40,0.92)') + ';' +
        'overflow:hidden;font-family:Arial,sans-serif;box-sizing:border-box;display:flex;';
      container.appendChild(wd);

      var wLat = p.latitude;
      var wLon = p.longitude;
      var wUnits = p.units || 'F';
      var wAccent = p.accent_color || '#3b9eff';
      var wText = p.text_color || '#ffffff';
      var wLoc = p.location_name || '';
      var wFdays = Math.min(p.forecast_days || 5, 7);
      var wShowIcon = p.show_icon !== false;
      var wShowCond = p.show_condition !== false;
      var wShowFcast = p.show_daily_forecast !== false;

      var wH = lh; // layer height in scaled px
      var wW = lw;
      var base2 = Math.max(wH * 0.14, 8);

      var sz2 = {
        temp:    base2 * 2.2,
        icon:    base2 * 2.0,
        cond:    base2 * 0.7,
        loc:     base2 * 0.55,
        day:     base2 * 0.65,
        ficon:   base2 * 1.4,
        hi:      base2 * 0.85,
        lo:      base2 * 0.7,
      };

      var WMO = {0:'Clear',1:'Mostly Clear',2:'Partly Cloudy',3:'Overcast',45:'Fog',48:'Icy Fog',
        51:'Drizzle',53:'Drizzle',55:'Heavy Drizzle',61:'Rain',63:'Rain',65:'Heavy Rain',
        71:'Snow',73:'Snow',75:'Heavy Snow',80:'Showers',81:'Showers',82:'Heavy Showers',
        95:'Thunderstorm',96:'T-Storm+Hail',99:'T-Storm+Hail'};
      var DAYS2 = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

      function wmoLabel(c) { return WMO[c] || 'Unknown'; }
      function fmtTemp(c) {
        if (c == null) return '--';
        return wUnits === 'C' ? Math.round(c) + '°' : Math.round(c * 9/5 + 32) + '°';
      }

      // SVG weather icon — matches WeatherWidgetLayer.jsx exactly
      function weatherIconSvg(code, size) {
        var c = Math.round(size);
        var s = 'width="'+c+'" height="'+c+'" viewBox="0 0 32 32" fill="none"';
        if (code === 0 || code === 1) return '<svg '+s+'><circle cx="16" cy="16" r="6" fill="#FFD700"/>' +
          [0,45,90,135,180,225,270,315].map(function(a){return '<line x1="16" y1="4" x2="16" y2="7" stroke="#FFD700" stroke-width="2" stroke-linecap="round" transform="rotate('+a+' 16 16)"/>';}).join('') + '</svg>';
        if (code === 2) return '<svg '+s+'><circle cx="13" cy="14" r="5" fill="#FFD700"/>' +
          [0,60,120,180,240,300].map(function(a){return '<line x1="13" y1="5" x2="13" y2="8" stroke="#FFD700" stroke-width="1.5" stroke-linecap="round" transform="rotate('+a+' 13 14)"/>';}).join('') +
          '<rect x="8" y="17" width="16" height="9" rx="4.5" fill="#B0C4DE"/><rect x="12" y="14" width="12" height="7" rx="3.5" fill="#C8D8E8"/></svg>';
        if (code === 3) return '<svg '+s+'><rect x="4" y="16" width="24" height="11" rx="5.5" fill="#8A9BB0"/><rect x="8" y="11" width="18" height="10" rx="5" fill="#A0B4C8"/></svg>';
        if (code === 45 || code === 48) return '<svg '+s+'><rect x="4" y="10" width="24" height="3" rx="1.5" fill="#A0A0A0" opacity="0.7"/><rect x="6" y="15" width="20" height="3" rx="1.5" fill="#A0A0A0" opacity="0.6"/><rect x="4" y="20" width="24" height="3" rx="1.5" fill="#A0A0A0" opacity="0.5"/></svg>';
        if ([51,53,55,61,63,65,80,81,82].indexOf(code) >= 0) return '<svg '+s+'><rect x="5" y="7" width="22" height="11" rx="5.5" fill="#7A9BBF"/><rect x="9" y="4" width="16" height="9" rx="4.5" fill="#8FB0D0"/>' +
          [10,16,22].map(function(x){return '<line x1="'+x+'" y1="21" x2="'+(x-2)+'" y2="28" stroke="#5B8DB8" stroke-width="2" stroke-linecap="round"/>';}).join('') + '</svg>';
        if ([71,73,75].indexOf(code) >= 0) return '<svg '+s+'><rect x="5" y="7" width="22" height="11" rx="5.5" fill="#B0C8E0"/>' +
          [10,16,22].map(function(x){return '<circle cx="'+x+'" cy="24" r="1.5" fill="white" opacity="0.9"/><line x1="'+x+'" y1="20" x2="'+x+'" y2="28" stroke="white" stroke-width="1.5" stroke-linecap="round" opacity="0.7"/><line x1="'+(x-3)+'" y1="22" x2="'+(x+3)+'" y2="26" stroke="white" stroke-width="1" stroke-linecap="round" opacity="0.6"/><line x1="'+(x+3)+'" y1="22" x2="'+(x-3)+'" y2="26" stroke="white" stroke-width="1" stroke-linecap="round" opacity="0.6"/>';}).join('') + '</svg>';
        if ([95,96,99].indexOf(code) >= 0) return '<svg '+s+'><rect x="4" y="6" width="24" height="12" rx="6" fill="#4A5568"/><rect x="8" y="3" width="18" height="10" rx="5" fill="#5A6478"/><polygon points="18,16 13,24 17,24 14,31 22,21 17,21" fill="#FFE135"/></svg>';
        return '<svg '+s+'><rect x="13" y="6" width="6" height="16" rx="3" fill="#C0C0C0"/><circle cx="16" cy="24" r="4" fill="#E05555"/><rect x="14" y="14" width="4" height="10" fill="#E05555"/></svg>';
      }

      function renderWeather(data) {
        var cur = data.current_weather || {};
        var daily = data.daily || {};
        var curTemp = fmtTemp(cur.temperature);
        var curCode = cur.weathercode || 0;

        // Current panel
        var curPanel = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;' +
          'padding:0 ' + (base2*1.2) + 'px;border-right:1px solid rgba(255,255,255,0.12);flex-shrink:0;' +
          'gap:' + (base2*0.2) + 'px;min-width:' + (wW*0.22) + 'px;">';
        if (wShowIcon) curPanel += weatherIconSvg(curCode, sz2.icon);
        curPanel += '<div style="color:'+wText+';font-size:'+sz2.temp+'px;font-weight:800;line-height:1;letter-spacing:-0.02em">'+curTemp+'</div>';
        if (wShowCond) curPanel += '<div style="color:'+wAccent+';font-size:'+sz2.cond+'px;font-weight:600;text-align:center">'+wmoLabel(curCode)+'</div>';
        curPanel += '<div style="color:'+wText+';font-size:'+sz2.loc+'px;opacity:0.55;text-align:center;margin-top:'+(base2*0.1)+'px">'+wLoc+'</div>';
        curPanel += '</div>';

        // Forecast panels
        var fcastPanel = '';
        if (wShowFcast && daily.time && daily.time.length) {
          fcastPanel = '<div style="display:flex;flex:1;align-items:stretch;">';
          for (var i = 0; i < Math.min(wFdays, daily.time.length); i++) {
            var dateStr = daily.time[i];
            var dayName = i === 0 ? 'Today' : DAYS2[new Date(dateStr + 'T12:00:00').getDay()];
            var hi2 = fmtTemp(daily.temperature_2m_max ? daily.temperature_2m_max[i] : null);
            var lo2 = fmtTemp(daily.temperature_2m_min ? daily.temperature_2m_min[i] : null);
            var dCode = daily.weathercode ? daily.weathercode[i] : 0;
            var border = i < wFdays-1 ? 'border-right:1px solid rgba(255,255,255,0.07);' : '';
            fcastPanel += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
              border + 'padding:'+(base2*0.3)+'px '+(base2*0.2)+'px;gap:'+(base2*0.15)+'px;">';
            fcastPanel += '<div style="color:'+wText+';font-size:'+sz2.day+'px;font-weight:700;opacity:0.7;text-transform:uppercase;letter-spacing:0.04em">'+dayName+'</div>';
            if (wShowIcon) fcastPanel += weatherIconSvg(dCode, sz2.ficon);
            fcastPanel += '<div style="color:'+wText+';font-size:'+sz2.hi+'px;font-weight:700;line-height:1">'+hi2+'</div>';
            fcastPanel += '<div style="color:'+wAccent+';font-size:'+sz2.lo+'px;opacity:0.85;font-weight:500">'+lo2+'</div>';
            fcastPanel += '</div>';
          }
          fcastPanel += '</div>';
        }

        wd.innerHTML = curPanel + fcastPanel;
      }

      if (!wLat || !wLon) {
        wd.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;width:100%;color:'+wText+';font-size:'+sz2.cond+'px;opacity:0.5">Set location in Studio</div>';
        return;
      }

      // Use pre-fetched weather_data from payload if available (embedded by screenPayload).
      // This is the correct path — no external fetch needed on the player.
      // Falls back to direct API fetch if not embedded (e.g. older payload).
      var preloaded = p.weather_data;
      if (preloaded) {
        renderWeather(preloaded);
        // Still refresh from API every 10 minutes while online
        var wUrl2 = 'https://api.open-meteo.com/v1/forecast?latitude='+wLat+'&longitude='+wLon+
          '&current_weather=true&daily=temperature_2m_max,temperature_2m_min,weathercode' +
          '&timezone=auto&forecast_days='+wFdays;
        setInterval(function(){
          fetch(wUrl2).then(function(r){return r.json();}).then(renderWeather).catch(function(){});
        }, 10 * 60 * 1000);
        return;
      }

      // Fallback: fetch directly (works if player has network, fails offline)
      wd.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;width:100%;color:'+wText+';font-size:'+sz2.cond+'px;opacity:0.5">Loading weather...</div>';
      var wUrl = 'https://api.open-meteo.com/v1/forecast?latitude='+wLat+'&longitude='+wLon+
        '&current_weather=true&daily=temperature_2m_max,temperature_2m_min,weathercode' +
        '&timezone=auto&forecast_days='+wFdays;
      fetch(wUrl).then(function(r){return r.json();}).then(function(data){
        renderWeather(data);
        setInterval(function(){
          fetch(wUrl).then(function(r){return r.json();}).then(renderWeather).catch(function(){});
        }, 10 * 60 * 1000);
      }).catch(function(){
        wd.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;width:100%;color:'+wText+';font-size:'+sz2.cond+'px;opacity:0.5">'+wLoc+' — Weather unavailable</div>';
      });
      return;
    }

    // Unrecognized layer type — debug placeholder (only visible in dev)
    var dbg = document.createElement('div');
    dbg.style.cssText = baseStyle + 'background:rgba(99,102,241,0.15);border:1px dashed #6366f1;display:flex;align-items:center;justify-content:center;';
    dbg.innerHTML = '<span style="color:#818cf8;font-size:' + (10 * scale) + 'px;font-family:monospace">' + (layer.type||'unknown') + '</span>';
    container.appendChild(dbg);
  });
}

function playTrack(el, zone, items, index) {
  var item = items[index % items.length];
  if (!item) return;
  el.innerHTML = '';
  var fit = fitCss(item.fit_mode || zone.fit_mode);

  // Canvas Creative — render layers_json composite
  if (item.content_type === 'canvas_creative') {
    var cc = item.canvas_creative;
    if (cc && cc.layers_json) {
      // Make zone container transparent before rendering if HDMI layer present
      var hasHdmi = cc.layers_json.some(function(l) { return l.type === 'hdmi_input'; });
      if (hasHdmi) {
        el.style.background = 'transparent';
      }
      renderCanvasCreative(el, cc, zone);
    } else {
      console.warn('[SF] canvas_creative item missing layers_json. id=' + item.canvas_creative_id);
    }
    // Only advance the playlist if there are MULTIPLE items.
    // A single looping canvas creative (HDMI + widgets) must stay put forever —
    // re-rendering every 8s causes audio blips on HDMI and weather widget flicker.
    var next = index + 1;
    var hasMore = items.length > 1 && (next < items.length || (!zone.playback_track || zone.playback_track.loop !== false));
    if (hasMore) {
      var dur = ((item.duration != null ? item.duration : 8)) * 1000;
      zoneTimers[zone.id + '_' + index] = setTimeout(function() { playTrack(el, zone, items, next); }, dur);
    }
    // Single item: stay rendered indefinitely. sfLoadManifest() will re-render on content update.
    return;
  }

  if (item.file_type === 'video') {
    // BrightSign HTML widget local file path: file:///SD:/media/ (capital SD, forward slashes)
    var local = item.local_name ? 'file:///SD:/media/' + item.local_name : null;
    var cdn = item.file_url;
    var v = document.createElement('video');
    v.src = local || cdn; v.autoplay = true; v.playsInline = true; v.muted = (zone.volume === 0);
    v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:'+fit;
    v.onended = function() { playTrack(el, zone, items, index + 1); };
    v.onerror = function() {
      if (local && v.src !== cdn) { v.src = cdn; }
      else { playTrack(el, zone, items, index + 1); }
    };
    el.appendChild(v);
  } else {
    var img = document.createElement('img');
    // Try local SD card first (downloaded by autorun.brs), fall back to CDN
    var imgLocal = item.local_name ? 'file:///SD:/media/' + item.local_name : null;
    img.src = imgLocal || item.file_url;
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:'+fit;
    img.onerror = function() {
      if (imgLocal && img.src !== item.file_url) {
        console.warn('[SF] Local image failed, trying CDN:', item.file_url);
        img.src = item.file_url;
      } else {
        playTrack(el, zone, items, index + 1);
      }
    };
    el.appendChild(img);
    var dur = ((item.duration != null ? item.duration : 8)) * 1000;
    var loop = !zone.playback_track || zone.playback_track.loop !== false;
    var next = index + 1;
    if (loop || next < items.length) {
      zoneTimers[zone.id + '_' + index] = setTimeout(function() { playTrack(el, zone, items, next); }, dur);
    }
  }
}

function fitCss(m) {
  switch(m) { case 'fit': return 'contain'; case 'stretch': return 'fill'; case 'center': return 'none'; default: return 'cover'; }
}

function showWaiting() {
  var c = document.getElementById('canvas');
  if (!c) return;
  c.innerHTML = '';
  c.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#13224D';
  c.innerHTML = '<div style="text-align:center"><div style="font:700 28px Segoe UI,sans-serif;color:#fff;letter-spacing:-0.01em"><span>Screen</span><span style="color:#B9C4DC;font-weight:600">Fleet</span></div><div style="margin-top:10px;color:#5B6B8C;font:500 15px Segoe UI,sans-serif">Waiting for content...</div><div style="margin-top:6px;color:#3a4a6a;font-size:12px">v31 · XT1145 Spare</div></div>';
}

function showError(msg) {
  var c = document.getElementById('canvas');
  if (c) c.innerHTML = '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#0a0a0a"><div style="color:#ef4444;font:500 14px monospace;text-align:center;padding:20px">' + msg + '</div></div>';
}

window.addEventListener('load', boot);
