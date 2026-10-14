'use strict';
// Shared by the household map (app.js) and the poll map (polls.js): formatting, the public 2024 results, address matching,
// reading the campaign exports, the encrypted built-in data, and the base street map. Exposed as window.SCC.
window.SCC = (() => {
  const P = window.PUBLIC_DATA;
  const $ = id => document.getElementById(id);
  const fmt = n => Math.round(n).toLocaleString('en-CA');
  const pct = (x, d = 0) => (x * 100).toFixed(d) + '%';
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const day = iso => iso ? new Date(iso + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const phone = () => matchMedia('(max-width: 760px)').matches;
  const vaName = c => `${P.code} ${pad(c, 3)}`;
  const tok = n => getComputedStyle(document.documentElement).getPropertyValue('--' + n).trim();

  // ------------------------------------------------------------------ 2024 results (public)
  const PARTIES = [['ndp', 'NDP'], ['con', 'Conservative'], ['grn', 'Green'], ['oth', 'Other']];
  const valid = t => t.ndp + t.con + t.grn + t.oth;
  const lean = t => (t.con - t.ndp) / valid(t) * 100;  // positive = Conservative ahead
  const leanText = l => Math.abs(l) < 0.5 ? 'Even' : (l > 0 ? 'Con +' : 'NDP +') + Math.abs(l).toFixed(Math.abs(l) < 10 ? 1 : 0);
  const leanVar = l => Math.abs(l) < 0.5 ? 'even' : l > 0 ? 'con' : 'ndp';
  const chip = l => `<span class="chip" style="--chip:var(--${leanVar(l)})">${leanText(l)}</span>`;
  // poll shading by the 2024 lean: [from, to, colour token, opacity]
  const RESULT_STEPS = [[-Infinity, -10, 'ndp', 0.62], [-10, -5, 'ndp', 0.44], [-5, -2, 'ndp', 0.28], [-2, 2, 'even', 0.24],
    [2, 5, 'con', 0.28], [5, 10, 'con', 0.44], [10, Infinity, 'con', 0.62]];
  const RESULT_LABELS = ['NDP +10', '+5', '+2', 'Even', '+2', '+5', 'Con +10'];
  const classOf = (v, breaks) => breaks.filter(b => v >= b).length;
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
  function partyBars(t, names) {
    const v = valid(t);
    return `<div class="bars">${PARTIES.map(([k, n]) => {
      const who = names && P.results.candidates[k] ? `<small>${esc(P.results.candidates[k].map(c => c.name).join(', '))}</small>` : '';
      return `<div class="bar-row"><span class="who">${n}${who}</span><span class="val"><b>${pct(t[k] / v, 1)}</b> · ${fmt(t[k])}</span>
        <span class="track"><span class="fill" style="width:${(t[k] / v) * 100}%;background:var(--${k})"></span></span></div>`;
    }).join('')}</div>`;
  }

  // ------------------------------------------------------------------ addresses: matching a typed address to a point
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
  const pollAt = pt => inside(pt, P.outline) ? polls.find(p => inside(pt, p.rings))?.code ?? null : null;

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
      if (['Name', 'Address', 'Poll', 'Support'].every(h => r.some(v => cell(v) === h))) return ['t1', i];
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
      const row = { key, reg: num(r, 'Reg Voters'), hh: num(r, 'Households'), supHh: col('Supporter Households') < 0 ? null : num(r, 'Supporter Households'),
        phones: num(r, 'Phones'), unknown: num(r, 'Cur Unknown Pct'), support: num(r, 'Cur Support'), supportPct: num(r, 'Cur Support Pct'), streets, conShare,
        onMap: pollByKey.has(key) };
      // the export's percentages are shares of the people on file in the poll, which is more than the registered voters
      const phonesPct = num(r, 'Phones Pct');
      row.pop = row.supportPct ? row.support / row.supportPct : phonesPct ? row.phones / phonesPct : row.reg;
      row.find = row.reg * row.unknown * conShare;
      out.set(key, row);
    }
    const rowsArr = [...out.values()];
    const counted = rowsArr.filter(r => r.reg > 0);
    const reg = counted.reduce((t, r) => t + r.reg, 0);
    return { name: file.name, rows: out,
      totals: { reg, hh: rowsArr.reduce((t, r) => t + r.hh, 0), phones: rowsArr.reduce((t, r) => t + r.phones, 0),
        support: rowsArr.reduce((t, r) => t + r.support, 0), pop: rowsArr.reduce((t, r) => t + r.pop, 0),
        noAnswer: rowsArr.reduce((t, r) => t + r.unknown * r.pop, 0),
        get unknown() { return this.noAnswer / (this.pop || 1); } },
      asOf: (/(\d{4}-\d{2}-\d{2})/.exec(file.name) || [])[1] || '' };
  }

  // canvass answers by household, from the Interactions export (one row per answer)
  const CATEGORY = { 'Conservative': 'con', 'Conservative-Leaning': 'lean', 'NDP': 'ndp', 'NDP-Leaning': 'ndp_lean', 'Green': 'grn',
    'Independent': 'oth', 'Other': 'oth', 'Undecided': 'und', 'Will Not Say': 'und', 'Unknown': 'und', 'Do Not Contact': 'dnc' };
  function parseInteractions(rows, head, file) {
    const voters = new Map();
    let count = 0, latest = '', earliest = '';
    for (const r of rows.slice(head + 1)) {
      if (!r || r[0] == null || !cell(r[6])) continue;
      count++;
      const date = isoDate(r[0]), addr = cell(r[4]);
      latest = date > latest ? date : latest;
      if (date && (!earliest || date < earliest)) earliest = date;
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
    return { name: file.name, count, latest, earliest, voters: voters.size, seeds: [...sites.values()].filter(s => Object.keys(s.n).length) };
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
  // the T1 list: poll, address, whether they've voted, and (built-in data only) which earlier lists they're on, as bits
  const T1_ON = { voted24: 1, not24: 2, voters: 4, canvass: 8 };
  const t1FromRows = t => ({ name: t.name, checked: t.checked || [], people: t.rows.map(([poll, street, voted, on]) => ({ poll: pollKey(poll), street, voted: !!voted, on })) });
  function parseT1(rows, head, file) {  // a T1 file loaded in the browser: no names leave the file, so no overlap check
    const H = rows[head].map(cell), col = n => H.indexOf(n);
    const people = [];
    for (const r of rows.slice(head + 1)) {
      if (!r || !cell(r[col('Name')])) continue;
      people.push({ poll: pollKey(r[col('Poll')]), street: r[col('Address')], voted: /^(yes|y|true|1)$/i.test(cell(r[col('Voted')])), on: null });
    }
    return { name: file.name, checked: [], people };
  }
  // phone-bank households: [poll, street, list 1/2/3, voters, answered, answer Y/N/U, vote plan, flags]. T2 is a household from
  // the 2024 said-yes-didn't-vote list (L2, or on that list by address) that a caller reached, that said yes (on the phone, by
  // text or at the door), that a volunteer knocked, and that hasn't asked us to stop contacting them
  const CALL_FLAGS = { door: 1, doorCon: 2, not24: 4, textYes: 8, dnc: 16, badNumber: 32, chinese: 64, ride: 128 };
  function callsFromRows(c) {
    const F = CALL_FLAGS, doorChecked = (c.checked || []).includes('door');
    const homes = c.rows.map(([poll, street, list, voters, answered, answer, plan, flags]) => {
      const h = { poll: pollKey(poll), street, list, voters: voters || 1, answered: !!answered, answer, plan, flags,
        dnc: !!(flags & F.dnc), door: !!(flags & F.door), not24: list === 2 || !!(flags & F.not24),
        yes: answer === 'Y' || !!(flags & (F.textYes | F.doorCon)), ride: !!(flags & F.ride) };
      h.nearT2 = h.not24 && h.answered && h.yes && !h.dnc;  // everything but the door knock
      h.t2 = h.nearT2 && h.door;
      return h;
    });
    return { name: c.name, texts: c.texts || null, first: c.first, last: c.last, noAddress: c.noAddress || 0, doorChecked, homes };
  }
  const NO_POLL = new Set(['', '999']);  // the lists use 999 for "no poll assigned"
  // the encrypted payload keeps list rows as [poll, street, has phone]
  // ...and, when the voters-by-last-name file was matched, whether the person is still on the voters list
  const listFromRows = l => ({ kind: l.kind, name: l.name, people: l.rows.map(([poll, street, ph, reg]) => ({ poll: pollKey(poll), street, phone: !!ph, reg: reg == null ? null : !!reg })) });
  async function readWorkbook(file) {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null, blankrows: false });
  }

  // ------------------------------------------------------------------ built-in data, encrypted with the team password
  // data/campaign.enc.js holds AES-256-GCM ciphertext; the key is derived from the password with PBKDF2-SHA256.
  // The derived key may be kept in sessionStorage so a reload, or the other map in the same tab, doesn't ask again;
  // closing the tab drops it.
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
  async function rememberKey(key) {
    try { sessionStorage.setItem(KEY_SLOT, b64(await crypto.subtle.exportKey('raw', key))); } catch (e) { /* storage blocked */ }
  }
  function forgetKey() {
    try { sessionStorage.removeItem(KEY_SLOT); } catch (e) { /* storage blocked */ }
  }
  async function savedKey() {
    let saved = null;
    try { saved = sessionStorage.getItem(KEY_SLOT); } catch (e) { /* storage blocked */ }
    return saved ? crypto.subtle.importKey('raw', unb64(saved), { name: 'AES-GCM' }, true, ['decrypt']) : null;
  }
  // wires the password screen: calls onOpen(payload) once the data is decrypted; returns lock()
  function gate(onOpen) {
    if (!ENC) return () => {};
    function lock() {
      forgetKey();
      $('pw').value = '';
      $('gate').hidden = false;
      $('pw').focus();
    }
    async function unlockWith(key, remember) {
      onOpen(await openWith(key));
      if (remember) await rememberKey(key);
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
        if (x.name !== 'OperationError') console.error(x);  // a wrong password fails the decrypt; anything else is a bug
        err.textContent = 'That password didn’t work. Check it and try again.';
        err.hidden = false;
        $('pw').select();
      } finally {
        btn.disabled = false;
        btn.textContent = 'Unlock';
      }
    });
    savedKey().then(key => key ? unlockWith(key, false) : lock()).catch(lock);
    return lock;
  }

  // ------------------------------------------------------------------ base map: streets, riding mask and outline, voting places
  const MAJOR = new Set(['freeway', 'highway', 'arterial', 'ramp']);
  const WIDTH = { freeway: 4.5, highway: 4.5, arterial: 3.2, ramp: 2, collector: 2.4, local: 1.6, strata: 1.3, yield: 1.3 };
  const DASH = new Set(['trail', 'recreation', 'pedestrian', 'resource']);
  function baseMap(el, panes) {
    const map = L.map(el, { preferCanvas: true, zoomControl: false, minZoom: 12, maxZoom: 20, zoomSnap: 0.5 });
    L.control.zoom({ position: 'topright' }).addTo(map);
    map.attributionControl.setPrefix(false).addAttribution('Elections BC · BC Digital Road Atlas · BC Address Geocoder');
    panes.forEach(([name, z, passive]) => { map.createPane(name).style.zIndex = z; if (passive) map.getPane(name).style.pointerEvents = 'none'; });
    const roadCanvas = L.canvas({ pane: 'roads', padding: 0.4 });
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
    function styleBase() {  // road widths follow the zoom; colours follow the theme
      const z = map.getZoom(), k = z < 13.5 ? 0.55 : z < 15 ? 0.8 : z < 16.5 ? 1 : z < 18 ? 1.5 : 2.2;
      roadLayers.forEach(({ cls, layer }) => layer.setStyle({ color: tok(MAJOR.has(cls) ? 'road-major' : 'road'), weight: (WIDTH[cls] || 1) * k }));
      mask.setStyle({ fillColor: tok('mask') });
      outline.setStyle({ color: tok('edge') });
    }
    function onTheme(fn) {
      map.on('zoomend', fn);
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', fn);
      new MutationObserver(fn).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    map.fitBounds(L.polygon(P.outline).getBounds(), { padding: [12, 12] });
    return { map, streetLabels, placeMarkers, styleBase, onTheme };
  }
  function placer() {  // greedy label collision test in screen pixels; fits.block() reserves space unconditionally
    const boxes = [];
    const fits = (x, y, w, h) => {
      for (const b of boxes) if (x < b[2] && x + w > b[0] && y < b[3] && y + h > b[1]) return false;
      boxes.push([x, y, x + w, y + h]);
      return true;
    };
    fits.block = (x, y, w, h) => { boxes.push([x, y, x + w, y + h]); };
    return fits;
  }
  // phone bottom sheet: the panel collapses to its header so the map is usable
  function sheet(app) {
    const btn = $('sheetToggle');
    function setSheet(open) {
      app.classList.toggle('collapsed', !open);
      btn.textContent = open ? 'Hide' : 'Show';
      btn.setAttribute('aria-expanded', open);
    }
    btn.addEventListener('click', () => setSheet(app.classList.contains('collapsed')));
    return setSheet;
  }

  return { P, $, fmt, pct, esc, pad, day, reduced, phone, vaName, tok,
    PARTIES, valid, lean, leanText, leanVar, chip, RESULT_STEPS, RESULT_LABELS, classOf, sumWays, total, ridingConShare, places, placeOf, runs, polls, pollByKey, partyBars,
    normStreet, siteKey, prettyCivic, locate, inside, pollAt,
    CATEGORY, cell, isoDate, sniff, pollKey, parsePollSummary, parseInteractions, listAddress, parseList, listKind, NO_POLL, listFromRows, readWorkbook,
    T1_ON, t1FromRows, parseT1, CALL_FLAGS, callsFromRows,
    ENC, gate, baseMap, placer, sheet };
})();
