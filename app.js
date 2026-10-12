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
  const leanText = l => Math.abs(l) < 0.5 ? 'Even' : (l > 0 ? 'C+' : 'N+') + Math.abs(l).toFixed(Math.abs(l) < 10 ? 1 : 0);
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
  const S = { ps: null, ix: null, shade: 'result', sel: null, sort: null };

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
    { k: 'support', label: 'Supporters ID’d', ps: true },
    { k: 'unknown', label: 'Not yet contacted', ps: true },
    { k: 'find', label: 'Where to canvass', ps: true },
    { k: 'none', label: 'Plain' },
  ];
  const STEPS = {
    support: { color: 'con', breaks: [0.02, 0.05, 0.10, 0.20, 0.35], alpha: [0.06, 0.16, 0.28, 0.42, 0.56, 0.70], get: r => r.supportPct, label: v => pct(v) },
    unknown: { color: 'ramp-contact', breaks: [0.5, 0.7, 0.85, 0.95], alpha: [0.08, 0.2, 0.34, 0.5, 0.66], get: r => r.unknown, label: v => pct(v), quantile: 0.01 },
    find: { color: 'ramp-find', breaks: [25, 50, 100, 200], alpha: [0.08, 0.2, 0.34, 0.5, 0.66], get: r => r.find, label: v => fmt(v), quantile: 10 },
  };
  function setBreaks() {  // quintiles of the loaded polls, rounded, so each class holds about a fifth of the map
    if (!S.ps) return;
    for (const st of Object.values(STEPS)) {
      if (!st.quantile) continue;
      const vals = polls.map(p => S.ps.rows.get(p.key)).filter(Boolean).map(st.get).sort((a, b) => a - b);
      if (vals.length < 5) continue;
      const q = [0.2, 0.4, 0.6, 0.8].map(f => Math.round(vals[Math.floor(f * (vals.length - 1))] / st.quantile) * st.quantile);
      st.breaks = q.filter((v, i) => i === 0 || v > q[i - 1]);
      st.alpha = [0.08, 0.2, 0.34, 0.5, 0.66].slice(5 - st.breaks.length - 1);
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
    const st = STEPS[S.shade], r = S.ps && S.ps.rows.get(p.key);
    if (!st || !r) return null;
    return { color: st.color, alpha: st.alpha[classOf(st.get(r), st.breaks)] };
  }
  const tok = n => getComputedStyle(app).getPropertyValue('--' + n).trim();
  function stylePoll(p) {
    const s = shadeOf(p), selected = S.sel === p.key;
    p.layer.setStyle({ color: selected ? tok('fg') : tok('va'), weight: selected ? 3 : 1, dashArray: selected ? null : '4 3',
      fillColor: s ? tok(s.color) : 'transparent', fillOpacity: s ? s.alpha : 0 });
  }
  const restylePolls = () => polls.forEach(stylePoll);

  function renderShade() {
    $('shade').innerHTML = SHADES.map(s => `<button type="button" role="radio" data-k="${s.k}" aria-checked="${S.shade === s.k}" ${s.ps && !S.ps ? 'disabled title="Load the Poll Summary first"' : ''}>${s.label}</button>`).join('');
    const lg = $('legend');
    if (S.shade === 'result') {
      const labels = ['N 10+', 'N 5–10', 'N 2–5', '±2', 'C 2–5', 'C 5–10', 'C 10+'];
      lg.innerHTML = `<h3>2024 election-day margin at each poll’s voting place</h3>
        <div class="scale">${RESULT_STEPS.map(([, , c, a]) => `<span style="background:color-mix(in srgb, var(--${c}) ${a * 100}%, var(--land))"></span>`).join('')}</div>
        <div class="scale-labels">${labels.map(t => `<span>${t}</span>`).join('')}</div>
        <p>Polls that voted at the same place share its result. Advance and mail ballots were counted by location, not by poll.</p>`;
    } else if (STEPS[S.shade] && S.ps) {
      const st = STEPS[S.shade];
      const edges = ['<' + st.label(st.breaks[0]), ...st.breaks.slice(0, -1).map((b, i) => `${st.label(b)}–${st.label(st.breaks[i + 1])}`), st.label(st.breaks.at(-1)) + '+'];
      const title = { support: 'Supporters identified, share of voters', unknown: 'Voters with no support answer yet', find: 'Likely supporters still to find' }[S.shade];
      const note = { support: 'From the Poll Summary’s current support percentage.', unknown: 'From the Poll Summary’s current unknown percentage.',
        find: 'Estimate: registered voters × share not yet contacted × the Conservative share of 2024 election-day votes at the poll’s voting place.' }[S.shade];
      lg.innerHTML = `<h3>${title}</h3><div class="scale">${st.alpha.map(a => `<span style="background:color-mix(in srgb, var(--${st.color}) ${a * 100}%, var(--land))"></span>`).join('')}</div>
        <div class="scale-labels">${edges.map(t => `<span>${t}</span>`).join('')}</div><p>${note}</p>`;
    } else lg.innerHTML = '';
  }
  $('shade').addEventListener('click', e => {
    const b = e.target.closest('button[data-k]');
    if (!b || b.disabled) return;
    S.shade = b.dataset.k;
    renderShade();
    restylePolls();
  });

  // ------------------------------------------------------------------ poll tooltip and card
  function pollTip(p) {
    const r = S.ps && S.ps.rows.get(p.key);
    const parts = [`<b>Poll ${p.code}</b>`];
    if (p.place) parts.push(`2024 ${leanText(lean(p.place.day))}`);
    if (r) parts.push(`${fmt(r.support)} supporters (${pct(r.supportPct)})`, `${pct(r.unknown)} not contacted`);
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
    const r = S.ps && S.ps.rows.get(p.key), pl = p.place;
    let h = `<div class="pop"><h3>Poll ${p.code}</h3><p class="meta">${vaName(p.code)} · ${fmt(r ? r.reg : p.reg2024)} registered voters${r ? '' : ' (2024 list)'}</p>`;
    if (pl) {
      h += `<h4>2024 election day · ${chip(lean(pl.day))}</h4><p class="meta">${esc(pl.name)}: polls ${runs(pl.polls)} voted here, ${fmt(valid(pl.day))} votes</p>${partyBars(pl.day)}`;
    }
    if (r) {
      h += `<h4>2026 canvass</h4><div class="grid">
        <div><b>${fmt(r.support)}</b><span>supporters ID’d (${pct(r.supportPct, 1)})</span></div>
        <div><b>${pct(r.unknown)}</b><span>not yet contacted</span></div>
        <div><b>${fmt(r.hh)}</b><span>households</span></div>
        <div><b>${fmt(r.find)}</b><span>likely supporters to find</span></div></div>`;
      if (r.streets.length) h += `<details><summary>${r.streets.length} streets</summary><div class="streets">${r.streets.map(s => `<span>${esc(s.name)} <span class="num">${s.n}</span></span>`).join('')}</div></details>`;
    }
    if (S.ix) {
      const here = S.ix.sites.filter(s => s.va === p.code && s.shown);
      const counts = {};
      here.forEach(s => { counts[s.show] = (counts[s.show] || 0) + 1; });
      const rows = LAYERS.filter(l => counts[l.k]).map(l => `<li><i class="dot" style="${dotStyle(l)}"></i><span>${l.label}</span><b class="num">${counts[l.k]}</b></li>`).join('');
      if (rows) h += `<h4>Households shown here</h4><ul class="counts">${rows}</ul>`;
    }
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
    if (!S.ix || z < 16) return;
    const fits = z >= 19 ? () => true : placer();
    const shown = S.ix.sites.filter(s => s.shown && view.contains(s.p));
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

  // ------------------------------------------------------------------ households (Interactions export)
  const CATEGORY = { 'Conservative': 'con', 'Conservative-Leaning': 'lean', 'NDP': 'ndp', 'NDP-Leaning': 'ndp_lean', 'Green': 'grn',
    'Independent': 'oth', 'Other': 'oth', 'Undecided': 'und', 'Will Not Say': 'und', 'Unknown': 'und', 'Do Not Contact': 'dnc' };
  const LAYERS = [  // order is display priority when an address has several answers
    { k: 'con', label: 'Conservative', group: 'support', color: 'con', style: 'fill' },
    { k: 'lean', label: 'Leaning Conservative', group: 'support', color: 'con', style: 'hollow' },
    { k: 'ndp', label: 'NDP', group: 'oppose', color: 'ndp', style: 'fill' },
    { k: 'ndp_lean', label: 'Leaning NDP', group: 'oppose', color: 'ndp', style: 'hollow' },
    { k: 'grn', label: 'Green', group: 'oppose', color: 'grn', style: 'fill' },
    { k: 'oth', label: 'Other or Independent', group: 'oppose', color: 'oth', style: 'fill' },
    { k: 'dnc', label: 'Do not contact', group: 'other', color: 'dnc', style: 'dash' },
    { k: 'und', label: 'Undecided or won’t say', group: 'other', color: 'und', style: 'fill' },
  ];
  const LAYER = Object.fromEntries(LAYERS.map(l => [l.k, l]));
  const PRESETS = { support: ['con', 'lean'], oppose: ['ndp', 'ndp_lean', 'grn', 'oth'], all: LAYERS.map(l => l.k) };
  const on = new Set(PRESETS.support);
  const dotStyle = l => l.style === 'fill' ? `background:var(--${l.color})` : `border:2px ${l.style === 'dash' ? 'dashed' : 'solid'} var(--${l.color})`;
  const countFor = s => s.show ? LAYERS.filter(l => LAYER[s.show].group === l.group).reduce((t, l) => t + (s.n[l.k] || 0), 0) : 0;
  const radius = s => 4.5 + Math.min(5, Math.sqrt(Math.max(1, countFor(s))) - 1);

  const ABBR = { AVENUE: 'AVE', STREET: 'ST', ROAD: 'RD', DRIVE: 'DR', BOULEVARD: 'BLVD', CRESCENT: 'CRES', PLACE: 'PL', COURT: 'CRT',
    HIGHWAY: 'HWY', PARKWAY: 'PKY', LANE: 'LANE', TERRACE: 'TERR', WAY: 'WAY', CIRCLE: 'CIR', GATE: 'GATE', EAST: 'E', WEST: 'W' };
  const ALIAS = { 'KING GEORGE HWY': 'KING GEORGE BLVD' };
  const normStreet = st => { st = st.toUpperCase().replace(/\s+/g, ' ').trim().split(' ').map(w => ABBR[w] || w).join(' '); return ALIAS[st] || st; };
  const siteKey = civic => { const m = /^(\d+)\s+(.+)$/.exec(civic.trim()); return m ? `${m[1]} ${normStreet(m[2])}` : civic.toUpperCase(); };
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
    if (!S.ix) return;
    S.ix.sites.forEach(s => {
      if (!s.p) return;
      s.marker = L.circleMarker(s.p, { renderer: dataCanvas, pane: 'data', radius: 5 }).bindPopup(() => houseCard(s), { maxWidth: 320, autoPanPaddingTopLeft: [24, 72], autoPanPaddingBottomRight: [24, 24] });
      if (s.ls) s.ring = L.circleMarker(s.p, { renderer: dataCanvas, pane: 'data', radius: 8, fill: false, interactive: false });
    });
    updateHouses();
  }
  function updateHouses() {
    if (!S.ix) return;
    houseLayer.clearLayers();
    const c = tokens();
    for (const s of S.ix.sites) {
      s.show = LAYERS.find(l => on.has(l.k) && s.n[l.k])?.k || null;
      s.shown = !!(s.show && s.p);
      if (!s.shown) continue;
      styleHouse(s, c);
      if (s.ring) houseLayer.addLayer(s.ring);
      houseLayer.addLayer(s.marker);
    }
    renderLayers();
    refreshLabels();
  }
  function styleHouse(s, c) {
    const l = LAYER[s.show], r = radius(s);
    const base = l.style === 'fill' ? { fillColor: c[l.color], fillOpacity: 1, color: c.halo, weight: 1.6, dashArray: null }
      : { fillColor: c.surface, fillOpacity: 1, color: c[l.color], weight: 2.4, dashArray: l.style === 'dash' ? '2 2' : null };
    if (s.out) Object.assign(base, { fillOpacity: l.style === 'fill' ? 0.35 : 1, dashArray: '3 2', color: c[l.color] });
    s.marker.setStyle(base).setRadius(r);
    if (s.ring) s.ring.setStyle({ color: c.sign, weight: 2.4 }).setRadius(r + 3.5);
  }
  const tokens = () => Object.fromEntries(['fg', 'halo', 'surface', 'sign', 'va', 'con', 'ndp', 'grn', 'oth', 'und', 'dnc'].map(k => [k, tok(k)]));

  function houseCard(s) {
    const rows = LAYERS.filter(l => s.n[l.k]).map(l => `<li><i class="dot" style="${dotStyle(l)}"></i><span>${l.label}</span><b class="num">${s.n[l.k]}</b></li>`).join('');
    const units = [...s.units.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const unitHtml = units.length ? `<p class="meta units">Units: ${units.slice(0, 48).map(u => {
      const k = LAYERS.find(l => s.units.get(u)[l.k])?.k;
      return `<span>${k ? `<i class="dot" style="display:inline-block;width:7px;height:7px;margin-right:3px;${dotStyle(LAYER[k])}"></i>` : ''}${esc(u)}</span>`;
    }).join('')}${units.length > 48 ? ` +${units.length - 48} more` : ''}</p>` : '';
    const flags = [];
    if (s.ls) flags.push(`<p class="flag sign">Lawn sign requested${s.ls > 1 ? ` (${s.ls} voters)` : ''}</p>`);
    if (s.out) flags.push(`<p class="flag">Outside the ${esc(P.riding)} boundary.</p>`);
    else if (s.va && String(s.va) !== s.poll && !/S$/.test(s.poll)) flags.push(`<p class="flag">The export says poll ${esc(s.poll)}; the riding map puts this address in ${vaName(s.va)}.</p>`);
    if (s.approx) flags.push('<p class="flag">Placed between neighbouring house numbers; the exact spot may be a few doors off.</p>');
    return `<div class="pop"><h3>${esc(s.civic)}</h3><p class="meta">Poll ${esc(s.poll)}${s.va ? ` · ${vaName(s.va)}` : ''} · last contact ${day(s.last)}</p><ul class="counts">${rows}</ul>${unitHtml}${flags.join('')}</div>`;
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
      if (!s) sites.set(k, s = { civic, polls: {}, n: {}, units: new Map(), ls: 0, last: '' });
      s.polls[v.poll] = (s.polls[v.poll] || 0) + 1;
      if (cat) s.n[cat] = (s.n[cat] || 0) + 1;
      if (!s.units.has(unit)) s.units.set(unit, {});
      if (cat) s.units.get(unit)[cat] = (s.units.get(unit)[cat] || 0) + 1;
      s.ls += v.lawnsign ? 1 : 0;
      if (v.last > s.last) s.last = v.last;
    }
    const list = [...sites.values()].filter(s => Object.keys(s.n).length);
    for (const s of list) {
      s.poll = Object.entries(s.polls).sort((a, b) => b[1] - a[1])[0][0];
      const hit = locate(s.civic);
      if (hit) {
        s.p = hit.p; s.approx = hit.approx;
        s.out = !inside(s.p, P.outline);
        s.va = s.out ? null : polls.find(p => inside(s.p, p.rings))?.code ?? null;
      }
    }
    return { name: file.name, count, latest, voters: voters.size, sites: list };
  }

  async function loadFiles(files) {
    const errors = [];
    for (const f of files) {
      try {
        const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null, blankrows: false });
        const [kind, head] = sniff(rows);
        if (kind === 'ps') S.ps = parsePollSummary(rows, head, f);
        else if (kind === 'ix') { S.ix = parseInteractions(rows, head, f); buildHouses(); }
        else errors.push(`${f.name} isn’t a Poll Summary or Interactions export. The Poll Summary starts with a “Poll, City, Reg Voters” header row; the Interactions export has a “Date, Voter, Poll, Address” table.`);
      } catch (e) {
        errors.push(`${f.name} couldn’t be read: ${e.message}`);
      }
    }
    $('loadError').hidden = !errors.length;
    $('loadError').textContent = errors.join(' ');
    setBreaks();
    if (S.ps && !S.sortTouched) S.sort = { k: 'find', dir: -1 };
    renderAll();
    if (S.ix && !S.ps) selectTab('homes');
  }
  $('files').addEventListener('change', e => { loadFiles([...e.target.files]); e.target.value = ''; });
  $('clearData').addEventListener('click', () => {
    S.ps = null; S.ix = null; S.sort = null;
    houseLayer.clearLayers();
    if (STEPS[S.shade]) S.shade = 'result';
    map.closePopup();
    renderAll();
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
    const ps = S.ps, ix = S.ix;
    $('loader').classList.toggle('done', !!(ps && ix));
    $('filestate').innerHTML = [
      ['Poll Summary', ps && `${ps.rows.size} polls${ps.asOf ? ` · ${day(ps.asOf)}` : ''}`],
      ['Interactions', ix && `${fmt(ix.count)} interactions through ${day(ix.latest)}`],
    ].map(([what, st]) => `<li class="${st ? 'ok' : ''}"><i class="mark"></i><span class="what">${what}</span><span class="state">${st || 'Not loaded'}</span></li>`).join('');
    $('clearData').hidden = !(ps || ix);

    const win = total.ndp + 1;
    let h = '';
    if (ps) {
      const t = ps.totals, share = t.support / win;
      h = `<h2>2026 canvass</h2>
        <div class="goal" role="img" aria-label="${fmt(t.support)} supporters identified, ${pct(share)} of ${fmt(win)}">
          <p class="hero"><b>${fmt(t.support)}</b> supporters identified</p>
          <div class="track"><span class="fill" style="width:${Math.min(100, share * 100)}%"></span><span class="tick" style="left:${(total.con / win) * 100}%" title="2024 Conservative total"></span></div>
          <p><b>${pct(share)}</b> of the <b>${fmt(win)}</b> votes it takes to beat the 2024 NDP total. The tick marks the ${fmt(total.con)} Conservative votes in 2024.</p>
        </div>
        <div class="kpis" style="margin-top:14px">
          <div class="kpi"><b>${pct(t.unknown)}</b><span>of voters not yet contacted</span></div>
          <div class="kpi"><b>${fmt(t.reg)}</b><span>registered voters</span></div>
          <div class="kpi"><b>${fmt(t.hh)}</b><span>households</span></div>
          <div class="kpi"><b>${fmt(t.phones)}</b><span>phone numbers</span></div>
        </div>`;
    }
    if (ix) {
      const n = k => ix.sites.filter(s => s.n[k]).length;
      const supp = ix.sites.filter(s => s.n.con || s.n.lean).length, opp = ix.sites.filter(s => PRESETS.oppose.some(k => s.n[k])).length;
      h += `<p class="note" style="margin-top:${ps ? 12 : 0}px">Households on the map: <b>${fmt(supp)}</b> supporting, <b>${fmt(opp)}</b> with other-party voters, <b>${fmt(n('und'))}</b> undecided. See the Households tab.</p>`;
    }
    $('canvass').innerHTML = h;

    const margin = total.ndp - total.con;
    $('result2024').innerHTML = `<h2>2024 result <span class="aside">· all ${fmt(valid(total))} valid votes</span></h2>
      <p class="headline">NDP won by ${fmt(margin)} votes</p>${partyBars(total, true)}`;

    const WAYS = [['Election day', ['Final voting']], ['Advance', ['Advance voting']], ['Mail', ['Vote by mail']],
      ['Special (care homes, hospitals)', ['Special voting']], ['Out of district', ['Advance voting - out-of-district', 'Final voting - out-of-district']],
      ['District office', ['DEO office voting']], ['Phone', ['Assisted telephone voting']]];
    const ways = WAYS.map(([label, keys]) => ({ label, t: sumWays(keys) })).filter(w => valid(w.t));
    const conWon = ways.filter(w => w.t.con > w.t.ndp).map(w => w.label.toLowerCase().replace(/ \(.*/, ''));
    $('ways').innerHTML = `<h2>How the 2024 votes came in</h2>
      <p class="note" style="margin-bottom:8px">Conservatives led ${conWon.length ? conWon.join(' and ') : 'no voting type'}; the NDP made up the difference in advance, mail and special voting.</p>
      <div class="table-wrap"><table><thead><tr><th>Voting</th><th class="r">Votes</th><th class="r">NDP</th><th class="r">Con</th><th class="r">Margin</th></tr></thead>
      <tbody>${ways.map(w => `<tr><td>${w.label}</td><td class="r">${fmt(valid(w.t))}</td><td class="r">${fmt(w.t.ndp)}</td><td class="r">${fmt(w.t.con)}</td><td class="r">${chip(lean(w.t))}</td></tr>`).join('')}</tbody></table></div>`;

    const idsAt = pl => ps ? pl.polls.reduce((t, c) => t + (ps.rows.get(String(c))?.support || 0), 0) : null;
    $('places').innerHTML = `<h2>Election-day voting places</h2>
      <div class="table-wrap"><table><thead><tr><th>Place</th><th class="r">Votes</th><th class="r">Margin</th>${ps ? '<th class="r" title="Supporters identified in its polls vs. 2024 Conservative election-day votes there">IDs / 2024 Con</th>' : ''}</tr></thead>
      <tbody>${places.map((pl, i) => `<tr class="go" tabindex="0" data-place="${i}"><td class="place-name">${esc(pl.name)}<small>Polls ${runs(pl.polls)}</small></td>
        <td class="r">${fmt(valid(pl.day))}</td><td class="r">${chip(lean(pl.day))}</td>${ps ? `<td class="r">${fmt(idsAt(pl))} / ${fmt(pl.day.con)}</td>` : ''}</tr>`).join('')}</tbody></table></div>
      <p class="note" style="margin-top:6px">Select a place to zoom to its polls.</p>`;
  }
  function goPlace(i) {
    const pl = places[i];
    const b = L.latLngBounds([]);
    pl.polls.forEach(c => b.extend(pollByKey.get(String(c)).layer.getBounds()));
    if (S.shade !== 'result') { S.shade = 'result'; renderShade(); restylePolls(); }
    map.fitBounds(b, { padding: [30, 30], animate: !reduced });
    if (phone()) setSheet(false);
  }
  $('places').addEventListener('click', e => { const tr = e.target.closest('tr[data-place]'); if (tr) goPlace(+tr.dataset.place); });
  $('places').addEventListener('keydown', e => { const tr = e.target.closest('tr[data-place]'); if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); goPlace(+tr.dataset.place); } });

  // ------------------------------------------------------------------ polls table
  const COLS = [
    { k: 'code', label: 'Poll', get: r => r.sortCode, show: r => esc(r.label) },
    { k: 'lean', label: '2024', get: r => r.lean ?? -999, show: r => r.lean == null ? '—' : chip(r.lean), r: true },
    { k: 'reg', label: 'Voters', get: r => r.reg, show: r => fmt(r.reg), r: true },
    { k: 'support', label: 'Supp.', get: r => r.support, show: r => fmt(r.support), r: true, ps: true },
    { k: 'supportPct', label: 'ID %', get: r => r.supportPct, show: r => pct(r.supportPct), r: true, ps: true },
    { k: 'unknown', label: 'Unknown', get: r => r.unknown, show: r => pct(r.unknown), r: true, ps: true },
    { k: 'find', label: 'To find', get: r => r.find, show: (r, max) => `<span class="minibar"><span style="width:${(r.find / max) * 100}%"></span></span>${fmt(r.find)}`, r: true, ps: true },
  ];
  function pollRows() {
    const rows = polls.map(p => {
      const r = S.ps?.rows.get(p.key);
      return { key: p.key, label: String(p.code), sortCode: p.code, lean: p.place ? lean(p.place.day) : null, reg: r ? r.reg : p.reg2024,
        support: r?.support ?? 0, supportPct: r?.supportPct ?? 0, unknown: r?.unknown ?? 0, find: r?.find ?? 0, onMap: true };
    });
    if (S.ps) for (const r of S.ps.rows.values()) {
      if (r.onMap || !r.reg) continue;  // site-based polls (care homes, apartments) have no area on the map
      rows.push({ key: r.key, label: r.key, sortCode: parseInt(r.key, 10) + 0.5, lean: null, reg: r.reg, support: r.support,
        supportPct: r.supportPct, unknown: r.unknown, find: r.find, onMap: false });
    }
    return rows;
  }
  function renderPolls() {
    const cols = COLS.filter(c => !c.ps || S.ps);
    const sort = S.sort && cols.some(c => c.k === S.sort.k) ? S.sort : { k: 'code', dir: 1 };
    const col = cols.find(c => c.k === sort.k);
    const rows = pollRows().sort((a, b) => (col.get(a) - col.get(b)) * sort.dir || a.sortCode - b.sortCode);
    const max = Math.max(1, ...rows.map(r => r.find));
    $('pollHead').innerHTML = cols.map(c => `<th class="${c.r ? 'r' : ''}" ${c.k === sort.k ? `aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}><button type="button" data-k="${c.k}">${c.label}</button></th>`).join('');
    $('pollBody').innerHTML = rows.map(r => `<tr class="${r.onMap ? 'go' : ''}${r.key === S.sel ? ' sel' : ''}" ${r.onMap ? 'tabindex="0"' : ''} data-key="${esc(r.key)}">${cols.map(c => `<td class="${c.r ? 'r' : ''}">${c.show(r, max)}</td>`).join('')}</tr>`).join('');
    $('pollsNote').innerHTML = S.ps
      ? `<b>To find</b> estimates supporters not yet identified: registered voters × share not yet contacted × the Conservative share of 2024 election-day votes at the poll’s voting place. Select a poll to see it on the map.`
      : `Load the Poll Summary to add supporters identified, contact rates and a canvass priority for every poll. Voters are the 2024 registered counts until then.`;
  }
  $('pollHead').addEventListener('click', e => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    const k = b.dataset.k;
    S.sort = S.sort?.k === k ? { k, dir: -S.sort.dir } : { k, dir: k === 'code' ? 1 : -1 };
    S.sortTouched = true;
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
  function renderLayers() {
    const ix = S.ix;
    $('homesEmpty').hidden = !!ix;
    $('homes').hidden = !ix;
    if (!ix) return;
    const count = k => ix.sites.filter(s => s.p && s.n[k]).length;
    $('layers').innerHTML = LAYERS.map(l => `<label class="toggle" for="show-${l.k}"><input type="checkbox" id="show-${l.k}" data-k="${l.k}" ${on.has(l.k) ? 'checked' : ''}>
      <span class="sw ${l.style === 'fill' ? '' : l.style === 'dash' ? 'dash' : 'hollow'}" style="border-color:var(--${l.color});background:var(--${l.color})"></span>
      <span class="name">${l.label}</span><span class="count">${fmt(count(l.k))}</span></label>`).join('') +
      (ix.sites.some(s => s.ls) ? '<div class="key"><span class="sw ring" style="border-color:var(--sign)"></span><span>Ring: lawn sign requested</span></div>' : '') +
      '<div class="key"><span class="sw dash" style="border-color:var(--muted)"></span><span>Dashed: outside the riding</span></div>';
    document.querySelectorAll('.presets [data-preset]').forEach(b => {
      const set = PRESETS[b.dataset.preset];
      b.setAttribute('aria-pressed', set.length === on.size && set.every(k => on.has(k)));
    });
  }
  $('layers').addEventListener('change', e => {
    const k = e.target.dataset.k;
    if (!k) return;
    if (e.target.checked) on.add(k); else on.delete(k);
    updateHouses();
  });
  document.querySelector('.presets').addEventListener('click', e => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    on.clear();
    PRESETS[b.dataset.preset].forEach(k => on.add(k));
    updateHouses();
  });

  function renderHomes() {
    const ix = S.ix;
    if (!ix) { renderLayers(); return; }
    renderLayers();
    $('addrs').innerHTML = ix.sites.filter(s => s.p).map(s => `<option value="${esc(s.civic)}"></option>`).join('');
    const placed = ix.sites.filter(s => s.p), out = placed.filter(s => s.out), missing = ix.sites.filter(s => !s.p);
    const moved = placed.filter(s => !s.out && s.va && String(s.va) !== s.poll && !/S$/.test(s.poll)), approx = placed.filter(s => s.approx);
    const list = (arr, meta, go) => `<ul class="addr-list">${arr.map((s, i) => go
      ? `<li><button type="button" data-list="${go}" data-i="${i}">${esc(s.civic)} <span class="meta">${meta(s)}</span></button></li>`
      : `<li>${esc(s.civic)} <span class="meta">${meta(s)}</span></li>`).join('')}</ul>`;
    const answers = s => LAYERS.filter(l => s.n[l.k]).map(l => `${s.n[l.k]} ${l.label.toLowerCase()}`).join(', ');
    $('check').className = 'check';
    $('check').innerHTML = `<h2>Checked against the riding map</h2><ul>
      <li><b>${fmt(placed.length - out.length)}</b><span>addresses inside ${esc(P.riding)}</span></li>
      <li><b>${fmt(out.length)}</b><span>elsewhere in Surrey, outside the boundary</span></li>
      <li><b>${fmt(missing.length)}</b><span>not placed: outside the riding area, or a street the address list doesn’t know</span></li>
      <li><b>${fmt(moved.length)}</b><span>with a poll number that differs from the map</span></li>
      <li><b>${fmt(approx.length)}</b><span>placed between neighbouring house numbers</span></li></ul>
      ${out.length ? `<details><summary>Outside the boundary</summary>${list(out, s => `poll ${esc(s.poll)}`, 'out')}</details>` : ''}
      ${moved.length ? `<details><summary>Poll differs from the map</summary>${list(moved, s => `poll ${esc(s.poll)} → ${vaName(s.va)}`, 'moved')}</details>` : ''}
      ${missing.length ? `<details><summary>Not placed on the map</summary>${list(missing, s => `poll ${esc(s.poll)} · ${answers(s)}`)}</details>` : ''}`;
    S.lists = { out, moved };
  }
  $('check').addEventListener('click', e => { const b = e.target.closest('button[data-list]'); if (b) showHouse(S.lists[b.dataset.list][+b.dataset.i]); });
  function showHouse(s) {
    if (!s || !s.p) return;
    if (!s.shown) { LAYERS.filter(l => s.n[l.k]).forEach(l => on.add(l.k)); updateHouses(); }
    map.setView(s.p, 18, { animate: !reduced });
    s.marker.openPopup();
    if (phone()) setSheet(false);
  }
  $('find').addEventListener('change', e => {
    const q = e.target.value.trim().toLowerCase();
    if (!q || !S.ix) return;
    const sites = S.ix.sites.filter(s => s.p);
    showHouse(sites.find(s => s.civic.toLowerCase() === q) || sites.find(s => s.civic.toLowerCase().startsWith(q)) || sites.find(s => s.civic.toLowerCase().includes(q)));
  });
  $('downloadCsv').addEventListener('click', () => {
    const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
    const rows = [['address', 'units', 'poll (export)', 'voting area (map)', 'riding', 'shown as', ...LAYERS.map(l => l.label), 'lawn signs', 'last contact', 'placement', 'lat', 'lon']];
    S.ix.sites.filter(s => s.shown).forEach(s => rows.push([s.civic, [...s.units.keys()].filter(Boolean).join(' '), s.poll, s.va || '', s.out ? 'outside' : 'inside',
      LAYER[s.show].label, ...LAYERS.map(l => s.n[l.k] || 0), s.ls, s.last, s.approx ? 'between neighbours' : 'address point', s.p[0].toFixed(5), s.p[1].toFixed(5)]));
    const url = URL.createObjectURL(new Blob([rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${P.code.toLowerCase()}-households.csv` });
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
    if (S.ix) { const c = tokens(); S.ix.sites.forEach(s => { if (s.shown) styleHouse(s, c); }); }
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
})();
