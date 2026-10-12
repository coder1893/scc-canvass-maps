'use strict';
// Campaign map. Public map data comes from data/public.js; the Poll Summary and Interactions exports are read
// in this tab with SheetJS and never leave it (the page's CSP blocks every outbound connection).
(() => {
  const P = window.PUBLIC_DATA;
  const $ = id => document.getElementById(id);
  const app = $('app');
  const fmt = n => Math.round(n).toLocaleString('en-CA');
  const pct = (x, d = 0) => (x * 100).toFixed(d) + '%';
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const day = iso => iso ? new Date(iso + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const phone = () => matchMedia('(max-width: 760px)').matches;
  const vaName = c => `${P.code} ${pad(c, 3)}`;

  // ------------------------------------------------------------------ 2024 results (public)
  const PARTIES = [['ndp', 'NDP'], ['con', 'Conservative'], ['grn', 'Green'], ['oth', 'Other']];
  const valid = t => t.ndp + t.con + t.grn + t.oth;
  const lean = t => (t.con - t.ndp) / valid(t) * 100;  // positive = Conservative ahead
  const leanText = l => Math.abs(l) < 0.5 ? 'Even' : (l > 0 ? 'Con +' : 'NDP +') + Math.abs(l).toFixed(Math.abs(l) < 10 ? 1 : 0);
  const leanVar = l => Math.abs(l) < 0.5 ? 'even' : l > 0 ? 'con' : 'ndp';
  const chip = l => `<span class="chip" style="--chip:var(--${leanVar(l)})">${leanText(l)}</span>`;
  const sumWays = keys => keys.reduce((t, k) => { const w = P.results.byWay[k]; if (w) for (const p in t) t[p] += w[p] || 0; return t; },
    { ndp: 0, con: 0, grn: 0, oth: 0, rej: 0 });
  const total = sumWays(Object.keys(P.results.byWay));
  const ridingConShare = total.con / valid(total);
  const places = P.results.places.filter(pl => pl.day);
  const placeOf = {};
  places.forEach(pl => pl.polls.forEach(c => { placeOf[c] = pl; }));
  const runs = list => {  // [1,2,4,5,6] -> "1–2, 4–6"
    const out = [];
    list.forEach((n, i) => { if (i && n === list[i - 1] + 1) out[out.length - 1][1] = n; else out.push([n, n]); });
    return out.map(([a, b]) => a === b ? a : `${a}–${b}`).join(', ');
  };
  const polls = P.polls.map(p => Object.assign(p, { key: String(p.code), place: placeOf[p.code], reg2024: P.registered[p.code] || 0 }));
  const pollByKey = new Map(polls.map(p => [p.key, p]));

  // ------------------------------------------------------------------ state
  const S = { ps: null, ix: null, turnout: null, sites: [], view: 'support', shade: 'result', sel: null, sort: null };

  // ------------------------------------------------------------------ map
  const map = L.map('map', { preferCanvas: true, zoomControl: false, minZoom: 12, maxZoom: 20, zoomSnap: 0.5 });
  L.control.zoom({ position: 'topright' }).addTo(map);
  map.attributionControl.setPrefix(false).addAttribution('Elections BC · BC Digital Road Atlas · BC Address Geocoder');
  [['roads', 300], ['mask', 340], ['data', 400], ['pollLabels', 420], ['streetLabels', 430], ['places', 440], ['houseLabels', 460]]
    .forEach(([name, z]) => { map.createPane(name).style.zIndex = z; });
  ['roads', 'mask', 'pollLabels', 'streetLabels', 'places', 'houseLabels'].forEach(p => { map.getPane(p).style.pointerEvents = 'none'; });
  const roadCanvas = L.canvas({ pane: 'roads', padding: 0.4 });
  const dataCanvas = L.canvas({ pane: 'data', padding: 0.4, tolerance: 3 });

  const MAJOR = new Set(['freeway', 'highway', 'arterial', 'ramp']);
  const WIDTH = { freeway: 4.5, highway: 4.5, arterial: 3.2, ramp: 2, collector: 2.4, local: 1.6, strata: 1.3, yield: 1.3 };
  const DASH = new Set(['trail', 'recreation', 'pedestrian', 'resource']);
  const byClass = {};
  P.roads.forEach(([cls, flat]) => {
    const line = [];
    for (let i = 0; i < flat.length; i += 2) line.push([flat[i], flat[i + 1]]);
    (byClass[cls] = byClass[cls] || []).push(line);
  });
  const roadLayers = Object.entries(byClass).map(([cls, lines]) => ({ cls, layer: L.polyline(lines, {
    renderer: roadCanvas, pane: 'roads', interactive: false, lineCap: 'round', lineJoin: 'round', dashArray: DASH.has(cls) ? '3 4' : null }).addTo(map) }));
  const world = [[-89, -179], [-89, 179], [89, 179], [89, -179]];
  const mask = L.polygon([world, ...P.outline], { pane: 'mask', renderer: roadCanvas, stroke: false, interactive: false, fillOpacity: 0.55 }).addTo(map);
  const outline = L.polygon(P.outline, { pane: 'mask', renderer: roadCanvas, fill: false, weight: 3, interactive: false }).addTo(map);
  const streetLabels = L.layerGroup(P.streetLabels.map(([lat, lon, ang, i]) => L.marker([lat, lon], { pane: 'streetLabels', interactive: false, keyboard: false,
    icon: L.divIcon({ className: 'street-label', iconSize: [0, 0], html: `<span style="transform: rotate(${ang}deg) translate(-50%, -50%)">${esc(P.names[i])}</span>` }) })));
  const placeMarkers = L.layerGroup(places.filter(pl => pl.at).map(pl => L.marker(pl.at, { pane: 'places', interactive: false, keyboard: false,
    icon: L.divIcon({ className: 'place-label', iconSize: [0, 0], html: `<i></i><span>${esc(pl.name)}</span>` }) })));

  // polls: one canvas with the households so a click hits the household on top first
  polls.forEach(p => {
    p.layer = L.polygon(p.rings, { renderer: dataCanvas, pane: 'data', weight: 1, fillOpacity: 0 }).addTo(map)
      .bindTooltip(() => pollTip(p), { sticky: true, direction: 'top', offset: [0, -10], opacity: 1 })
      .on('mouseover', () => p.layer.setStyle({ weight: 2.5, color: tok('fg') }))
      .on('mouseout', () => stylePoll(p))
      .on('click', e => openPoll(p, e.latlng));
  });

  // ------------------------------------------------------------------ poll shading
  const SHADES = [
    { k: 'result', label: '2024 result' },
    { k: 'support', label: 'Supporters found', needs: 'ps' },
    { k: 'unknown', label: 'Not contacted', needs: 'ps' },
    { k: 'skipped', label: 'Didn’t vote in 2024', needs: 'lists' },
  ];
  const ALPHA5 = [0.08, 0.2, 0.34, 0.5, 0.66];
  const STEPS = {
    support: { color: 'con', breaks: [0.02, 0.05, 0.10, 0.20, 0.35], alpha: [0.06, 0.16, 0.28, 0.42, 0.56, 0.70], get: r => r.supportPct, label: v => pct(v),
      title: 'Supporters found, as a share of voters', note: 'From the Poll Summary.' },
    unknown: { color: 'ramp-contact', breaks: [0.5, 0.7, 0.85, 0.95], alpha: ALPHA5, get: r => r.unknown, label: v => pct(v), quantile: 0.01,
      title: 'Voters not contacted yet', note: 'From the Poll Summary. Darker means more doors still to knock.' },
    skipped: { color: 'ramp-gotv', breaks: [10, 25, 50, 100], alpha: ALPHA5, get: r => r.not, label: v => fmt(v), quantile: 5, src: 'turnout',
      title: 'Supporters who didn’t vote in 2024', note: 'From the 2024 supporter lists. Darker means more people to remind to vote.' },
  };
  const has = needs => !needs || (needs === 'ps' ? !!S.ps : needs === 'lists' ? !!S.turnout : true);
  const rowFor = (st, key) => st.src === 'turnout' ? turnoutFor(key) : S.ps && S.ps.rows.get(key);
  function setBreaks() {  // quintiles of the loaded polls, rounded, so each shade holds about a fifth of the map
    for (const st of Object.values(STEPS)) {
      if (!st.quantile) continue;
      const vals = polls.map(p => rowFor(st, p.key)).filter(Boolean).map(st.get).sort((a, b) => a - b);
      if (vals.length < 5) continue;
      const q = [0.2, 0.4, 0.6, 0.8].map(f => Math.round(vals[Math.floor(f * (vals.length - 1))] / st.quantile) * st.quantile);
      st.breaks = q.filter((v, i) => i === 0 || v > q[i - 1]);
      st.alpha = ALPHA5.slice(5 - st.breaks.length - 1);
    }
  }
  const RESULT_STEPS = [[-Infinity, -10, 'ndp', 0.62], [-10, -5, 'ndp', 0.44], [-5, -2, 'ndp', 0.28], [-2, 2, 'even', 0.24],
    [2, 5, 'con', 0.28], [5, 10, 'con', 0.44], [10, Infinity, 'con', 0.62]];
  const classOf = (v, breaks) => breaks.filter(b => v >= b).length;
  function shadeOf(p) {
    if (S.shade === 'result') {
      if (!p.place) return null;
      const l = lean(p.place.day);
      const [, , color, alpha] = RESULT_STEPS.find(([a, b]) => l >= a && l < b);
      return { color, alpha };
    }
    const st = STEPS[S.shade], r = st && rowFor(st, p.key);
    return r ? { color: st.color, alpha: st.alpha[classOf(st.get(r), st.breaks)] } : null;
  }
  const tok = n => getComputedStyle(app).getPropertyValue('--' + n).trim();
  function stylePoll(p) {
    const s = shadeOf(p), selected = S.sel === p.key;
    p.layer.setStyle({ color: selected ? tok('fg') : tok('va'), weight: selected ? 3 : 1, dashArray: selected ? null : '4 3',
      fillColor: s ? tok(s.color) : 'transparent', fillOpacity: s ? s.alpha : 0 });
  }
  const restylePolls = () => polls.forEach(stylePoll);

  function renderShade() {
    const shades = SHADES.filter(s => has(s.needs));
    if (!shades.some(s => s.k === S.shade)) S.shade = 'result';
    $('shade').innerHTML = shades.map(s => `<button type="button" role="radio" data-k="${s.k}" aria-checked="${S.shade === s.k}">${s.label}</button>`).join('');
    const swatches = (list, color) => `<div class="scale">${list.map(([c, a]) => `<span style="background:color-mix(in srgb, var(--${c || color}) ${a * 100}%, var(--land))"></span>`).join('')}</div>`;
    if (S.shade === 'result') {
      $('legend').innerHTML = `<h3>2024 result at each poll’s voting place</h3>${swatches(RESULT_STEPS.map(([, , c, a]) => [c, a]))}
        <div class="scale-labels">${['NDP +10', '+5', '+2', 'Even', '+2', '+5', 'Con +10'].map(t => `<span>${t}</span>`).join('')}</div>
        <p>Polls that voted at the same place share its colour.</p>`;
    } else {
      const st = STEPS[S.shade];
      const edges = ['<' + st.label(st.breaks[0]), ...st.breaks.slice(0, -1).map((b, i) => `${st.label(b)}–${st.label(st.breaks[i + 1])}`), st.label(st.breaks.at(-1)) + '+'];
      $('legend').innerHTML = `<h3>${st.title}</h3>${swatches(st.alpha.map(a => [null, a]), st.color)}
        <div class="scale-labels">${edges.map(t => `<span>${t}</span>`).join('')}</div><p>${st.note}</p>`;
    }
  }
  $('shade').addEventListener('click', e => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    S.shade = b.dataset.k;
    renderShade();
    restylePolls();
  });

  // ------------------------------------------------------------------ poll tooltip and card
  function pollTip(p) {
    const r = S.ps && S.ps.rows.get(p.key), t = S.turnout && turnoutFor(p.key);
    const parts = [`<b>Poll ${p.code}</b>`];
    if (p.place) parts.push(`2024: ${leanText(lean(p.place.day))}`);
    if (r) parts.push(`${fmt(r.support)} supporters`, `${pct(r.unknown)} not contacted`);
    if (t) parts.push(`${fmt(t.not)} didn’t vote in 2024`);
    return parts.join(' · ');
  }
  function partyBars(t, names) {
    const v = valid(t);
    return `<div class="bars">${PARTIES.map(([k, n]) => {
      const who = names && P.results.candidates[k] ? `<small>${esc(P.results.candidates[k].map(c => c.name).join(', '))}</small>` : '';
      return `<div class="bar-row"><span class="who">${n}${who}</span><span class="val"><b>${pct(t[k] / v, 1)}</b> · ${fmt(t[k])}</span>
        <span class="track"><span class="fill" style="width:${(t[k] / v) * 100}%;background:var(--${k})"></span></span></div>`;
    }).join('')}</div>`;
  }
  function pollCard(p) {
    const r = S.ps && S.ps.rows.get(p.key), t = S.turnout && turnoutFor(p.key), pl = p.place;
    let h = `<div class="pop"><h3>Poll ${p.code}</h3>`;
    if (r || t) {
      h += '<div class="grid">';
      if (r) h += `<div><b>${fmt(r.support)}</b><span>supporters found (${pct(r.supportPct)} of ${fmt(r.reg)} voters)</span></div>
        <div><b>${pct(r.unknown)}</b><span>not contacted yet</span></div>`;
      if (t) h += `<div><b>${fmt(t.not)}</b><span>supporters didn’t vote in 2024${t.notPhone ? `, ${fmt(t.notPhone)} with a phone` : ''}</span></div>`;
      h += '</div>';
    } else h += `<p class="meta">${fmt(p.reg2024)} registered voters (2024)</p>`;
    if (pl) h += `<h4>2024 result · ${chip(lean(pl.day))}</h4><p class="meta">Election day at ${esc(pl.name)} (polls ${runs(pl.polls)})</p>${partyBars(pl.day)}`;
    if (r && r.streets.length) h += `<details><summary>Streets in this poll</summary><div class="streets">${r.streets.map(s => `<span>${esc(s.name)} <span class="num">${s.n}</span></span>`).join('')}</div></details>`;
    return h + '</div>';
  }
  function openPoll(p, at) {
    selectPoll(p.key, false);
    L.popup({ maxWidth: 330, autoPanPaddingTopLeft: [24, 72], autoPanPaddingBottomRight: [24, 24] }).setLatLng(at || p.at).setContent(pollCard(p)).openOn(map);
  }
  function selectPoll(key, zoom) {
    S.sel = key;
    restylePolls();
    document.querySelectorAll('#pollBody tr').forEach(tr => tr.classList.toggle('sel', tr.dataset.key === key));
    const p = pollByKey.get(key);
    if (zoom && p) map.fitBounds(p.layer.getBounds(), { padding: [40, 40], animate: !reduced, maxZoom: 17 });
  }
  map.on('popupclose', () => { if (S.sel) { S.sel = null; restylePolls(); document.querySelectorAll('#pollBody tr.sel').forEach(tr => tr.classList.remove('sel')); } });

  // ------------------------------------------------------------------ labels (polls, streets, households)
  const labels = L.layerGroup().addTo(map);
  function placer() {
    const boxes = [];
    return (x, y, w, h) => {
      for (const b of boxes) if (x < b[2] && x + w > b[0] && y < b[3] && y + h > b[1]) return false;
      boxes.push([x, y, x + w, y + h]);
      return true;
    };
  }
  function refreshLabels() {
    labels.clearLayers();
    const z = map.getZoom(), view = map.getBounds().pad(0.15);
    if (z >= 15.5) streetLabels.addTo(map); else streetLabels.remove();
    if (z >= 13.5) placeMarkers.addTo(map); else placeMarkers.remove();
    map.getContainer().classList.toggle('place-names', z >= 15);
    if (z >= 12.5 && z < 17) {
      const fits = placer();
      polls.forEach(p => {
        const pt = map.latLngToContainerPoint(p.at), w = 12 + String(p.code).length * 7;
        if (view.contains(p.at) && fits(pt.x - w / 2 - 3, pt.y - 9, w + 6, 18)) {
          labels.addLayer(L.marker(p.at, { pane: 'pollLabels', interactive: false, keyboard: false,
            icon: L.divIcon({ className: 'poll-label', iconSize: [0, 0], html: `<span>${p.code}</span>` }) }));
        }
      });
    }
    if (!S.sites.length || z < 16) return;
    const fits = z >= 19 ? () => true : placer();
    const shown = S.sites.filter(s => s.shown && view.contains(s.p));
    if (z < 19) shown.forEach(s => { const pt = map.latLngToContainerPoint(s.p), r = radius(s) + 1; fits(pt.x - r, pt.y - r, 2 * r, 2 * r); });
    shown.sort((a, b) => countFor(b) - countFor(a));
    let n = 0;
    for (const s of shown) {
      if (++n > 1500) break;
      const text = z >= 18 ? s.civic : s.civic.split(' ')[0], count = countFor(s);
      const pt = map.latLngToContainerPoint(s.p), w = text.length * 6.2 + (count > 1 ? 8 + String(count).length * 6 : 0), r = radius(s) + 3;
      let side = '';
      if (!fits(pt.x + r, pt.y - 7, w, 14)) {
        if (!fits(pt.x - r - w, pt.y - 7, w, 14)) continue;
        side = ' left';
      }
      labels.addLayer(L.marker(s.p, { pane: 'houseLabels', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'house-label' + side, iconSize: [0, 0], html: `<span>${esc(text)}${count > 1 ? `<small>×${count}</small>` : ''}</span>` }) }));
    }
  }
  map.on('zoomend moveend', refreshLabels);

  // ------------------------------------------------------------------ households
  const CATEGORY = { 'Conservative': 'con', 'Conservative-Leaning': 'lean', 'NDP': 'ndp', 'NDP-Leaning': 'ndp_lean', 'Green': 'grn',
    'Independent': 'oth', 'Other': 'oth', 'Undecided': 'und', 'Will Not Say': 'und', 'Unknown': 'und', 'Do Not Contact': 'dnc' };
  const SUPPORT = ['con', 'lean', 'sup24'], OPPOSE = ['ndp', 'ndp_lean', 'grn', 'oth'];
  const sumOf = (s, ks) => ks.reduce((t, k) => t + (s.n[k] || 0), 0);
  const VIEWS = [  // one choice at a time: what the dots on the map are
    { k: 'support', label: 'Supporters', test: s => sumOf(s, SUPPORT) > 0, count: s => sumOf(s, SUPPORT),
      key: [['con', 'Supporter'], ['ring', 'Lawn sign requested']] },
    { k: 'skipped', label: 'Didn’t vote in 2024', needs: 'lists', test: s => s.notVoted > 0, count: s => s.notVoted,
      key: [['con', 'Supporter who didn’t vote in 2024']] },
    { k: 'oppose', label: 'Other parties', test: s => sumOf(s, OPPOSE) > 0, count: s => sumOf(s, OPPOSE),
      key: [['ndp', 'NDP'], ['grn', 'Green'], ['oth', 'Other party']] },
    { k: 'und', label: 'Undecided', test: s => (s.n.und || 0) > 0, count: s => s.n.und || 0,
      key: [['und', 'Undecided or won’t say']] },
    { k: 'all', label: 'Everyone', test: s => Object.values(s.n).some(Boolean), count: s => Object.values(s.n).reduce((t, v) => t + v, 0),
      key: [['con', 'Supporter'], ['ndp', 'NDP'], ['grn', 'Green'], ['oth', 'Other'], ['und', 'Undecided'], ['dnc', 'Do not contact']] },
  ];
  const viewOf = () => VIEWS.find(v => v.k === S.view && has(v.needs)) || VIEWS[0];
  function kindOf(s) {  // the dot's colour: supporters blue, other parties in their colour, undecided grey, do-not-contact a red ring
    const v = viewOf().k;
    if (v !== 'oppose' && v !== 'und' && (sumOf(s, SUPPORT) || v === 'skipped')) return 'con';
    if (v === 'oppose' || v === 'all') {
      if (s.n.ndp || s.n.ndp_lean) return 'ndp';
      if (s.n.grn) return 'grn';
      if (s.n.oth) return 'oth';
    }
    if (s.n.und) return 'und';
    return s.n.dnc ? 'dnc' : 'con';
  }
  const dot = k => k === 'ring' ? 'border:2.5px solid var(--sign);background:transparent' : k === 'dnc' ? 'border:2px dashed var(--dnc);background:transparent' : `background:var(--${k})`;
  const countFor = s => s.shown ? viewOf().count(s) : 0;
  const radius = s => 4.5 + Math.min(5, Math.sqrt(Math.max(1, countFor(s))) - 1);

  const ABBR = { AVENUE: 'AVE', AV: 'AVE', STREET: 'ST', ROAD: 'RD', DRIVE: 'DR', BOULEVARD: 'BLVD', CRESCENT: 'CRES', CRK: 'CRES', CR: 'CRES',
    PLACE: 'PL', COURT: 'CRT', CT: 'CRT', HIGHWAY: 'HWY', PARKWAY: 'PKY', LANE: 'LANE', TERRACE: 'TERR', WAY: 'WAY', CIRCLE: 'CIR', GATE: 'GATE', EAST: 'E', WEST: 'W' };
  const ALIAS = { 'KING GEORGE HWY': 'KING GEORGE BLVD' };
  const TYPES = /\s(AVE|ST|RD|DR|BLVD|CRES|PL|CRT|HWY|PKY|WAY|LANE|TERR|CIR|GATE)$/;
  const PRETTY = Object.fromEntries(P.names.filter(Boolean).map(n => [n.toUpperCase(), n]));
  const BY_NAME = {};  // street name without its type, spaces removed -> address-list keys
  Object.keys(P.addresses).forEach(k => { const n = k.replace(TYPES, '').replace(/ /g, ''); (BY_NAME[n] = BY_NAME[n] || []).push(k); });
  function lev(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1]));
      prev = cur;
    }
    return prev[b.length];
  }
  const normCache = new Map();
  function normStreet(raw) {  // '89Avenue', '140St', '90 A Ave', '100th Ave', 'Grosvener Rd' -> the address list's spelling
    if (normCache.has(raw)) return normCache.get(raw);
    let st = raw.toUpperCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
    st = st.replace(/^(\d+)(?:TH|ND|RD)\b\s*/, '$1 ').replace(/^(\d+)ST\s+(ST|AVE)$/, '$1 $2');
    st = st.replace(/^(\d+)\s?([A-Z]?)\s?(AVENUE|AVE|AV|STREET|ST)$/, '$1$2 $3');
    st = st.split(' ').map(w => ABBR[w] || w).join(' ');
    const bare = /^(\d+)([A-Z]?)$/.exec(st);
    if (bare) st = `${st} ${+bare[1] < 125 ? 'AVE' : 'ST'}`;  // Surrey grid: avenues run low, streets high
    st = ALIAS[st] || st;
    if (!P.addresses[st]) {
      const name = st.replace(TYPES, '').replace(/ /g, '');
      let hits = BY_NAME[name] || [];
      if (hits.length !== 1 && name.length >= 6 && !/^\d/.test(name)) {
        hits = Object.entries(BY_NAME).filter(([n]) => !/^\d/.test(n) && lev(n, name) <= 2).flatMap(([, ks]) => ks);
      }
      if (hits.length === 1) st = hits[0];
    }
    normCache.set(raw, st);
    return st;
  }
  const splitCivic = civic => /^(\d+)\s+(.+)$/.exec(civic.trim());
  const siteKey = civic => { const m = splitCivic(civic); return m ? `${m[1]} ${normStreet(m[2])}` : civic.toUpperCase(); };
  const prettyCivic = civic => { const m = splitCivic(civic); if (!m) return civic; const st = normStreet(m[2]); return `${m[1]} ${PRETTY[st] || m[2]}`; };
  function locate(civic) {
    const m = /^(\d+)\s+(.+)$/.exec(civic.trim());
    if (!m) return null;
    const n = +m[1], st = normStreet(m[2]);
    const L_ = P.addresses[st];
    if (!L_) return null;
    let lo = null, hi = null;
    for (const a of L_) {
      if (a[0] === n) return { p: [a[1], a[2]], approx: false };
      if (a[0] < n) lo = a; else if (!hi) hi = a;
    }
    if (lo && hi && hi[0] - lo[0] <= 120) {  // between two known numbers on the street: interpolate
      const t = (n - lo[0]) / (hi[0] - lo[0]);
      return { p: [lo[1] + (hi[1] - lo[1]) * t, lo[2] + (hi[2] - lo[2]) * t], approx: true };
    }
    const near = [lo, hi].filter(Boolean).sort((a, b) => Math.abs(a[0] - n) - Math.abs(b[0] - n))[0];
    return near && Math.abs(near[0] - n) <= 30 ? { p: [near[1], near[2]], approx: true } : null;
  }
  function inside(pt, rings) {  // even-odd over all rings handles holes and multipart polygons
    const [y, x] = pt;
    let c = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [yi, xi] = ring[i], [yj, xj] = ring[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
      }
    }
    return c;
  }

  const houseLayer = L.layerGroup().addTo(map);
  function buildHouses() {
    houseLayer.clearLayers();
    S.sites.forEach(s => {
      if (!s.p) return;
      s.marker = L.circleMarker(s.p, { renderer: dataCanvas, pane: 'data', radius: 5 }).bindPopup(() => houseCard(s), { maxWidth: 320, autoPanPaddingTopLeft: [24, 72], autoPanPaddingBottomRight: [24, 24] });
      if (s.ls) s.ring = L.circleMarker(s.p, { renderer: dataCanvas, pane: 'data', radius: 8, fill: false, interactive: false });
    });
    updateHouses();
  }
  function updateHouses() {
    houseLayer.clearLayers();
    const c = tokens(), v = viewOf();
    for (const s of S.sites) {
      s.shown = !!(s.p && v.test(s));
      if (!s.shown) continue;
      s.kind = kindOf(s);
      styleHouse(s, c);
      if (s.ring && (v.k === 'support' || v.k === 'all')) houseLayer.addLayer(s.ring);
      houseLayer.addLayer(s.marker);
    }
    renderViews();
    refreshLabels();
  }
  function styleHouse(s, c) {
    const r = radius(s), col = c[s.kind];
    const st = s.kind === 'dnc' ? { fillColor: c.surface, fillOpacity: 1, color: col, weight: 2.2, dashArray: '2 2' }
      : { fillColor: col, fillOpacity: 1, color: c.halo, weight: 1.6, dashArray: null };
    if (s.out) Object.assign(st, { fillOpacity: s.kind === 'dnc' ? 1 : 0.35, color: col, dashArray: '3 2' });
    s.marker.setStyle(st).setRadius(r);
    if (s.ring) s.ring.setStyle({ color: c.sign, weight: 2.4 }).setRadius(r + 3.5);
  }
  const tokens = () => Object.fromEntries(['fg', 'halo', 'surface', 'sign', 'va', 'con', 'ndp', 'grn', 'oth', 'und', 'dnc', 'ramp-gotv'].map(k => [k, tok(k)]));

  function houseCard(s) {
    const line = (k, label, n) => `<li><i class="dot" style="${dot(k)}"></i><span>${label}</span><b class="num">${n}</b></li>`;
    const lines = [];
    const now = (s.n.con || 0) + (s.n.lean || 0), listed = s.voted + s.notVoted, opp = (s.n.ndp || 0) + (s.n.ndp_lean || 0);
    if (now) lines.push(line('con', 'Supporters found this election', now));
    if (listed) lines.push(line('con', 'On the 2024 supporter list', listed));
    if (s.notVoted) lines.push(`<li class="sub"><i class="dot" style="${dot('ramp-gotv')}"></i><span>of them didn’t vote in 2024${s.phoneNV ? ` (${s.phoneNV} with a phone)` : ''}</span><b class="num">${s.notVoted}</b></li>`);
    if (opp) lines.push(line('ndp', 'NDP', opp));
    if (s.n.grn) lines.push(line('grn', 'Green', s.n.grn));
    if (s.n.oth) lines.push(line('oth', 'Other party', s.n.oth));
    if (s.n.und) lines.push(line('und', 'Undecided or won’t say', s.n.und));
    if (s.n.dnc) lines.push(line('dnc', 'Do not contact', s.n.dnc));
    const units = [...new Set([...s.units.keys(), ...s.vUnits.keys()])].filter(Boolean).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const marked = units.some(u => s.vUnits.get(u)?.not);
    const unitHtml = units.length ? `<p class="meta units">Units${marked ? ' (<i class="dot inline" style="background:var(--ramp-gotv)"></i>didn’t vote in 2024)' : ''}: ${units.slice(0, 48).map(u =>
      `<span>${s.vUnits.get(u)?.not ? '<i class="dot inline" style="background:var(--ramp-gotv)"></i>' : ''}${esc(u)}</span>`).join('')}${units.length > 48 ? ` +${units.length - 48} more` : ''}</p>` : '';
    const flags = [];
    if (s.ls) flags.push(`<p class="flag sign">Lawn sign requested${s.ls > 1 ? ` (${s.ls})` : ''}</p>`);
    if (s.out) flags.push(`<p class="flag">Outside the ${esc(P.riding)} boundary.</p>`);
    if (s.approx) flags.push('<p class="flag">Location estimated from neighbouring house numbers.</p>');
    const meta = [`Poll ${s.va || s.poll || '?'}`, s.last ? `last contact ${day(s.last)}` : 'not contacted yet this election'];
    return `<div class="pop"><h3>${esc(s.civic)}</h3><p class="meta">${meta.join(' · ')}</p><ul class="counts">${lines.join('')}</ul>${unitHtml}${flags.join('')}</div>`;
  }

  // ------------------------------------------------------------------ reading the exports
  const cell = v => v == null ? '' : String(v).trim();
  function isoDate(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return `${d.y}-${pad(d.m)}-${pad(d.d)}`; }
    if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    return m ? m[0] : '';
  }
  function sniff(rows) {
    for (let i = 0; i < Math.min(rows.length, 120); i++) {
      const r = rows[i] || [];
      if (cell(r[0]) === 'Poll' && r.some(v => cell(v) === 'Reg Voters')) return ['ps', i];
      if (cell(r[0]) === 'Date' && cell(r[1]) === 'Voter') return ['ix', i];
      if (r.some(v => cell(v) === 'Street') && r.some(v => cell(v) === 'Poll') && r.some(v => cell(v) === 'Voter_ID')) return ['list', i];
    }
    return [null, -1];
  }
  const pollKey = v => cell(v).replace(/^0+(?=\d)/, '').toUpperCase();
  function parsePollSummary(rows, head, file) {
    const H = rows[head].map(cell), col = n => H.indexOf(n);
    const need = ['Poll', 'Reg Voters', 'Cur Unknown Pct', 'Cur Support', 'Cur Support Pct'];
    const missing = need.filter(n => col(n) < 0);
    if (missing.length) throw new Error(`${file.name} is missing the ${missing.join(', ')} column${missing.length > 1 ? 's' : ''}.`);
    const num = (r, n) => col(n) < 0 ? 0 : (+r[col(n)] || 0);
    const out = new Map();
    for (const r of rows.slice(head + 1)) {
      if (!r || r[col('Poll')] == null || cell(r[col('Poll')]) === '') continue;
      const key = pollKey(r[col('Poll')]);
      const streets = cell(r[col('Notes')]).split(/,\s*(?![^()]*\))/).map(t => /^(.*?)\s*\((\d+)\)$/.exec(t.trim())).filter(Boolean).map(m => ({ name: m[1], n: +m[2] }));
      const place = placeOf[+key];
      const conShare = place ? place.day.con / valid(place.day) : ridingConShare;
      const row = { key, reg: num(r, 'Reg Voters'), hh: num(r, 'Households'), phones: num(r, 'Phones'), unknown: num(r, 'Cur Unknown Pct'),
        support: num(r, 'Cur Support'), supportPct: num(r, 'Cur Support Pct'), streets, conShare, onMap: pollByKey.has(key) };
      row.find = row.reg * row.unknown * conShare;
      out.set(key, row);
    }
    const rowsArr = [...out.values()];
    const counted = rowsArr.filter(r => r.reg > 0);
    const reg = counted.reduce((t, r) => t + r.reg, 0);
    return { name: file.name, rows: out,
      totals: { reg, hh: rowsArr.reduce((t, r) => t + r.hh, 0), phones: rowsArr.reduce((t, r) => t + r.phones, 0),
        support: rowsArr.reduce((t, r) => t + r.support, 0), unknown: counted.reduce((t, r) => t + r.unknown * r.reg, 0) / (reg || 1) },
      asOf: (/(\d{4}-\d{2}-\d{2})/.exec(file.name) || [])[1] || '' };
  }
  function parseInteractions(rows, head, file) {
    const voters = new Map();
    let count = 0, latest = '';
    for (const r of rows.slice(head + 1)) {
      if (!r || r[0] == null || !cell(r[6])) continue;
      count++;
      const date = isoDate(r[0]), addr = cell(r[4]);
      latest = date > latest ? date : latest;
      if (!addr) continue;
      const key = cell(r[1]) + '|' + addr;
      let v = voters.get(key);
      if (!v) voters.set(key, v = { addr, poll: pollKey(r[3]), support: null, sdate: '', lawnsign: false, last: '' });
      if (date > v.last) v.last = date;
      const field = cell(r[6]), sp = field.indexOf(' '), f = sp < 0 ? field : field.slice(0, sp), val = sp < 0 ? '' : field.slice(sp + 1);
      if (f === 'Support' && date > v.sdate) { v.support = val; v.sdate = date; }  // newest first: ties keep the first row
      else if (f === 'LawnSign' && val === 'Yes') v.lawnsign = true;
    }
    const sites = new Map();
    for (const v of voters.values()) {
      const a = v.addr.replace(/\s+/g, ' ').trim();
      let unit = '', civic = a;
      if (a.startsWith('- ') || a.includes(' - ')) { const i = a.indexOf('- '); unit = a.slice(0, i).replace(/[\s-]+$/, ''); civic = a.slice(i + 2).trim(); }
      const cat = CATEGORY[v.support] || (v.lawnsign ? 'con' : null);  // a sign request with no answer yet counts as support
      const k = siteKey(civic);
      let s = sites.get(k);
      if (!s) sites.set(k, s = { key: k, civic: prettyCivic(civic), polls: {}, n: {}, units: new Map(), ls: 0, last: '' });
      s.polls[v.poll] = (s.polls[v.poll] || 0) + 1;
      if (cat) s.n[cat] = (s.n[cat] || 0) + 1;
      if (!s.units.has(unit)) s.units.set(unit, {});
      if (cat) s.units.get(unit)[cat] = (s.units.get(unit)[cat] || 0) + 1;
      s.ls += v.lawnsign ? 1 : 0;
      if (v.last > s.last) s.last = v.last;
    }
    return { name: file.name, count, latest, voters: voters.size, seeds: [...sites.values()].filter(s => Object.keys(s.n).length) };
  }

  // supporter turnout lists ("Yes, voted" / "Yes, not voted"): one row per supporter with poll and street address
  function listAddress(raw) {
    let a = cell(raw).replace(/\s+/g, ' ');
    if (!a || /^(N\/?A|NULL|-)$/i.test(a)) return null;
    a = a.replace(/^(unit|apt|suite|#)\s*[-#]?\s*/i, '');
    const m = /^(?:([A-Za-z0-9]+)\s*-\s*)?(\d+)\s*(.*)$/.exec(a);
    if (!m) return null;
    const [, unit, n, rest] = m;
    // '13465-90 Ave' or '13868-91 A' is house number, dash, numbered street
    if (unit && /^\d{4,}$/.test(unit) && +n < 200 && /^([A-Za-z])?\s*(AVENUE|AVE|STREET|ST)?\.?$/i.test(rest.trim())) return { unit: '', civic: `${unit} ${n}${rest.trim()}` };
    return rest.trim() ? { unit: unit || '', civic: `${n} ${rest.trim()}` } : null;
  }
  function parseList(rows, head, file, kind) {
    const H = rows[head].map(cell), col = n => H.indexOf(n);
    const people = [];
    for (const r of rows.slice(head + 1)) {
      if (!r || r.every(v => v == null || v === '')) continue;
      const phone = cell(r[col('Phone')]);
      people.push({ poll: pollKey(r[col('Poll')]), street: r[col('Street')], phone: !!phone && !/^null$/i.test(phone) });
    }
    return { kind, name: file.name, people };
  }
  const listKind = name => /not/i.test(name) ? 'not' : 'voted';
  function turnoutFor(key) {
    const t = S.turnout && S.turnout.byPoll;
    return t && (t.get(key) || t.get(key.replace(/S$/, '')));
  }

  // one site per civic address, from the canvass answers and the turnout lists together
  function composeSites() {
    const sites = new Map();
    const get = (key, civic) => {
      let s = sites.get(key);
      if (!s) sites.set(key, s = { key, civic, polls: {}, n: {}, units: new Map(), ls: 0, last: '', voted: 0, notVoted: 0, phoneNV: 0, vUnits: new Map() });
      return s;
    };
    for (const seed of S.ix ? S.ix.seeds : []) {
      const s = get(seed.key, seed.civic);
      Object.assign(s, { polls: { ...seed.polls }, n: { ...seed.n }, units: seed.units, ls: seed.ls, last: seed.last, fromIx: true });
    }
    S.turnout = null;
    const NO_POLL = new Set(['', '999']);  // the lists use 999 for "no poll assigned"
    const lists = [S.lists?.voted, S.lists?.not].filter(Boolean), entries = [];
    let unplaced = 0;
    for (const list of lists) {
      for (const person of list.people) {
        const a = listAddress(person.street);
        const s = a && get(siteKey(a.civic), prettyCivic(a.civic));
        entries.push({ s, kind: list.kind, phone: person.phone, poll: person.poll });
        if (!s) { unplaced++; continue; }
        if (!s.fromIx && !NO_POLL.has(person.poll)) s.polls[person.poll] = (s.polls[person.poll] || 0) + 1;
        const u = s.vUnits.get(a.unit) || { voted: 0, not: 0 };
        s.vUnits.set(a.unit, u);
        if (list.kind === 'voted') { s.voted++; u.voted++; } else { s.notVoted++; u.not++; if (person.phone) s.phoneNV++; }
      }
    }
    for (const s of sites.values()) {
      if (!s.fromIx) { s.n.sup24 = s.voted + s.notVoted; s.fromList = true; }  // a "Yes" on the 2024 lists, not yet contacted this time
      const hit = locate(s.civic);
      if (hit) {
        s.p = hit.p; s.approx = hit.approx;
        s.out = !inside(s.p, P.outline);
        s.va = s.out ? null : polls.find(p => inside(s.p, p.rings))?.code ?? null;
      }
      s.poll = Object.entries(s.polls).sort((a, b) => b[1] - a[1])[0]?.[0] ?? (s.va ? String(s.va) : '');
      s.pollFromMap = !Object.keys(s.polls).length && !!s.va;
    }
    if (lists.length) {
      const byPoll = new Map();
      let mapped = 0;
      for (const e of entries) {  // a person with no poll on the list takes the poll their address falls in
        let key = e.poll;
        if (NO_POLL.has(key) && e.s?.va) { key = String(e.s.va); mapped++; }
        const t = byPoll.get(key) || { voted: 0, not: 0, notPhone: 0 };
        byPoll.set(key, t);
        if (e.kind === 'voted') t.voted++; else { t.not++; if (e.phone) t.notPhone++; }
      }
      const sum = k => [...byPoll.values()].reduce((t, v) => t + v[k], 0);
      const noPoll = (byPoll.get('999')?.voted || 0) + (byPoll.get('999')?.not || 0);
      S.turnout = { byPoll, unplaced, mapped, noPoll, voted: sum('voted'), not: sum('not'), notPhone: sum('notPhone'), lists };
    }
    S.sites = [...sites.values()];
  }

  function afterLoad() {
    composeSites();
    buildHouses();
    setBreaks();
    renderAll();
  }
  async function loadFiles(files) {
    const errors = [];
    for (const f of files) {
      try {
        const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null, blankrows: false });
        const [kind, head] = sniff(rows);
        if (kind === 'ps') S.ps = parsePollSummary(rows, head, f);
        else if (kind === 'ix') S.ix = parseInteractions(rows, head, f);
        else if (kind === 'list') { const l = parseList(rows, head, f, listKind(f.name)); S.lists = { ...S.lists, [l.kind]: l }; }
        else errors.push(`${f.name} isn’t a Poll Summary, Interactions export or voting list. The Poll Summary starts with a “Poll, City, Reg Voters” header row; the Interactions export has a “Date, Voter, Poll, Address” table; a voting list has “Phone, Poll, Street, Voter_ID” columns.`);
      } catch (e) {
        errors.push(`${f.name} couldn’t be read: ${e.message}`);
      }
    }
    $('loadError').hidden = !errors.length;
    $('loadError').textContent = errors.join(' ');
    S.builtIn = false;
    afterLoad();
    if (S.sites.length && !S.ps) selectTab('homes');
  }
  $('files').addEventListener('change', e => { loadFiles([...e.target.files]); e.target.value = ''; });
  $('clearData').addEventListener('click', () => {
    S.ps = null; S.ix = null; S.lists = null; S.turnout = null; S.sites = []; S.sort = null; S.builtIn = false; S.view = 'support';
    houseLayer.clearLayers();
    S.shade = 'result';
    map.closePopup();
    renderAll();
    if (ENC) lock();
  });

  // ------------------------------------------------------------------ built-in data, encrypted with the team password
  // data/campaign.enc.js holds AES-256-GCM ciphertext; the key is derived from the password with PBKDF2-SHA256.
  // The derived key may be kept in sessionStorage so a reload in the same tab doesn't ask again; closing the tab drops it.
  const ENC = window.CAMPAIGN_ENC;
  const KEY_SLOT = 'campaign-map-key';
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  async function deriveKey(password) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(ENC.salt), iterations: ENC.iterations },
      base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  }
  async function openWith(key) {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ENC.iv) }, key, unb64(ENC.data));
    const text = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    return JSON.parse(text);
  }
  function applyBuiltIn(d) {
    const ps = d.ps && sniff(d.ps.rows), ix = d.ix && sniff(d.ix.rows);
    if (ps && ps[0] === 'ps') S.ps = parsePollSummary(d.ps.rows, ps[1], { name: d.ps.name });
    if (ix && ix[0] === 'ix') S.ix = parseInteractions(d.ix.rows, ix[1], { name: d.ix.name });
    for (const l of d.lists || []) {  // rows are [poll, street, has phone]
      S.lists = { ...S.lists, [l.kind]: { kind: l.kind, name: l.name, people: l.rows.map(([poll, street, phone]) => ({ poll: pollKey(poll), street, phone: !!phone })) } };
    }
    S.builtIn = true;
    afterLoad();
  }
  function lock() {
    try { sessionStorage.removeItem(KEY_SLOT); } catch (e) { /* storage blocked */ }
    $('pw').value = '';
    $('gate').hidden = false;
    $('pw').focus();
  }
  async function unlockWith(key, remember) {
    applyBuiltIn(await openWith(key));
    if (remember) { try { sessionStorage.setItem(KEY_SLOT, b64(await crypto.subtle.exportKey('raw', key))); } catch (e) { /* storage blocked */ } }
    $('gate').hidden = true;
  }
  $('gateForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('unlock'), err = $('gateError');
    btn.disabled = true;
    btn.textContent = 'Unlocking…';
    err.hidden = true;
    try {
      await unlockWith(await deriveKey($('pw').value), true);
    } catch (x) {
      err.textContent = 'That password didn’t work. Check it and try again.';
      err.hidden = false;
      $('pw').select();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Unlock';
    }
  });
  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; $('dropzone').hidden = false; } });
  addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('dropzone').hidden = true; } });
  addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').hidden = true;
    loadFiles([...e.dataTransfer.files]);
  });

  // ------------------------------------------------------------------ overview
  function renderOverview() {
    const ps = S.ps, ix = S.ix, tv = S.turnout;
    const loaded = [ps && `poll summary${ps.asOf ? ` (${day(ps.asOf)})` : ''}`, ix && `canvass to ${day(ix.latest)}`, tv && '2024 voting lists'].filter(Boolean);
    $('loader').classList.toggle('done', loaded.length > 0);
    $('loaded').hidden = !loaded.length;
    $('loaded').textContent = loaded.length ? `Loaded: ${loaded.join(' · ')}` : '';
    $('chooseLabel').textContent = loaded.length ? 'Load newer files' : 'Choose files';
    $('chooseLabel').classList.toggle('primary', !loaded.length);
    $('clearData').hidden = !loaded.length;
    $('clearData').textContent = S.builtIn && ENC ? 'Lock' : 'Clear';

    const win = total.ndp + 1;
    let h = '';
    if (ps || tv) {
      h += '<h2>This election</h2>';
      if (ps) {
        const share = ps.totals.support / win;
        h += `<div class="goal" role="img" aria-label="${fmt(ps.totals.support)} supporters found, ${pct(share)} of ${fmt(win)}">
          <p class="hero"><b>${fmt(ps.totals.support)}</b> supporters found</p>
          <div class="track"><span class="fill" style="width:${Math.min(100, share * 100)}%"></span></div>
          <p><b>${pct(share)}</b> of the <b>${fmt(win)}</b> votes needed to win. The NDP won with ${fmt(total.ndp)} in 2024.</p></div>`;
      }
      h += '<div class="kpis">';
      if (ps) h += `<div class="kpi"><b>${pct(ps.totals.unknown)}</b><span>of voters not contacted yet</span></div>`;
      if (tv) h += `<div class="kpi"><b>${fmt(tv.not)}</b><span>supporters didn’t vote in 2024</span></div>`;
      h += '</div>';
      if (S.sites.length) h += `<div class="actions"><button type="button" class="btn primary" data-go="support">Map supporters</button>${tv ? '<button type="button" class="btn" data-go="skipped">Map 2024 non-voters</button>' : ''}</div>`;
    }
    $('canvass').innerHTML = h;

    const fd = sumWays(['Final voting']);
    const early = [['advance voting', ['Advance voting']], ['mail-in', ['Vote by mail']], ['special voting', ['Special voting']]]
      .map(([n, k]) => [n, sumWays(k)]).filter(([, t]) => t.ndp > t.con).map(([n, t]) => `${n} by ${fmt(t.ndp - t.con)}`);
    const list = early.length > 1 ? `${early.slice(0, -1).join(', ')} and ${early.at(-1)}` : early[0] || '';
    $('result2024').innerHTML = `<h2>2024 result</h2><p class="headline">NDP won by ${fmt(total.ndp - total.con)} votes</p>${partyBars(total, true)}
      ${fd.con > fd.ndp && list ? `<p class="note" style="margin-top:10px">Conservatives won election day by ${fmt(fd.con - fd.ndp)}; the NDP won ${list}.</p>` : ''}`;
  }
  $('canvass').addEventListener('click', e => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    S.view = b.dataset.go;
    S.shade = b.dataset.go === 'skipped' ? 'skipped' : S.ps ? 'support' : 'result';
    renderShade();
    restylePolls();
    updateHouses();
    selectTab('homes');
    if (phone()) setSheet(false);
  });

  // ------------------------------------------------------------------ polls table
  const COLS = [
    { k: 'code', label: 'Poll', get: r => r.sortCode, show: r => esc(r.label) },
    { k: 'lean', label: '2024', get: r => r.lean ?? -999, show: r => r.lean == null ? '—' : chip(r.lean), r: true },
    { k: 'reg', label: 'Voters', get: r => r.reg, show: r => fmt(r.reg), r: true, when: () => !S.ps },
    { k: 'support', label: 'Supporters', get: r => r.support, show: r => fmt(r.support), r: true, when: () => !!S.ps },
    { k: 'unknown', label: 'Not contacted', get: r => r.unknown, show: r => pct(r.unknown), r: true, when: () => !!S.ps },
    { k: 'skipped', label: 'Didn’t vote ’24', get: r => r.skipped, show: r => fmt(r.skipped), r: true, when: () => !!S.turnout },
  ];
  function pollRows() {
    const row = (key, label, sortCode, lean_, r, reg, onMap) => ({ key, label, sortCode, lean: lean_, reg, onMap,
      support: r?.support ?? 0, unknown: r?.unknown ?? 0, skipped: turnoutFor(key)?.not ?? 0 });
    const rows = polls.map(p => { const r = S.ps?.rows.get(p.key); return row(p.key, String(p.code), p.code, p.place ? lean(p.place.day) : null, r, r ? r.reg : p.reg2024, true); });
    if (S.ps) for (const r of S.ps.rows.values()) {
      if (r.onMap || !r.reg) continue;  // site-based polls (care homes, apartments) have no area on the map
      rows.push(row(r.key, r.key, parseInt(r.key, 10) + 0.5, null, r, r.reg, false));
    }
    return rows;
  }
  function renderPolls() {
    const cols = COLS.filter(c => !c.when || c.when());
    const sort = S.sort && cols.some(c => c.k === S.sort.k) ? S.sort : { k: 'code', dir: 1 };
    const col = cols.find(c => c.k === sort.k);
    const rows = pollRows().sort((a, b) => (col.get(a) - col.get(b)) * sort.dir || a.sortCode - b.sortCode);
    $('pollHead').innerHTML = cols.map(c => `<th class="${c.r ? 'r' : ''}" ${c.k === sort.k ? `aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}><button type="button" data-k="${c.k}">${c.label}</button></th>`).join('');
    $('pollBody').innerHTML = rows.map(r => `<tr class="${r.onMap ? 'go' : ''}${r.key === S.sel ? ' sel' : ''}" ${r.onMap ? 'tabindex="0"' : ''} data-key="${esc(r.key)}">${cols.map(c => `<td class="${c.r ? 'r' : ''}">${c.show(r)}</td>`).join('')}</tr>`).join('');
    const notes = ['<b>2024</b> is the result at the poll’s 2024 voting place.'];
    if (S.ps) notes.push('<b>Supporters</b> and <b>Not contacted</b> come from the Poll Summary.');
    if (S.turnout) notes.push('<b>Didn’t vote ’24</b> counts supporters on the 2024 didn’t-vote list.');
    notes.push('Click a column to sort, or a poll to see it on the map.');
    $('pollsNote').innerHTML = notes.join(' ');
  }
  $('pollHead').addEventListener('click', e => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    const k = b.dataset.k;
    S.sort = S.sort?.k === k ? { k, dir: -S.sort.dir } : { k, dir: k === 'code' ? 1 : -1 };
    renderPolls();
  });
  function goPoll(key) {
    const p = pollByKey.get(key);
    if (!p) return;
    selectPoll(key, true);
    map.once('moveend', () => openPoll(p, p.at));
    if (phone()) setSheet(false);
  }
  $('pollBody').addEventListener('click', e => { const tr = e.target.closest('tr.go'); if (tr) goPoll(tr.dataset.key); });
  $('pollBody').addEventListener('keydown', e => { const tr = e.target.closest('tr.go'); if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); goPoll(tr.dataset.key); } });

  // ------------------------------------------------------------------ households tab
  function renderViews() {
    const placed = S.sites.filter(s => s.p), v = viewOf();
    $('views').innerHTML = VIEWS.filter(x => has(x.needs)).map(x => `<button type="button" class="chip-btn" data-view="${x.k}" aria-pressed="${v.k === x.k}">${x.label} <span class="num">${fmt(placed.filter(x.test).length)}</span></button>`).join('');
    $('key').innerHTML = v.key.filter(([k]) => k !== 'ring' || S.sites.some(s => s.ls)).map(([k, label]) => `<span><i class="dot" style="${dot(k)}"></i>${label}</span>`).join('') +
      '<p>The number next to an address is how many people there. Faded dashed dots are outside the riding.</p>';
  }
  $('views').addEventListener('click', e => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    S.view = b.dataset.view;
    updateHouses();
  });
  function renderHomes() {
    const any = S.sites.length > 0;
    $('homesEmpty').hidden = any;
    $('homes').hidden = !any;
    if (!any) return;
    renderViews();
    $('addrs').innerHTML = S.sites.filter(s => s.p).map(s => `<option value="${esc(s.civic)}"></option>`).join('');
    const placed = S.sites.filter(s => s.p), out = placed.filter(s => s.out), missing = S.sites.filter(s => !s.p);
    const moved = placed.filter(s => !s.out && s.va && String(s.va) !== s.poll && !/S$/.test(s.poll) && s.poll !== '999'), approx = placed.filter(s => s.approx);
    const list = (arr, meta, go) => `<ul class="addr-list">${arr.map((s, i) => go
      ? `<li><button type="button" data-list="${go}" data-i="${i}">${esc(s.civic)} <span class="meta">${meta(s)}</span></button></li>`
      : `<li>${esc(s.civic)} <span class="meta">${meta(s)}</span></li>`).join('')}</ul>`;
    $('check').innerHTML = `<summary>Address check: ${fmt(placed.length - out.length)} in the riding, ${fmt(missing.length + out.length)} outside or not found</summary>
      <ul class="check-list">
        <li><b>${fmt(placed.length - out.length)}</b><span>addresses placed inside ${esc(P.riding)}${approx.length ? ` (${fmt(approx.length)} estimated from neighbouring house numbers)` : ''}</span></li>
        <li><b>${fmt(out.length)}</b><span>elsewhere in Surrey, outside the boundary</span></li>
        <li><b>${fmt(missing.length)}</b><span>not found: another city, or a street the address list doesn’t know</span></li>
        <li><b>${fmt(moved.length)}</b><span>with a poll number that differs from the official map</span></li></ul>
      ${out.length ? `<details><summary>Outside the boundary</summary>${list(out, s => `poll ${esc(s.poll)}`, 'out')}</details>` : ''}
      ${moved.length ? `<details><summary>Poll differs from the map</summary>${list(moved, s => `poll ${esc(s.poll)} → ${vaName(s.va)}`, 'moved')}</details>` : ''}
      ${missing.length ? `<details><summary>Not found</summary>${list(missing, s => `poll ${esc(s.poll)}`)}</details>` : ''}
      ${S.turnout?.unplaced ? `<p class="note">${fmt(S.turnout.unplaced)} people on the 2024 lists have no usable address (blank or “N/A”).</p>` : ''}`;
    S.checkLists = { out, moved };
  }
  $('check').addEventListener('click', e => { const b = e.target.closest('button[data-list]'); if (b) showHouse(S.checkLists[b.dataset.list][+b.dataset.i]); });
  function showHouse(s) {
    if (!s || !s.p) return;
    if (!s.shown) { S.view = 'all'; updateHouses(); }
    map.setView(s.p, 18, { animate: !reduced });
    s.marker.openPopup();
    if (phone()) setSheet(false);
  }
  $('find').addEventListener('change', e => {
    const q = e.target.value.trim().toLowerCase();
    if (!q || !S.sites.length) return;
    const sites = S.sites.filter(s => s.p);
    showHouse(sites.find(s => s.civic.toLowerCase() === q) || sites.find(s => s.civic.toLowerCase().startsWith(q)) || sites.find(s => s.civic.toLowerCase().includes(q)));
  });
  $('downloadCsv').addEventListener('click', () => {
    const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
    const rows = [['address', 'units', 'poll', 'supporters', 'other parties', 'undecided', 'do not contact', 'did not vote in 2024', 'with a phone',
      'lawn signs', 'last contact', 'location', 'lat', 'lon']];
    S.sites.filter(s => s.shown).forEach(s => rows.push([s.civic, [...new Set([...s.units.keys(), ...s.vUnits.keys()])].filter(Boolean).join(' '),
      s.va || s.poll, sumOf(s, SUPPORT), sumOf(s, OPPOSE), s.n.und || 0, s.n.dnc || 0, s.notVoted, s.phoneNV, s.ls, s.last,
      s.approx ? 'estimated' : 'address point', s.p[0].toFixed(5), s.p[1].toFixed(5)]));
    const url = URL.createObjectURL(new Blob([rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${P.code.toLowerCase()}-${viewOf().k}-households.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // ------------------------------------------------------------------ tabs and phone sheet
  const TABS = ['overview', 'polls', 'homes'];
  function selectTab(name) {
    TABS.forEach(t => {
      const tab = $('tab-' + t), sel = t === name;
      tab.setAttribute('aria-selected', sel);
      tab.tabIndex = sel ? 0 : -1;
      $('pane-' + t).hidden = !sel;
    });
    $('panelBody').scrollTop = 0;
  }
  document.querySelector('.tabs').addEventListener('click', e => { const t = e.target.closest('[role="tab"]'); if (t) selectTab(t.id.slice(4)); });
  document.querySelector('.tabs').addEventListener('keydown', e => {
    const i = TABS.indexOf(document.activeElement.id.slice(4));
    if (i < 0 || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    selectTab(next);
    $('tab-' + next).focus();
  });
  const sheetBtn = $('sheetToggle');
  function setSheet(open) {
    app.classList.toggle('collapsed', !open);
    sheetBtn.textContent = open ? 'Hide' : 'Show';
    sheetBtn.setAttribute('aria-expanded', open);
  }
  sheetBtn.addEventListener('click', () => setSheet(app.classList.contains('collapsed')));

  // ------------------------------------------------------------------ theme
  function applyTheme() {
    const z = map.getZoom(), k = z < 13.5 ? 0.55 : z < 15 ? 0.8 : z < 16.5 ? 1 : z < 18 ? 1.5 : 2.2;
    roadLayers.forEach(({ cls, layer }) => layer.setStyle({ color: tok(MAJOR.has(cls) ? 'road-major' : 'road'), weight: (WIDTH[cls] || 1) * k }));
    mask.setStyle({ fillColor: tok('mask') });
    outline.setStyle({ color: tok('edge') });
    restylePolls();
    if (S.sites.length) { const c = tokens(); S.sites.forEach(s => { if (s.shown) styleHouse(s, c); }); }
  }
  map.on('zoomend', applyTheme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function renderAll() {
    renderShade();
    renderOverview();
    renderPolls();
    renderHomes();
    restylePolls();
    refreshLabels();
  }

  $('eyebrow').textContent = `${P.riding} · ${P.code}`;
  map.fitBounds(L.polygon(P.outline).getBounds(), { padding: [12, 12] });
  if (phone()) setSheet(false);
  renderAll();
  applyTheme();
  if (ENC) {
    let saved = null;
    try { saved = sessionStorage.getItem(KEY_SLOT); } catch (e) { /* storage blocked */ }
    if (saved) {
      crypto.subtle.importKey('raw', unb64(saved), { name: 'AES-GCM' }, true, ['decrypt'])
        .then(key => unlockWith(key, false)).catch(lock);
    } else lock();
  }
})();
