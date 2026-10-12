'use strict';
// Poll map: every poll with its supporters now (the Poll Summary's current support) and its supporters on the 2024 lists,
// what that comparison says, how much of the poll hasn't answered yet, the 2024 result and the GOTV ride plan.
// Each layer switches on and off on its own; the poll colouring is one choice at a time.
(() => {
  const { P, $, fmt, pct, esc, day, reduced, phone, tok, lean, chip, RESULT_STEPS, RESULT_LABELS, classOf, runs, polls, pollByKey,
    partyBars, locate, pollAt, listAddress, sniff, pollKey, parsePollSummary, parseList, listKind, NO_POLL, listFromRows, readWorkbook,
    ENC, gate, baseMap, placer, sheet } = SCC;
  const app = $('app');

  const S = { ps: null, lists: null, plan: null, t: null, rows: new Map(), extra: [], fill: 'now',
    on: new Set(['numbers', 'counts', 'plan', 'streets']), sel: null, sort: null, builtIn: false };

  // ------------------------------------------------------------------ map
  const { map, streetLabels, placeMarkers, styleBase, onTheme } = baseMap('map', [['roads', 300, true], ['mask', 340, true], ['data', 400],
    ['plan', 410, true], ['marks', 420, true], ['streetLabels', 430, true], ['places', 440, true], ['tags', 460, true]]);
  const dataCanvas = L.canvas({ pane: 'data', padding: 0.4, tolerance: 3 });
  const planCanvas = L.canvas({ pane: 'plan', padding: 0.4 });
  const markCanvas = L.canvas({ pane: 'marks', padding: 0.4 });
  polls.forEach(p => {
    p.layer = L.polygon(p.rings, { renderer: dataCanvas, pane: 'data', weight: 1, fillOpacity: 0 }).addTo(map)
      .bindTooltip(() => pollTip(p.key), { sticky: true, direction: 'top', offset: [0, -10], opacity: 1 })
      .on('mouseover', () => p.layer.setStyle({ weight: 2.5, color: tok('fg') }))
      .on('mouseout', () => stylePoll(p))
      .on('click', e => openPoll(p.key, e.latlng));
  });
  const marks = L.layerGroup().addTo(map);
  const planLayer = L.layerGroup();
  const planBadges = L.layerGroup();  // a priority number per group, shown when the poll labels (which carry it) are off
  const tags = L.layerGroup().addTo(map);

  // ------------------------------------------------------------------ per-poll numbers
  // 2024 supporters per poll: people on the voted and didn't-vote lists. A person listed without a poll (999) takes the poll
  // their address falls in, as on the campaign map.
  function tally() {
    const by = new Map(), where = new Map();
    let people = 0, mapped = 0, noPoll = 0;
    for (const list of [S.lists?.voted, S.lists?.not].filter(Boolean)) {
      for (const person of list.people) {
        people++;
        let key = person.poll;
        if (NO_POLL.has(key)) {
          const a = listAddress(person.street);
          if (a && !where.has(a.civic)) { const hit = locate(a.civic); where.set(a.civic, hit ? pollAt(hit.p) : null); }
          const va = a ? where.get(a.civic) : null;
          if (va == null) { noPoll++; continue; }
          key = String(va);
          mapped++;
        }
        const t = by.get(key) || { voted: 0, not: 0, notPhone: 0 };
        by.set(key, t);
        if (list.kind === 'voted') t.voted++; else { t.not++; if (person.phone) t.notPhone++; }
      }
    }
    const count = k => (S.lists?.[k]?.people.length) || 0;
    return { by, people, mapped, noPoll, voted: count('voted'), not: count('not') };
  }
  function buildRows() {
    S.t = S.lists ? tally() : null;
    const planOf = new Map();
    for (const g of S.plan?.groups || []) for (const k of g.polls) planOf.set(pollKey(k), g);
    const keys = [...polls.map(p => p.key), ...(S.ps ? [...S.ps.rows.keys()].filter(k => !pollByKey.has(k) && k !== '999') : [])];
    S.rows = new Map();
    for (const key of keys) {
      const ps = S.ps?.rows.get(key), y = S.t && (S.t.by.get(key) || S.t.by.get(key.replace(/S$/, ''))), p = pollByKey.get(key);
      if (!p && !(ps?.reg)) continue;  // site-based polls (care homes) without voters
      S.rows.set(key, { key, label: p ? String(p.code) : key, sortCode: p ? p.code : parseInt(key, 10) + 0.5, p, place: p?.place,
        now: ps ? ps.support : null, supHh: ps?.supHh ?? null, unknown: ps ? ps.unknown : null, pop: ps?.pop ?? null, phones: ps?.phones ?? null,
        streets: ps?.streets || [], y24: S.t ? (y ? y.voted + y.not : 0) : null, voted: y?.voted || 0, not: y?.not || 0, notPhone: y?.notPhone || 0,
        plan: planOf.get(key) || null });
    }
  }
  const rowOf = key => S.rows.get(key);
  const both = r => r && r.now != null && r.y24 != null;

  // what's going on: supporters now against the 2024 lists
  const STATUS = [
    { k: 'few', label: 'Few supporters either year', test: r => r.y24 < 10 },
    { k: 'ahead', label: 'At or above 2024', test: r => r.now >= r.y24 },
    { k: 'close', label: 'Close to 2024', test: r => r.now >= 0.75 * r.y24 },
    { k: 'half', label: 'Over halfway to 2024', test: r => r.now >= 0.5 * r.y24 },
    { k: 'behind', label: 'Under half of 2024', test: () => true },
  ];
  const statusOf = r => both(r) ? STATUS.find(s => s.test(r)) : null;
  function story(r) {
    const out = [];
    if (both(r)) {
      const gap = r.y24 - r.now;
      if (r.y24 < 10) out.push(`${fmt(r.now)} supporter${r.now === 1 ? '' : 's'} found so far, and ${fmt(r.y24)} on the 2024 lists: too few to compare.`);
      else if (gap > 0) out.push(`${fmt(r.now)} supporters found so far, ${fmt(gap)} fewer than the ${fmt(r.y24)} on the 2024 lists (${pct(r.now / r.y24)} of 2024).`);
      else out.push(`${fmt(r.now)} supporters found so far, ${gap ? `${fmt(-gap)} more than` : 'the same as'} the ${fmt(r.y24)} on the 2024 lists.`);
    } else if (r.now != null) out.push(`${fmt(r.now)} supporters found so far.`);
    else if (r.y24 != null) out.push(`${fmt(r.y24)} supporters on the 2024 lists.`);
    if (r.unknown != null) out.push(`${pct(r.unknown)} of the people on file haven’t given a support answer yet.`);
    if (r.not) out.push(`${fmt(r.not)} of the 2024 supporters didn’t vote in 2024${r.notPhone ? ` (${fmt(r.notPhone)} with a phone)` : ''}.`);
    return out.join(' ');
  }

  // ------------------------------------------------------------------ poll colouring: one at a time
  const COUNT_BREAKS = [10, 50, 100, 150, 250];
  const ALPHA6 = [0.05, 0.16, 0.28, 0.42, 0.56, 0.72], ALPHA5 = [0.08, 0.2, 0.34, 0.5, 0.66];
  const countEdges = b => ['<' + b[0], ...b.slice(0, -1).map((v, i) => `${v}–${b[i + 1] - 1}`), b.at(-1) + '+'];
  const pctEdges = b => ['<' + pct(b[0]), ...b.slice(0, -1).map((v, i) => `${pct(v).slice(0, -1)}–${pct(b[i + 1])}`), pct(b.at(-1)) + '+'];
  const FILLS = [
    { k: 'now', label: 'Supporters now', sub: 'Current support in the Poll Summary', color: 'con', breaks: COUNT_BREAKS, alpha: ALPHA6, get: r => r.now,
      edges: countEdges, needs: () => !!S.ps, note: 'Same scale as “2024 supporters”, so switching between the two compares them.' },
    { k: 'y24', label: '2024 supporters', sub: 'People on the 2024 supporter lists', color: 'y24', breaks: COUNT_BREAKS, alpha: ALPHA6, get: r => r.y24,
      edges: countEdges, needs: () => !!S.t, note: 'Voted and didn’t-vote lists together. Same scale as “Supporters now”.' },
    { k: 'ratio', label: 'Now compared with 2024', sub: 'Supporters now as a share of 2024', color: 'ramp-find', breaks: [0.25, 0.5, 0.75, 1], alpha: ALPHA5,
      get: r => both(r) && r.y24 >= 10 ? r.now / r.y24 : null, edges: pctEdges, needs: () => !!(S.ps && S.t),
      note: 'Darker is closer to (or past) the 2024 count. Uncoloured polls had fewer than 10 supporters on the 2024 lists.' },
    { k: 'unknown', label: 'No answer yet', sub: 'People on file without a support answer', color: 'ramp-contact', breaks: [0.6, 0.7, 0.8, 0.9], alpha: ALPHA5,
      get: r => r.unknown, edges: pctEdges, needs: () => !!S.ps, note: 'Darker means more people still to reach.' },
    { k: 'result', label: '2024 result', sub: 'Election day at the poll’s 2024 voting place', needs: () => true,
      note: 'Polls that voted at the same place share its colour.' },
  ];
  const fillDef = () => FILLS.find(f => f.k === S.fill && f.needs()) || null;
  function fillOf(r) {
    const f = fillDef();
    if (!f || !r) return null;
    if (f.k === 'result') {
      if (!r.place) return null;
      const l = lean(r.place.day), [, , c, a] = RESULT_STEPS.find(([lo, hi]) => l >= lo && l < hi);
      return { c, a };
    }
    const v = f.get(r);
    return v == null ? null : { c: f.color, a: f.alpha[classOf(v, f.breaks)] };
  }
  function stylePoll(p) {
    const s = fillOf(rowOf(p.key)), selected = S.sel === p.key;
    p.layer.setStyle({ color: selected ? tok('fg') : tok('va'), weight: selected ? 3 : 1, dashArray: selected ? null : '4 3',
      fillColor: s ? tok(s.c) : 'transparent', fillOpacity: s ? s.a : 0 });
  }
  const restylePolls = () => polls.forEach(stylePoll);

  // ------------------------------------------------------------------ circles, rings and the ride plan
  const radiusFor = n => n > 0 ? 2.5 + 1.15 * Math.sqrt(n) : 0;
  const zoomK = () => { const z = map.getZoom(); return z < 13 ? 0.65 : z < 14 ? 0.8 : 1; };
  function drawMarks() {
    marks.clearLayers();
    const k = zoomK(), surface = tok('halo');
    for (const p of polls) {
      const r = rowOf(p.key);
      if (!r) continue;
      if (S.on.has('dots') && r.now) marks.addLayer(L.circleMarker(p.at, { renderer: markCanvas, pane: 'marks', interactive: false,
        radius: radiusFor(r.now) * k, fillColor: tok('con'), fillOpacity: 0.85, color: surface, weight: 1.5 }));
      if (S.on.has('rings') && r.y24) marks.addLayer(L.circleMarker(p.at, { renderer: markCanvas, pane: 'marks', interactive: false,
        radius: radiusFor(r.y24) * k, fill: false, color: tok('y24'), weight: 2.5 }));
    }
  }
  const planPlaces = () => (S.plan?.places || []).map(pl => ({ ...pl, hit: locate(pl.address) })).filter(pl => pl.hit);
  let planMarks = [];  // screen boxes the poll labels keep clear of: [latlng, dx, dy, w, h]
  function drawPlan() {
    planLayer.clearLayers();
    planBadges.clearLayers();
    planMarks = [];
    if (!S.plan) return;
    const color = tok('sign'), placesAt = new Map(planPlaces().map(pl => [pl.name, pl]));
    const ranksAt = new Map();
    for (const g of S.plan.groups) {
      const members = g.polls.map(k => pollByKey.get(pollKey(k))).filter(Boolean);
      if (!members.length) continue;
      members.forEach(p => planLayer.addLayer(L.polygon(p.rings, { renderer: planCanvas, pane: 'plan', interactive: false, fill: false, color, weight: 3.5 })));
      const c = [members.reduce((t, p) => t + p.at[0], 0) / members.length, members.reduce((t, p) => t + p.at[1], 0) / members.length];
      const dest = placesAt.get(g.place);
      if (dest) {
        planLayer.addLayer(L.polyline([c, dest.hit.p], { renderer: planCanvas, pane: 'plan', interactive: false, color, weight: 2.5, dashArray: '6 6' }));
        ranksAt.set(g.place, [...(ranksAt.get(g.place) || []), g.rank]);
      }
      planBadges.addLayer(L.marker(c, { pane: 'tags', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'plan-badge', iconSize: [0, 0], html: `<span title="Priority ${g.rank}">${g.rank}</span>` }) }));
    }
    for (const pl of placesAt.values()) {
      const ranks = ranksAt.get(pl.name) || [];
      planLayer.addLayer(L.marker(pl.hit.p, { pane: 'tags', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'plan-place', iconSize: [0, 0], html: `<i></i><span>${esc(pl.name)}<small>Priority ${ranks.join(' & ')}</small></span>` }) }));
      planMarks.push([pl.hit.p, -10, -12, 22 + pl.name.length * 6.8, 32, true]);
    }
  }

  // ------------------------------------------------------------------ labels on each poll
  function refreshTags() {
    tags.clearLayers();
    const z = map.getZoom(), view = map.getBounds().pad(0.15);
    if (S.on.has('streets') && z >= 15.5) streetLabels.addTo(map); else streetLabels.remove();
    if (S.on.has('places') && z >= 12.5) placeMarkers.addTo(map); else placeMarkers.remove();
    map.getContainer().classList.toggle('place-names', z >= 14);
    const planNames = z >= 14.5;  // school names on the plan only once there's room for them
    map.getContainer().classList.toggle('plan-names', planNames);
    const num = S.on.has('numbers'), counts = S.on.has('counts') && S.rows.size, plan = S.on.has('plan') && S.plan;
    if (plan && !num && !counts) planBadges.addTo(map); else planBadges.remove();
    if (!num && !counts) return;
    const fits = placer(), k = zoomK();
    if (plan) planMarks.forEach(([at, dx, dy, w, h, named]) => {
      const pt = map.latLngToContainerPoint(at);
      if (named && !planNames) fits.block(pt.x - 10, pt.y - 10, 20, 20); else fits.block(pt.x + dx, pt.y + dy, w, h);
    });
    const shown = polls.filter(p => view.contains(p.at)).map(p => ({ p, r: rowOf(p.key) }));
    shown.sort((a, b) => ((b.r?.now || 0) + (b.r?.y24 || 0)) - ((a.r?.now || 0) + (a.r?.y24 || 0)));
    for (const { p, r } of shown) {
      const below = (S.on.has('dots') || S.on.has('rings')) && r ? Math.max(S.on.has('dots') ? radiusFor(r.now) : 0, S.on.has('rings') ? radiusFor(r.y24) : 0) * k : 0;
      const parts = [];
      const rank = plan && r?.plan ? r.plan.rank : 0;
      if (num || rank) parts.push(`<b>${rank ? `<i class="pr" title="GOTV priority ${rank}">${rank}</i>` : ''}${num ? p.code : ''}</b>`);
      if (counts && r) {
        const c = [];
        if (r.now != null) c.push(`<i class="k now"></i>${fmt(r.now)}`);
        if (r.y24 != null) c.push(`<i class="k y24"></i>${fmt(r.y24)}`);
        if (c.length) parts.push(`<em>${c.join(' ')}</em>`);
      }
      if (!parts.length) continue;
      const digits = counts && r ? String(r.now ?? '').length + String(r.y24 ?? '').length : 0;
      const pt = map.latLngToContainerPoint(p.at), w = digits ? 40 + digits * 7.6 : 14 + String(p.code).length * 7.5 + (rank ? 18 : 0), h = digits && (num || rank) ? 36 : 20;
      const top = below ? pt.y + below + 3 : pt.y - h / 2;
      if (!fits(pt.x - w / 2, top, w, h)) continue;
      tags.addLayer(L.marker(p.at, { pane: 'tags', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'poll-tag', iconSize: [0, 0], html: `<span style="transform: translate(-50%, ${below ? `${below + 3}px` : '-50%'})">${parts.join('')}</span>` }) }));
    }
  }
  map.on('zoomend moveend', refreshTags);
  map.on('zoomend', drawMarks);

  // ------------------------------------------------------------------ switches
  const swatch = f => f.k === 'result'
    ? `<span class="ramp">${RESULT_STEPS.map(([, , c, a]) => `<i style="background:color-mix(in srgb, var(--${c}) ${a * 100}%, var(--land))"></i>`).join('')}</span>`
    : `<span class="ramp">${f.alpha.map(a => `<i style="background:color-mix(in srgb, var(--${f.color}) ${a * 100}%, var(--land))"></i>`).join('')}</span>`;
  const OVERLAYS = [
    { k: 'numbers', label: 'Poll numbers', glyph: '<span class="g-num">46</span>' },
    { k: 'counts', label: 'Supporter counts', sub: 'Now and 2024, as numbers', glyph: '<span class="g-counts"><i class="k now"></i><i class="k y24"></i></span>', needs: () => S.rows.size > 0 },
    { k: 'dots', label: 'Circles: supporters now', sub: 'Size shows the count', glyph: '<span class="g-dot"></span>', needs: () => !!S.ps },
    { k: 'rings', label: 'Rings: 2024 supporters', sub: 'Same size scale as the circles', glyph: '<span class="g-ring"></span>', needs: () => !!S.t },
    { k: 'plan', label: 'GOTV ride plan', sub: 'Priority polls and where they’re sent', glyph: '<span class="g-plan">1</span>', needs: () => !!S.plan },
    { k: 'places', label: '2024 voting places', glyph: '<span class="g-place"></span>' },
    { k: 'streets', label: 'Street names', sub: 'When zoomed in', glyph: '<span class="g-street">Ave</span>' },
  ];
  const switchRow = (group, x, checked) => `<label class="switch"><input type="checkbox" role="switch" data-group="${group}" data-k="${x.k}" ${checked ? 'checked' : ''}>
    <span class="track" aria-hidden="true"></span><span class="name">${x.label}${x.sub ? `<small>${x.sub}</small>` : ''}</span>${group === 'fill' ? swatch(x) : x.glyph}</label>`;
  function renderSwitches() {
    const fills = FILLS.filter(f => f.needs()), fd = fillDef();
    $('fills').innerHTML = `<legend>Colour the polls by <span class="aside">one at a time</span></legend>` + fills.map(f => switchRow('fill', f, fd?.k === f.k)).join('');
    $('overlays').innerHTML = '<legend>On each poll</legend>' + OVERLAYS.filter(o => !o.needs || o.needs()).map(o => switchRow('on', o, S.on.has(o.k))).join('');
  }
  document.querySelector('.layers-panel').addEventListener('change', e => {
    const box = e.target.closest('input[data-group]');
    if (!box) return;
    if (box.dataset.group === 'fill') {
      S.fill = box.checked ? box.dataset.k : null;
      document.querySelectorAll('input[data-group="fill"]').forEach(b => { if (b !== box) b.checked = false; });
      restylePolls();
    } else {
      if (box.checked) S.on.add(box.dataset.k); else S.on.delete(box.dataset.k);
      if (box.dataset.k === 'plan') { if (box.checked) planLayer.addTo(map); else planLayer.remove(); }  // badges follow in refreshTags
      if (box.dataset.k === 'dots' || box.dataset.k === 'rings') drawMarks();
      refreshTags();
    }
    renderLegend();
  });

  // ------------------------------------------------------------------ legend
  function renderLegend() {
    const f = fillDef(), parts = [];
    if (f) {
      const isResult = f.k === 'result';
      const sw = (isResult ? RESULT_STEPS.map(([, , c, a]) => [c, a]) : f.alpha.map(a => [f.color, a]))
        .map(([c, a]) => `<span style="background:color-mix(in srgb, var(--${c}) ${a * 100}%, var(--land))"></span>`).join('');
      const labels = isResult ? RESULT_LABELS : f.edges(f.breaks);
      parts.push(`<h3>${f.label}</h3><div class="scale">${sw}</div><div class="scale-labels">${labels.map(t => `<span>${t}</span>`).join('')}</div><p>${f.note}</p>`);
    }
    const keys = [];
    if (S.on.has('counts') && S.rows.size) keys.push('<span><i class="k now"></i>now</span><span><i class="k y24"></i>2024 lists</span>');
    if (S.on.has('dots') && S.ps) keys.push('<span><span class="g-dot"></span>Circle: supporters now</span>');
    if (S.on.has('rings') && S.t) keys.push('<span><span class="g-ring"></span>Ring: 2024 supporters</span>');
    if (S.on.has('plan') && S.plan) keys.push('<span><span class="g-plan">1</span>GOTV priority (gold outline), dashed line to the voting place it’s sent to</span>');
    if (S.on.has('places')) keys.push('<span><span class="g-place"></span>2024 voting place</span>');
    if (keys.length) parts.push(`<div class="keys">${keys.join('')}</div>`);
    $('legend').innerHTML = parts.join('');
  }

  // ------------------------------------------------------------------ tooltip and card
  function pollTip(key) {
    const r = rowOf(key), bits = [`<b>Poll ${esc(r?.label || key)}</b>`];
    if (r?.now != null) bits.push(`${fmt(r.now)} now`);
    if (r?.y24 != null) bits.push(`${fmt(r.y24)} in 2024`);
    if (r?.unknown != null) bits.push(`${pct(r.unknown)} no answer`);
    if (r?.plan) bits.push(`priority ${r.plan.rank}`);
    return bits.join(' · ');
  }
  function pollCard(key) {
    const r = rowOf(key);
    if (!r) return '';
    const st = statusOf(r);
    let h = `<div class="pop"><h3>Poll ${esc(r.label)}${st ? ` <span class="status st-${st.k}">${st.label}</span>` : ''}</h3>`;
    const said = story(r);
    if (said) h += `<p class="story">${said}</p>`;
    const cells = [];
    if (r.now != null) cells.push(`<div><b><i class="k now"></i>${fmt(r.now)}</b><span>supporters now${r.supHh != null ? `, in ${fmt(r.supHh)} household${r.supHh === 1 ? '' : 's'}` : ''}</span></div>`);
    if (r.y24 != null) cells.push(`<div><b><i class="k y24"></i>${fmt(r.y24)}</b><span>on the 2024 lists: ${fmt(r.voted)} voted, ${fmt(r.not)} didn’t</span></div>`);
    if (r.unknown != null) cells.push(`<div><b>${pct(r.unknown)}</b><span>no support answer yet (of ${fmt(r.pop)} on file)</span></div>`);
    if (r.phones != null) cells.push(`<div><b>${fmt(r.phones)}</b><span>people with a phone number</span></div>`);
    if (cells.length) h += `<div class="grid">${cells.join('')}</div>`;
    if (r.plan) {
      const pl = (S.plan.places || []).find(x => x.name === r.plan.place);
      h += `<p class="flag plan"><b>GOTV priority ${r.plan.rank}:</b> send voters to ${esc(r.plan.place)}${pl ? ` (${esc(pl.address)})` : ''}.${r.plan.why ? ` ${esc(r.plan.why)}.` : ''}</p>`;
    }
    if (r.place) h += `<h4>2024 result · ${chip(lean(r.place.day))}</h4><p class="meta">Election day at ${esc(r.place.name)} (polls ${runs(r.place.polls)})</p>${partyBars(r.place.day)}`;
    else if (!r.p) h += '<p class="meta">A single-building poll (usually a care home), so it has no area on the map.</p>';
    if (r.streets.length) h += `<details><summary>Streets in this poll</summary><div class="streets">${r.streets.map(s => `<span>${esc(s.name)} <span class="num">${s.n}</span></span>`).join('')}</div></details>`;
    return h + '</div>';
  }
  function openPoll(key, at) {
    const p = pollByKey.get(key);
    selectPoll(key);
    L.popup({ maxWidth: 340, autoPanPaddingTopLeft: [24, 72], autoPanPaddingBottomRight: [24, 24] }).setLatLng(at || p.at).setContent(pollCard(key)).openOn(map);
  }
  function selectPoll(key) {
    S.sel = key;
    restylePolls();
    document.querySelectorAll('#pollBody tr').forEach(tr => tr.classList.toggle('sel', tr.dataset.key === key));
  }
  map.on('popupopen', () => $('legend').classList.add('aside'));
  map.on('popupclose', () => $('legend').classList.remove('aside'));
  map.on('popupclose', () => { if (S.sel) { S.sel = null; restylePolls(); document.querySelectorAll('#pollBody tr.sel').forEach(tr => tr.classList.remove('sel')); } });

  // ------------------------------------------------------------------ summary and table
  function renderSummary() {
    const ps = S.ps, t = S.t, h = [];
    if (ps || t) {
      h.push('<div class="duo">');
      if (ps) h.push(`<div><b><i class="k now"></i>${fmt(ps.totals.support)}</b><span>supporters now</span><small>Poll Summary${ps.asOf ? `, ${day(ps.asOf)}` : ''}</small></div>`);
      if (t) h.push(`<div><b><i class="k y24"></i>${fmt(t.people)}</b><span>supporters on the 2024 lists</span><small>${fmt(t.voted)} voted in 2024, ${fmt(t.not)} didn’t</small></div>`);
      h.push('</div>');
    } else h.push('<p class="note">Unlock the campaign data, or load a Poll Summary, to see supporters by poll.</p>');
    const rows = [...S.rows.values()].filter(r => r.p && both(r));
    if (rows.length) {
      const counts = STATUS.map(s => ({ s, n: rows.filter(r => statusOf(r) === s).length })).filter(x => x.n);
      h.push(`<h2>Where things stand <span class="aside">${fmt(rows.length)} polls, supporters now against 2024</span></h2>
        <ul class="standing">${counts.map(({ s, n }) => `<li><span class="status st-${s.k}">${s.label}</span><b class="num">${n}</b></li>`).join('')}</ul>`);
    }
    if (S.plan) {
      h.push(`<h2>GOTV ride plan</h2><ol class="plan-list">${S.plan.groups.map(g => {
        const codes = g.polls.map(k => +pollKey(k)).filter(Number.isFinite).sort((a, b) => a - b);
        const rs = [...S.rows.values()].filter(r => g.polls.some(k => pollKey(k) === r.key));
        const now = rs.reduce((t, r) => t + (r.now || 0), 0), y = rs.reduce((t, r) => t + (r.y24 || 0), 0);
        return `<li><span class="g-plan">${g.rank}</span><div><b>Polls ${runs(codes)} → ${esc(g.place)}</b>
          <small>${S.ps ? `${fmt(now)} supporters now` : ''}${S.ps && S.t ? ' · ' : ''}${S.t ? `${fmt(y)} on the 2024 lists` : ''}${g.why ? `. ${esc(g.why)}.` : ''}</small></div></li>`;
      }).join('')}</ol>`);
    }
    $('summary').innerHTML = h.join('');
    const loaded = [ps && `Poll Summary${ps.asOf ? ` (${day(ps.asOf)})` : ''}`, t && '2024 supporter lists', S.plan && 'GOTV plan'].filter(Boolean);
    $('loaded').hidden = !loaded.length;
    $('loaded').textContent = loaded.length ? `Loaded: ${loaded.join(' · ')}` : '';
    $('lockBtn').hidden = !(S.builtIn && ENC);
  }
  const COLS = [
    { k: 'code', label: 'Poll', get: r => r.sortCode, show: r => esc(r.label) },
    { k: 'now', label: 'Now', get: r => r.now ?? -1, show: r => r.now == null ? '—' : fmt(r.now), r: true, when: () => !!S.ps },
    { k: 'y24', label: '2024', get: r => r.y24 ?? -1, show: r => r.y24 == null ? '—' : fmt(r.y24), r: true, when: () => !!S.t },
    { k: 'ratio', label: 'Now ÷ ’24', get: r => both(r) && r.y24 >= 10 ? r.now / r.y24 : -1, show: r => both(r) && r.y24 >= 10 ? pct(r.now / r.y24) : '—', r: true, when: () => !!(S.ps && S.t) },
    { k: 'unknown', label: 'No answer', get: r => r.unknown ?? -1, show: r => r.unknown == null ? '—' : pct(r.unknown), r: true, when: () => !!S.ps },
    { k: 'plan', label: 'Plan', get: r => r.plan ? -r.plan.rank : -99, show: r => r.plan ? `<span class="g-plan" title="GOTV priority ${r.plan.rank}">${r.plan.rank}</span>` : '', r: true, when: () => !!S.plan },
  ];
  function renderTable() {
    const cols = COLS.filter(c => !c.when || c.when());
    const sort = S.sort && cols.some(c => c.k === S.sort.k) ? S.sort : { k: 'code', dir: 1 };
    const col = cols.find(c => c.k === sort.k);
    const rows = [...S.rows.values()].sort((a, b) => (col.get(a) - col.get(b)) * sort.dir || a.sortCode - b.sortCode);
    $('pollHead').innerHTML = cols.map(c => `<th class="${c.r ? 'r' : ''}" ${c.k === sort.k ? `aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}><button type="button" data-k="${c.k}">${c.label}</button></th>`).join('');
    $('pollBody').innerHTML = rows.map(r => `<tr class="go${r.key === S.sel ? ' sel' : ''}" tabindex="0" data-key="${esc(r.key)}">${cols.map(c => `<td class="${c.r ? 'r' : ''}">${c.show(r)}</td>`).join('')}</tr>`).join('');
    const sum = k => rows.reduce((t, r) => t + (r[k] || 0), 0);
    const foot = { code: 'All', now: S.ps ? fmt(sum('now')) : '', y24: S.t ? fmt(sum('y24')) : '', ratio: S.ps && S.t && sum('y24') ? pct(sum('now') / sum('y24')) : '', unknown: '', plan: '' };
    $('pollFoot').innerHTML = rows.length ? `<tr>${cols.map(c => `<td class="${c.r ? 'r' : ''}">${foot[c.k]}</td>`).join('')}</tr>` : '';
    const notes = [];
    if (S.ps) notes.push('<b>Now</b> is current support in the Poll Summary; <b>No answer</b> is the share of people on file with no support answer yet.');
    if (S.t) notes.push('<b>2024</b> counts people on the 2024 supporter lists (voted and didn’t vote).');
    const missing = [S.ps?.rows.get('999')?.support && `${fmt(S.ps.rows.get('999').support)} supporters now`, S.t?.noPoll && `${fmt(S.t.noPoll)} people on the 2024 lists`].filter(Boolean);
    if (missing.length) notes.push(`${missing.join(' and ')} have no poll or a usable address, so they’re only in the totals at the top.`);
    notes.push('Click a column to sort, or a poll to open it.');
    $('pollsNote').innerHTML = notes.join(' ');
  }
  $('pollHead').addEventListener('click', e => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    const k = b.dataset.k;
    S.sort = S.sort?.k === k ? { k, dir: -S.sort.dir } : { k, dir: k === 'code' ? 1 : -1 };
    renderTable();
  });
  function goPoll(key) {
    const p = pollByKey.get(key);
    if (phone()) setSheet(false);
    if (!p) { map.closePopup(); L.popup({ maxWidth: 340 }).setLatLng(map.getCenter()).setContent(pollCard(key)).openOn(map); return; }
    selectPoll(key);
    map.fitBounds(p.layer.getBounds(), { padding: [40, 40], animate: !reduced, maxZoom: 16.5 });
    map.once('moveend', () => openPoll(key, p.at));
  }
  $('pollBody').addEventListener('click', e => { const tr = e.target.closest('tr.go'); if (tr) goPoll(tr.dataset.key); });
  $('pollBody').addEventListener('keydown', e => { const tr = e.target.closest('tr.go'); if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); goPoll(tr.dataset.key); } });

  // ------------------------------------------------------------------ data in: the encrypted built-in data, or files loaded in this tab
  function afterLoad() {
    buildRows();
    if (S.on.has('plan') && S.plan) planLayer.addTo(map); else planLayer.remove();
    drawPlan();
    renderAll();
  }
  function applyBuiltIn(d) {
    const ps = d.ps && sniff(d.ps.rows);
    if (ps && ps[0] === 'ps') S.ps = parsePollSummary(d.ps.rows, ps[1], { name: d.ps.name });
    for (const l of d.lists || []) S.lists = { ...S.lists, [l.kind]: listFromRows(l) };
    S.plan = d.plan || null;
    S.builtIn = true;
    afterLoad();
  }
  async function loadFiles(files) {
    const errors = [];
    for (const f of files) {
      try {
        const rows = await readWorkbook(f);
        const [kind, head] = sniff(rows);
        if (kind === 'ps') S.ps = parsePollSummary(rows, head, f);
        else if (kind === 'list') { const l = parseList(rows, head, f, listKind(f.name)); S.lists = { ...S.lists, [l.kind]: l }; }
        else if (kind === 'ix') errors.push(`${f.name} is an Interactions export; open it on the Campaign map. This map uses the Poll Summary and the 2024 lists.`);
        else errors.push(`${f.name} isn’t a Poll Summary or a 2024 supporter list.`);
      } catch (x) {
        errors.push(`${f.name} couldn’t be read: ${x.message}`);
      }
    }
    $('loadError').hidden = !errors.length;
    $('loadError').textContent = errors.join(' ');
    afterLoad();
  }
  $('files').addEventListener('change', e => { loadFiles([...e.target.files]); e.target.value = ''; });
  $('lockBtn').addEventListener('click', () => {
    Object.assign(S, { ps: null, lists: null, plan: null, t: null, rows: new Map(), sel: null, builtIn: false });
    map.closePopup();
    afterLoad();
    lock();
  });

  // ------------------------------------------------------------------ theme, phone sheet, start
  function applyTheme() {
    styleBase();
    restylePolls();
    drawMarks();
    drawPlan();
  }
  onTheme(applyTheme);
  const setSheet = sheet(app);
  function renderAll() {
    renderSwitches();
    renderSummary();
    renderTable();
    renderLegend();
    restylePolls();
    drawMarks();
    refreshTags();
  }
  $('eyebrow').textContent = `${P.riding} · ${P.code}`;
  if (phone()) setSheet(false);
  renderAll();
  applyTheme();
  const lock = gate(applyBuiltIn);
})();
