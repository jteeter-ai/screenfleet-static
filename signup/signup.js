// ScreenFleet Direct signup (2026-11-06). Talks to the ScreenFleet backend function `directSignup`.
// Plans and prices come from the server; checkout happens on Stripe.
(function () {
  var API = 'https://legion-screenfleet.base44.app/api/apps/699e82a2479ad26532b0b448/functions/directSignup';
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var state = { plans: [], extra: null, planKey: params.get('plan') || 'sfd_venue', qty: 1, extras: 0, interval: 'month' };

  function call(body) {
    return fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); });
  }
  function money(n) { return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
  function plan() { return state.plans.find(function (p) { return p.key === state.planKey; }); }
  function totals(sel) {
    var p = state.plans.find(function (x) { return x.key === sel.planKey; }); if (!p) return { total: 0, screens: 0 };
    var y = sel.interval === 'year';
    var unit = y ? p.annual : p.monthly, ex = y ? state.extra.annual : state.extra.monthly;
    if (p.kind === 'per_screen') return { total: unit * sel.qty, screens: sel.qty };
    var e = p.allows_extras ? sel.extras : 0;
    return { total: unit + ex * e, screens: p.included_screens + e };
  }
  function cheapest(screens) {
    var best = null;
    state.plans.forEach(function (p) {
      var cost, qty = 1, extras = 0;
      if (p.kind === 'per_screen') { if (screens > (p.max_qty || 4)) return; cost = p.monthly * screens; qty = screens; }
      else { extras = Math.max(0, screens - p.included_screens); cost = p.monthly + extras * state.extra.monthly; }
      if (!best || cost < best.cost) best = { key: p.key, cost: cost, qty: qty, extras: extras };
    });
    return best;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function render() {
    var y = state.interval === 'year';
    document.querySelectorAll('.toggle button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.interval === state.interval)); });
    $('plans').innerHTML = state.plans.map(function (p) {
      var price = y ? p.annual : p.monthly;
      var per = p.kind === 'per_screen' ? '/screen/' + (y ? 'yr' : 'mo') : '/' + (y ? 'yr' : 'mo');
      var scr = p.kind === 'per_screen' ? (p.min_qty || 1) + '–' + (p.max_qty || 4) + ' screens' : 'Up to ' + p.included_screens + ' screens';
      return '<button type="button" class="plan' + (p.highlighted ? ' hl' : '') + '" data-key="' + esc(p.key) + '" aria-pressed="' + (p.key === state.planKey) + '">' +
        (p.highlighted ? '<span class="badge">Most popular</span>' : '') +
        '<div class="name">' + esc(p.name) + '</div><div class="price"><b>' + money(price) + '</b><span>' + per + '</span></div>' +
        '<div class="scr">' + scr + '</div><div class="blurb">' + esc(p.blurb) + '</div></button>';
    }).join('');
    var p = plan(); if (!p) return;
    $('qtybar').hidden = false;
    var perScreen = p.kind === 'per_screen';
    var showStepper = perScreen || p.allows_extras;
    $('qtylabel').textContent = perScreen ? 'Screens' : 'Extra screens (' + money(y ? state.extra.annual : state.extra.monthly) + ' each)';
    $('qtylabel').parentElement.style.display = showStepper ? '' : 'none';
    var v = perScreen ? state.qty : state.extras, min = perScreen ? (p.min_qty || 1) : 0, max = perScreen ? (p.max_qty || 4) : state.extra.max;
    $('qty').textContent = v; $('minus').disabled = v <= min; $('plus').disabled = v >= max;
    var t = totals(state);
    $('summary').textContent = t.screens + ' screen' + (t.screens === 1 ? '' : 's') + ' · billed ' + (y ? 'yearly' : 'monthly');
    $('total').innerHTML = money(t.total) + '<span style="font-size:14px;font-weight:600;color:#5b6474">/' + (y ? 'yr' : 'mo') + '</span>';
    var best = cheapest(t.screens), mine = totals({ planKey: state.planKey, qty: state.qty, extras: state.extras, interval: 'month' }).total;
    var tip = $('tip');
    if (best && best.key !== state.planKey && best.cost < mine) {
      var bp = state.plans.find(function (x) { return x.key === best.key; });
      tip.hidden = false;
      tip.innerHTML = 'Tip: ' + t.screens + ' screens cost less on <strong>' + esc(bp.name) + '</strong>. <button type="button" id="switch">Switch</button>';
      $('switch').onclick = function () { state.planKey = best.key; state.qty = best.qty; state.extras = best.extras; render(); };
    } else tip.hidden = true;
  }

  document.querySelectorAll('.toggle button').forEach(function (b) { b.onclick = function () { state.interval = b.dataset.interval; render(); }; });
  $('plans').addEventListener('click', function (e) {
    var b = e.target.closest('.plan'); if (!b) return;
    state.planKey = b.dataset.key; var p = plan();
    if (p.kind === 'per_screen') state.qty = Math.min(Math.max(state.qty, 1), p.max_qty || 4); else state.extras = p.allows_extras ? state.extras : 0;
    render();
  });
  function step(d) {
    var p = plan(); if (!p) return;
    if (p.kind === 'per_screen') state.qty = Math.min(p.max_qty || 4, Math.max(p.min_qty || 1, state.qty + d));
    else state.extras = Math.min(state.extra.max, Math.max(0, state.extras + d));
    render();
  }
  $('minus').onclick = function () { step(-1); }; $('plus').onclick = function () { step(1); };

  

  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target, err = $('err'), go = $('go');
    if (!f.reportValidity()) return;
    err.hidden = true; go.disabled = true; go.textContent = 'Creating your account…';
    call({
      action: 'start', company_name: f.company_name.value, owner_name: f.owner_name.value, email: f.email.value,
      phone: f.phone.value, industry: f.industry.value, website: f.website.value, plan_key: state.planKey, quantity: state.qty,
      extra_screens: state.extras, interval: state.interval,
    }).then(function (r) {
      if (r && r.ok && r.state === 'ready') {
        location.href = './welcome/?trial=1&email=' + encodeURIComponent(r.email || '') + '&ends=' + encodeURIComponent(r.trial_ends_at || '');
        return;
      }
      if (r && r.ok && r.url) { location.href = r.url; return; }
      err.hidden = false; err.textContent = (r && r.message) || 'Something went wrong. Please try again.';
      if (r && r.signin_url) err.innerHTML = esc(r.message) + ' <a href="' + esc(r.signin_url) + '">Sign in</a>';
      go.disabled = false; go.textContent = 'Start free trial';
    }).catch(function () {
      err.hidden = false; err.textContent = 'Could not reach ScreenFleet. Check your connection and try again.';
      go.disabled = false; go.textContent = 'Start free trial';
    });
  });

  call({ action: 'plans' }).then(function (r) {
    if (!r || !r.ok) throw new Error('plans');
    state.plans = r.plans; state.extra = r.extra_screen;
    if (!plan()) state.planKey = 'sfd_venue';
    render();
  }).catch(function () { $('plans').innerHTML = '<p class="muted center">Pricing is not available right now. Please try again shortly.</p>'; });
})();
