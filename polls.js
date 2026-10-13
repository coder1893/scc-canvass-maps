'use strict';
// Poll map: every poll with its supporters now (the Poll Summary's current support) and its supporters on the 2024 lists,
// what that comparison says, how much of the poll hasn't answered yet, the 2024 result and the GOTV ride plan; a focus
// ranking of the polls; and door-knocking routes (routes.js). Each layer switches on and off on its own; the poll
// colouring is one choice at a time.
(() => {
  const { P, $, fmt, pct, esc, day, reduced, phone, tok, lean, chip, RESULT_STEPS, RESULT_LABELS, classOf, runs, polls, pollByKey,
    partyBars, normStreet, siteKey, prettyCivic, locate, pollAt, listAddress, sniff, pollKey, parsePollSummary, parseInteractions, parseList,
    listKind, NO_POLL, listFromRows, readWorkbook, ENC, gate, baseMap, placer, sheet } = SCC;
  const app = $('app');

  const S = { ps: null, ix: null, lists: null, plan: null, t: null, rows: new Map(), doors: [], unchecked: new Set(), focus: new Map(),
    fill: 'now', on: new Set(['numbers', 'counts', 'plan', 'streets', 'routes']), sel: null, sort: null, builtIn: false };
  const R = { routes: [], sel: 0, turf: null };  // the door-knocking routes on the map

  // ------------------------------------------------------------------ map
  const { map, streetLabels, placeMarkers, styleBase, onTheme } = baseMap('map', [['roads', 300, true], ['mask', 340, true], ['data', 400],
    ['plan', 410, true], ['routes', 415, true], ['marks', 420, true], ['streetLabels', 430, true], ['places', 440, true], ['tags', 460, true], ['doors', 465]]);
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
  const routeCanvas = L.canvas({ pane: 'routes', padding: 0.4 });
  const doorCanvas = L.canvas({ pane: 'doors', padding: 0.4, tolerance: 5 });
  const routeLayer = L.layerGroup().addTo(map);

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

  // ------------------------------------------------------------------ doors: one per address, with who lives there
  // From the 2024 lists (and whether each person is still on the voters list) and the supporters in the canvass export.
  function buildDoors() {
    const doors = new Map();
    const get = civic => {
      const key = siteKey(civic);
      let d = doors.get(key);
      if (!d) doors.set(key, d = { key, civic: prettyCivic(civic), units: new Set(), not: 0, notReg: 0, voted: 0, votedReg: 0, now: 0, phoneNot: 0 });
      return d;
    };
    for (const list of [S.lists?.voted, S.lists?.not].filter(Boolean)) {
      for (const person of list.people) {
        const a = listAddress(person.street);
        if (!a) continue;
        const d = get(a.civic), reg = person.reg !== false;  // without the voters file everyone counts as registered
        if (a.unit) d.units.add(a.unit);
        if (list.kind === 'not') { d.not++; if (reg) d.notReg++; if (person.phone) d.phoneNot++; } else { d.voted++; if (reg) d.votedReg++; }
      }
    }
    for (const seed of S.ix?.seeds || []) {
      const sup = (seed.n.con || 0) + (seed.n.lean || 0);
      if (!sup) continue;
      const d = get(seed.civic);
      d.now += sup;
      for (const u of seed.units.keys()) if (u) d.units.add(u);
    }
    S.doors = [];
    for (const d of doors.values()) {
      const hit = locate(d.civic), m = /^(\d+)\s+(.+)$/.exec(d.civic);
      if (!hit || !m) continue;
      const poll = pollAt(hit.p);
      if (poll == null) continue;  // outside the riding
      Object.assign(d, { p: hit.p, approx: hit.approx, poll: String(poll), num: +m[1], street: normStreet(m[2]), unitCount: Math.max(1, d.units.size) });
      S.doors.push(d);
    }
    // polls the voters-by-last-name file doesn't cover at all (poll 27): don't drop their people as "moved"
    S.hasReg = !!S.lists && [S.lists.voted, S.lists.not].some(l => l?.people.some(x => x.reg != null));
    S.unchecked = new Set();
    if (S.hasReg) {
      const by = new Map();
      for (const d of S.doors) { const t = by.get(d.poll) || [0, 0]; t[0] += d.not + d.voted; t[1] += d.notReg + d.votedReg; by.set(d.poll, t); }
      for (const [k, [all, reg]] of by) if (all >= 20 && reg === 0) S.unchecked.add(k);
    }
  }
  const KNOCK_GOTV = { not: true, voted: false, now: false, reg: true };
  function targetsAt(d, o) {
    const free = !o.reg || S.unchecked.has(d.poll);
    return (o.not ? (free ? d.not : d.notReg) : 0) + (o.voted ? (free ? d.voted : d.votedReg) : 0) + (o.now ? d.now : 0);
  }

  // ------------------------------------------------------------------ focus ranking
  // 2024 supporters still on the voters list who didn't vote count 1 each (the votes a knock can add); supporters found
  // this election count half (they need a reminder too, many already vote, and some are the same people).
  function computeFocus() {
    S.focus = new Map();
    if (!S.lists && !S.ps) return;
    const doorsBy = new Map();
    for (const d of S.doors) if (targetsAt(d, KNOCK_GOTV)) (doorsBy.get(d.poll) || doorsBy.set(d.poll, []).get(d.poll)).push(d);
    const list = polls.map(p => {
      const ds = doorsBy.get(p.key) || [], skipped = ds.reduce((t, d) => t + targetsAt(d, KNOCK_GOTV), 0), now = rowOf(p.key)?.now ?? 0;
      const est = WALK.estimate(ds);
      return { key: p.key, skipped, now, score: skipped + now / 2, doors: ds.length, hours: est.minutes / 60, unchecked: S.unchecked.has(p.key) };
    }).sort((a, b) => b.score - a.score || +a.key - +b.key);
    list.forEach((f, i) => { f.rank = i + 1; f.ds = doorsBy.get(f.key) || []; S.focus.set(f.key, f); });
    refineHours();
  }
  // replace the quick estimates with the route planner's own walk, a poll at a time so the page stays responsive
  let refining = 0;
  function refineHours() {
    const run = ++refining, queue = [...S.focus.values()].filter(f => f.ds.length);
    const step = () => {
      if (run !== refining) return;  // newer data arrived
      const f = queue.shift();
      if (!f) { if (!$('pane-focus').hidden) renderTable(); return; }
      const one = WALK.plan(f.ds, 1e9)[0];
      if (one) f.hours = one.minutes / 60;
      if (!queue.length || queue.length % 10 === 0) if (!$('pane-focus').hidden) renderTable();
      setTimeout(step, 0);
    };
    setTimeout(step, 50);
  }
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
    { k: 'focus', label: 'Focus score', sub: 'Where door knocking can add the most votes', color: 'sign', breaks: [25, 50, 100, 150, 200], alpha: ALPHA6,
      get: r => S.focus.get(r.key)?.score ?? null, edges: countEdges, needs: () => S.focus.size > 0,
      note: 'Registered 2024 supporters who didn’t vote, plus half the supporters found now. The Focus tab ranks the polls.' },
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
    { k: 'routes', label: 'Door-knocking routes', sub: 'From the Routes tab', glyph: '<span class="g-route"></span>', needs: () => R.routes.length > 0 },
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
      if (box.dataset.k === 'routes') drawRoutes();
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
    if (S.on.has('routes') && R.routes.length) keys.push(`<span><span class="g-route"></span>Route ${R.sel + 1} of ${R.routes.length}, numbered in knocking order</span>`);
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
    const said = story(r), f = S.focus.get(key);
    if (said) h += `<p class="story">${said}</p>`;
    if (f) h += `<p class="meta">Focus rank <b>#${f.rank}</b> of ${S.focus.size} · score ${fmt(f.score)}${f.doors ? ` · ${fmt(f.doors)} doors with a 2024 non-voter, about ${f.hours.toFixed(1)} h to knock` : ''}</p>`;
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
    if (r.p && S.doors.some(d => d.poll === key)) h += `<button type="button" class="btn" data-route-poll="${esc(key)}">Plan door-knocking routes</button>`;
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
  // the focus table: polls ranked by focus score, or the party's plan first
  const planRank = r => r.plan ? r.plan.rank : 9;
  const COLS = [
    { k: 'rank', label: '#', get: r => r.f.rank, show: r => r.f.rank, r: true },
    { k: 'code', label: 'Poll', get: r => r.sortCode, show: r => `${esc(r.label)}${r.plan ? ` <span class="g-plan" title="GOTV priority ${r.plan.rank}">${r.plan.rank}</span>` : ''}` },
    { k: 'score', label: 'Focus', get: r => r.f.score, show: r => fmt(r.f.score), r: true, title: 'Focus score' },
    { k: 'skipped', label: 'No vote ’24', get: r => r.f.skipped, show: r => `${fmt(r.f.skipped)}${r.f.unchecked ? '*' : ''}`, r: true, when: () => !!S.t,
      title: '2024 supporters still on the voters list who didn’t vote in 2024' },
    { k: 'now', label: 'Now', get: r => r.now ?? -1, show: r => r.now == null ? '—' : fmt(r.now), r: true, when: () => !!S.ps, title: 'Supporters now (Poll Summary)' },
    { k: 'y24', label: '2024', get: r => r.y24 ?? -1, show: r => r.y24 == null ? '—' : fmt(r.y24), r: true, when: () => !!S.t, title: 'Everyone on the 2024 supporter lists' },
    { k: 'doors', label: 'Doors', get: r => r.f.doors, show: r => fmt(r.f.doors), r: true, when: () => !!S.t, title: 'Doors with a 2024 supporter who didn’t vote' },
    { k: 'hours', label: 'Hours', get: r => r.f.hours, show: r => r.f.doors ? r.f.hours.toFixed(1) : '—', r: true, when: () => !!S.t, title: 'Estimated knocking time for those doors' },
  ];
  function renderTable() {
    const cols = COLS.filter(c => !c.when || c.when());
    const byPlan = S.order === 'plan' && S.plan;
    const sort = S.sort && cols.some(c => c.k === S.sort.k) ? S.sort : { k: 'rank', dir: 1 };
    const col = cols.find(c => c.k === sort.k);
    const rows = [...S.rows.values()].filter(r => S.focus.has(r.key)).map(r => ({ ...r, f: S.focus.get(r.key) }))
      .sort((a, b) => (byPlan && !S.sort ? planRank(a) - planRank(b) : 0) || (col.get(a) - col.get(b)) * sort.dir || a.f.rank - b.f.rank);
    $('order').hidden = !S.plan || !rows.length;
    $('order').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', (b.dataset.order === 'plan') === !!byPlan));
    $('pollHead').innerHTML = cols.map(c => `<th class="${c.r ? 'r' : ''}" ${c.title ? `title="${c.title}"` : ''} ${c.k === sort.k && (S.sort || !byPlan) ? `aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}><button type="button" data-k="${c.k}">${c.label}</button></th>`).join('');
    let lastPlan = null;
    $('pollBody').innerHTML = rows.map(r => {
      const band = byPlan && !S.sort && planRank(r) !== lastPlan ? (lastPlan = planRank(r), `<tr class="band"><td colspan="${cols.length}">${r.plan ? `Priority ${r.plan.rank}: ${esc(r.plan.place)}` : 'Not in the plan'}</td></tr>`) : '';
      return `${band}<tr class="go${r.key === S.sel ? ' sel' : ''}" tabindex="0" data-key="${esc(r.key)}">${cols.map(c => `<td class="${c.r ? 'r' : ''}">${c.show(r)}</td>`).join('')}</tr>`;
    }).join('');
    const sum = k => rows.reduce((t, r) => t + (k in r.f ? r.f[k] : r[k] || 0), 0);
    const foot = { rank: '', code: 'All', score: fmt(sum('score')), skipped: fmt(sum('skipped')), now: S.ps ? fmt(sum('now')) : '', y24: S.t ? fmt(sum('y24')) : '',
      doors: fmt(sum('doors')), hours: sum('hours').toFixed(0) };
    $('pollFoot').innerHTML = rows.length ? `<tr>${cols.map(c => `<td class="${c.r ? 'r' : ''}">${foot[c.k]}</td>`).join('')}</tr>` : '';
    renderFocusNote(rows);
  }
  function renderFocusNote(rows) {
    const h = [];
    if (!rows.length) { $('pollsNote').innerHTML = '<p class="note">Unlock the campaign data to rank the polls.</p>'; return; }
    h.push(`<p class="note"><b>Focus score</b> = 2024 supporters still on the voters list who didn’t vote last time (1 each: the votes a knock can add)
      + supporters found this election (½ each: they need a reminder too, and some are the same people). <b>Doors</b> and <b>Hours</b>: knocking every door
      with a 2024 non-voter, walking at 4.5 km/h, about ${WALK.DOOR_MIN} minutes a door and a minute more for each extra unit in a building.</p>`);
    if (S.plan) {
      const planned = rows.filter(r => r.plan), n = planned.length, top = [...rows].sort((a, b) => a.f.rank - b.f.rank).slice(0, n);
      const inTop = top.filter(r => r.plan).length, extra = top.filter(r => !r.plan), lower = planned.filter(r => !top.includes(r)).sort((a, b) => a.f.rank - b.f.rank);
      const list = rs => rs.map(r => `<button type="button" class="linkish" data-poll="${esc(r.key)}">${esc(r.label)}</button> (#${r.f.rank})`).join(', ');
      h.push(`<div class="verdict"><p><b>The party’s plan and the data mostly agree.</b> The data’s top ${n} polls include ${inTop} of the plan’s ${n}.</p>
        ${extra.length ? `<p>Ranked high but not in the plan: ${list(extra)}.</p>` : ''}${lower.length ? `<p>In the plan but lower on the data: ${list(lower)}.</p>` : ''}</div>`);
    }
    const unchecked = rows.filter(r => r.f.unchecked);
    if (unchecked.length) h.push(`<p class="note">* Nobody in poll${unchecked.length > 1 ? 's' : ''} ${unchecked.map(r => esc(r.label)).join(', ')} is in the voters-list file, so ${unchecked.length > 1 ? 'their' : 'its'} 2024 non-voters are counted without that check.</p>`);
    const missing = [S.ps?.rows.get('999')?.support && `${fmt(S.ps.rows.get('999').support)} supporters now`, S.t?.noPoll && `${fmt(S.t.noPoll)} people on the 2024 lists`].filter(Boolean);
    if (missing.length) h.push(`<p class="note">${missing.join(' and ')} have no poll or a usable address, so they aren’t in this table. Click a column to sort, or a poll to open it.</p>`);
    $('pollsNote').innerHTML = h.join('');
  }
  $('order').addEventListener('click', e => { const b = e.target.closest('button[data-order]'); if (!b) return; S.order = b.dataset.order; S.sort = null; renderTable(); });
  $('pollsNote').addEventListener('click', e => { const b = e.target.closest('[data-poll]'); if (b) goPoll(b.dataset.poll); });
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

  // ------------------------------------------------------------------ door-knocking routes
  const knockOpts = () => ({ not: $('kNot').checked, voted: $('kVoted').checked, now: $('kNow').checked, reg: $('kReg').checked });
  function turfs() {
    const out = [];
    for (const g of S.plan?.groups || []) {
      const codes = g.polls.map(k => +pollKey(k)).filter(Number.isFinite).sort((a, b) => a - b);
      out.push({ id: 'g' + g.rank, label: `Priority ${g.rank}: polls ${runs(codes)} (${g.place})`, polls: new Set(codes.map(String)) });
    }
    [...S.focus.values()].filter(f => f.doors || S.doors.some(d => d.poll === f.key)).forEach(f =>
      out.push({ id: 'p' + f.key, label: `Poll ${f.key} · focus #${f.rank}`, polls: new Set([f.key]) }));
    return out;
  }
  function renderRouteForm() {
    const ts = turfs(), sel = $('turf'), keep = sel.value;
    $('routesEmpty').hidden = ts.length > 0;
    $('routeForm').hidden = !ts.length;
    if (!ts.length) return;
    const groups = ts.filter(t => t.id[0] === 'g'), single = ts.filter(t => t.id[0] === 'p');
    sel.innerHTML = (groups.length ? `<optgroup label="GOTV plan">${groups.map(t => `<option value="${t.id}">${esc(t.label)}</option>`).join('')}</optgroup>` : '') +
      `<optgroup label="One poll, by focus rank">${single.map(t => `<option value="${t.id}">${esc(t.label)}</option>`).join('')}</optgroup>`;
    sel.value = ts.some(t => t.id === keep) ? keep : ts[0].id;
    $('kReg').closest('label').hidden = !S.hasReg;
    $('kNow').closest('label').hidden = !S.ix;
    $('kNot').closest('label').hidden = $('kVoted').closest('label').hidden = !S.lists;
  }
  function clearRoutes() {
    R.routes = []; R.turf = null; R.sel = 0;
    routeLayer.clearLayers();
    $('routeOut').innerHTML = '';
  }
  function planRoutes() {
    const t = turfs().find(x => x.id === $('turf').value);
    if (!t) return;
    const o = knockOpts(), size = Math.max(10, Math.min(200, +$('perRoute').value || 40));
    const doors = S.doors.filter(d => t.polls.has(d.poll) && targetsAt(d, o) > 0);
    const t0 = performance.now();
    R.routes = WALK.plan(doors, size);
    R.turf = t; R.opts = o; R.sel = 0; R.ms = performance.now() - t0;
    R.routes.forEach((rt, i) => rt.doors.forEach((d, k) => { d.route = i; d.stop = k + 1; }));
    S.on.add('routes');
    renderRoutes();
    drawRoutes();
    renderSwitches();
    renderLegend();
    if (R.routes.length) map.fitBounds(L.latLngBounds(doors.map(d => d.p)), { padding: [40, 40], animate: !reduced, maxZoom: 17 });
  }
  const hm = min => min < 60 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')}`;
  const km = m => (m / 1000).toFixed(1) + ' km';
  function whoAt(d, o = R.opts || KNOCK_GOTV) {
    const free = !o.reg || S.unchecked.has(d.poll), out = [];
    const not = free ? d.not : d.notReg, voted = free ? d.voted : d.votedReg;
    if (o.not && not) out.push(`${not} didn’t vote ’24${d.phoneNot ? ` (${Math.min(d.phoneNot, not)} with phone)` : ''}`);
    if (o.voted && voted) out.push(`${voted} voted ’24`);
    if (o.now && d.now) out.push(`${d.now} supporter${d.now > 1 ? 's' : ''} now`);
    return out.join(' · ');
  }
  function renderRoutes() {
    if (!R.routes.length) {
      $('routeOut').innerHTML = R.turf ? '<p class="note">No doors match these choices in this area.</p>' : '';
      return;
    }
    const doors = R.routes.reduce((t, r) => t + r.doors.length, 0), len = R.routes.reduce((t, r) => t + r.len, 0), min = R.routes.reduce((t, r) => t + r.minutes, 0);
    const people = R.routes.reduce((t, r) => t + r.doors.reduce((u, d) => u + targetsAt(d, R.opts), 0), 0);
    $('routeOut').innerHTML = `<p class="route-sum"><b>${fmt(doors)} doors</b> · ${fmt(people)} people · ${R.routes.length} route${R.routes.length > 1 ? 's' : ''} · ${km(len)} · about ${hm(min)} of knocking</p>
      <div class="actions"><button type="button" class="btn primary" data-pdf="all">Download route packets (PDF)</button>
        <button type="button" class="btn" data-print="all">Print</button><button type="button" class="btn" data-csv="all">CSV</button>
        <button type="button" class="btn quiet" id="clearRoutes">Clear</button></div>
      <p class="note">Each packet is a map of the route with numbered stops, then its house sheet: every door in order with Home, Not home, Ride and Voted boxes.</p>
      <ol class="route-list">${R.routes.map((rt, i) => `<li><button type="button" data-route="${i}" aria-pressed="${i === R.sel}"><span class="rn">${i + 1}</span>
        <span><b>${rt.doors.length} doors</b> · ${km(rt.len)} · ~${hm(rt.minutes)}<small>Starts at ${esc(rt.doors[0].civic)}, ends at ${esc(rt.doors.at(-1).civic)}</small></span></button>
        <span class="route-acts"><button type="button" class="btn quiet" data-pdf="${i}">PDF</button><button type="button" class="btn quiet" data-print="${i}">Print</button><button type="button" class="btn quiet" data-csv="${i}">CSV</button></span></li>`).join('')}</ol>
      <p class="note">Routes follow the streets: each street in house-number order, long streets up one side and back down the other, then on to the nearest next street.
        Times assume walking at 4.5 km/h and about ${WALK.DOOR_MIN} minutes a door. House sheets show addresses and who’s there by type, not names.</p>`;
  }
  function drawRoutes() {
    routeLayer.clearLayers();
    if (!R.routes.length || !S.on.has('routes')) return;
    const fg = tok('fg'), muted = tok('muted'), halo = tok('halo');
    R.routes.forEach((rt, i) => {
      if (i === R.sel) return;
      routeLayer.addLayer(L.polyline(rt.line, { renderer: routeCanvas, interactive: false, color: muted, weight: 2.5, opacity: 0.6, dashArray: '2 5' }));
      rt.doors.forEach(d => routeLayer.addLayer(L.circleMarker(d.p, { renderer: doorCanvas, radius: 4, color: halo, weight: 1, fillColor: muted, fillOpacity: 0.9 })
        .on('click', () => { R.sel = i; renderRoutes(); drawRoutes(); renderLegend(); openDoor(d); })));
      routeLayer.addLayer(L.marker(rt.doors[0].p, { pane: 'tags', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'route-tag', iconSize: [0, 0], html: `<span>Route ${i + 1}</span>` }) }));
    });
    const rt = R.routes[R.sel];
    routeLayer.addLayer(L.polyline(rt.line, { renderer: routeCanvas, interactive: false, color: halo, weight: 7, opacity: 0.9 }));
    routeLayer.addLayer(L.polyline(rt.line, { renderer: routeCanvas, interactive: false, color: fg, weight: 3.5 }));
    rt.doors.forEach((d, k) => routeLayer.addLayer(L.marker(d.p, { pane: 'doors', keyboard: false, title: `${k + 1}. ${d.civic}`,
      icon: L.divIcon({ className: 'stop' + (k === 0 ? ' first' : ''), iconSize: [0, 0], html: `<span>${k + 1}</span>` }) }).on('click', () => openDoor(d))));
  }
  function openDoor(d) {
    const units = [...d.units].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    L.popup({ maxWidth: 300, autoPanPaddingTopLeft: [24, 72] }).setLatLng(d.p).setContent(`<div class="pop"><h3>${esc(d.civic)}</h3>
      <p class="meta">Route ${d.route + 1} · stop ${d.stop} · poll ${esc(d.poll)}${d.approx ? ' · location estimated' : ''}</p>
      <p>${whoAt(d)}</p>${units.length ? `<p class="meta units">Units: ${units.slice(0, 40).map(u => `<span>${esc(u)}</span>`).join('')}${units.length > 40 ? ` +${units.length - 40} more` : ''}</p>` : ''}</div>`).openOn(map);
  }
  const pickRoutes = which => which === 'all' ? R.routes.map((rt, i) => [rt, i]) : [[R.routes[+which], +which]];
  const unitsOf = d => [...d.units].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).join(', ');
  const today = () => new Date().toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
  const packetPlaces = () => (S.plan?.places || []).map(pl => ({ name: pl.name, hit: locate(pl.address) })).filter(pl => pl.hit).map(pl => ({ name: pl.name, p: pl.hit.p }));
  const download = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  function pdfRoutes(which, btn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Making the PDF…';
    setTimeout(() => {  // let the button repaint first
      try {
        const items = pickRoutes(which).map(([rt, i]) => ({ rt, n: i + 1, of: R.routes.length }));
        const meta = { area: R.turf.label, riding: P.riding, printed: today(), km, hm, who: d => whoAt(d), units: unitsOf };
        download(PACKET.pdf(items, meta, packetPlaces()), `${P.code.toLowerCase()}-${R.turf.id}-route${which === 'all' ? 's' : '-' + (+which + 1)}.pdf`);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    }, 30);
  }
  function printRoutes(which) {
    const places = packetPlaces();
    $('print').innerHTML = pickRoutes(which).map(([rt, i]) => `<section class="walk walk-map">
      <header><h1>Route ${i + 1} <span>of ${R.routes.length}</span></h1><p>${esc(R.turf.label)} · ${rt.doors.length} doors · ${km(rt.len)} · about ${hm(rt.minutes)} · printed ${today()}</p>
        <p class="sign">Canvasser ____________________ &nbsp; Date ____________</p></header>
      ${PACKET.svg(PACKET.model(rt, places))}
      <p class="foot">Start at the black circle (1) and follow the line. Numbers are the stops on the house sheet; “12–14” marks doors next to each other. Dashed grey lines are poll boundaries.</p></section>
      <section class="walk">
      <header><h1>Route ${i + 1} <span>house sheet</span></h1><p>${esc(R.turf.label)} · ${rt.doors.length} doors · ${km(rt.len)} · about ${hm(rt.minutes)} · printed ${today()}</p></header>
      <table><thead><tr><th class="n">#</th><th class="a">Address</th><th class="u">Units</th><th class="w">Who’s there</th><th class="box">Home</th><th class="box">Not home</th><th class="box">Ride</th><th class="box">Voted</th><th class="notes">Notes</th></tr></thead>
      <tbody>${rt.doors.map((d, k) => `<tr><td>${k + 1}</td><td><b>${esc(d.civic)}</b></td><td>${esc(unitsOf(d))}</td>
        <td>${whoAt(d)}</td><td class="box"></td><td class="box"></td><td class="box"></td><td class="box"></td><td class="notes"></td></tr>`).join('')}</tbody></table>
      <p class="foot">${esc(P.riding)} · confidential campaign list · return it to the office</p></section>`).join('');
    window.print();
  }
  function csvRoutes(which) {
    const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
    const free = d => !R.opts.reg || S.unchecked.has(d.poll);
    const rows = [['route', 'stop', 'address', 'units', 'poll', 'did not vote 2024', 'with a phone', 'voted 2024', 'supporters now', 'location', 'lat', 'lon']];
    for (const [rt, i] of pickRoutes(which)) rt.doors.forEach((d, k) => rows.push([i + 1, k + 1, d.civic, [...d.units].join(' '), d.poll,
      R.opts.not ? (free(d) ? d.not : d.notReg) : '', R.opts.not ? d.phoneNot : '', R.opts.voted ? (free(d) ? d.voted : d.votedReg) : '', R.opts.now ? d.now : '',
      d.approx ? 'estimated' : 'address point', d.p[0].toFixed(5), d.p[1].toFixed(5)]));
    download(new Blob([rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' }), `${P.code.toLowerCase()}-${R.turf.id}-route${which === 'all' ? 's' : '-' + (+which + 1)}.csv`);
  }
  $('routeForm').addEventListener('submit', e => { e.preventDefault(); planRoutes(); });
  $('routeForm').addEventListener('change', e => { if (R.turf && e.target.id !== 'turf') planRoutes(); });
  $('routeOut').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'clearRoutes') { clearRoutes(); renderSwitches(); renderLegend(); return; }
    if (b.dataset.pdf) return pdfRoutes(b.dataset.pdf, b);
    if (b.dataset.print) return printRoutes(b.dataset.print);
    if (b.dataset.csv) return csvRoutes(b.dataset.csv);
    if (b.dataset.route) {
      R.sel = +b.dataset.route;
      renderRoutes();
      drawRoutes();
      renderLegend();
      map.fitBounds(L.latLngBounds(R.routes[R.sel].doors.map(d => d.p)), { padding: [50, 50], animate: !reduced, maxZoom: 17.5 });
      if (phone()) setSheet(false);
    }
  });

  // ------------------------------------------------------------------ tabs
  const TABS = ['map', 'focus', 'routes'];
  function selectTab(name) {
    TABS.forEach(t => {
      const tab = $('tab-' + t), on = t === name;
      tab.setAttribute('aria-selected', on);
      tab.tabIndex = on ? 0 : -1;
      $('pane-' + t).hidden = !on;
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
  // "Plan routes for this poll" in a poll card
  map.getContainer().addEventListener('click', e => {
    const b = e.target.closest('[data-route-poll]');
    if (!b) return;
    map.closePopup();
    renderRouteForm();
    $('turf').value = 'p' + b.dataset.routePoll;
    selectTab('routes');
    if (phone()) setSheet(true);
    planRoutes();
  });

  // ------------------------------------------------------------------ data in: the encrypted built-in data, or files loaded in this tab
  function afterLoad() {
    buildRows();
    buildDoors();
    computeFocus();
    clearRoutes();
    if (S.on.has('plan') && S.plan) planLayer.addTo(map); else planLayer.remove();
    drawPlan();
    renderAll();
  }
  function applyBuiltIn(d) {
    const ps = d.ps && sniff(d.ps.rows), ix = d.ix && sniff(d.ix.rows);
    if (ps && ps[0] === 'ps') S.ps = parsePollSummary(d.ps.rows, ps[1], { name: d.ps.name });
    if (ix && ix[0] === 'ix') S.ix = parseInteractions(d.ix.rows, ix[1], { name: d.ix.name });
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
        else if (kind === 'ix') S.ix = parseInteractions(rows, head, f);
        else errors.push(`${f.name} isn’t a Poll Summary, Interactions export or 2024 supporter list.`);
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
    Object.assign(S, { ps: null, ix: null, lists: null, plan: null, t: null, rows: new Map(), doors: [], focus: new Map(), sel: null, builtIn: false });
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
    drawRoutes();
  }
  onTheme(applyTheme);
  const setSheet = sheet(app);
  function renderAll() {
    renderSwitches();
    renderSummary();
    renderTable();
    renderRouteForm();
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
