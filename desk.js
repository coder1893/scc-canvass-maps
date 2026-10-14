'use strict';
// Check-in desk on GitHub Pages. The shared state is one JSON file (desk.json) in the campaign's private GitHub repository:
// the route book, who has each route and what came back, and the one-volunteer-per-poll setting. Each office device connects
// once with a fine-grained access token limited to that repository; every change is a commit made against the version the
// device last read, so two devices can never claim the same route (GitHub refuses the second write and the device re-reads).
// Volunteers type their names; no voter data is stored: routes carry polls, door counts and street names only.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const key = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const tidy = s => String(s || '').trim().replace(/\s+/g, ' ');
const clock = iso => iso ? new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : '';
const hm = min => min < 60 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')}`;
const since = iso => hm(Math.max(0, (Date.now() - Date.parse(iso)) / 60000));
const MAP_URL = 'polls.html';

const S = { conn: null, ready: false, canAdmin: true, routes: [], desk: new Map(), meta: null,
  settings: { onePerPoll: true }, view: 'checkin', flow: { step: 'ask' }, readOnly: false };

// ------------------------------------------------------------------ the desk file on GitHub
// The connection (repository, token) is kept in this browser only. A missing file is an empty desk until a route book is loaded.
const CONN_KEY = 'scc-desk-connection', FILE = 'desk.json';
// A desk link carries the connection after '#join=', so another laptop opens the desk with no setup. The part after '#'
// never leaves the browser (it isn't sent to GitHub Pages), but anyone holding the link can use the desk: share it like a key.
const b64url = s => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
const deskLink = conn => `${location.origin}${location.pathname}#join=${b64url(JSON.stringify({ repo: conn.repo, token: conn.token, ...(conn.api ? { api: conn.api } : {}) }))}`;
function connFromLink() {
  const m = location.hash.match(/^#join=([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);  // keep the key out of the address bar
  try { const c = JSON.parse(unb64url(m[1])); return c && c.repo && c.token ? c : null; } catch (x) { return null; }
}
const empty = () => ({ kind: 'scc-desk', version: 1, routes: [], meta: null, settings: { onePerPoll: true }, desk: {} });
const enc = obj => { const bytes = new TextEncoder().encode(JSON.stringify(obj, null, 1)); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); };
const dec = b64 => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0))));
const store = {
  sha: null, etag: null, state: empty(), listeners: [],
  url() { return `${S.conn.api || 'https://api.github.com'}/repos/${S.conn.repo}/contents/${FILE}`; },
  headers(extra) { return { Authorization: `Bearer ${S.conn.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra }; },
  // read the file; with fresh=false a cheap "has it changed?" request (GitHub doesn't count unchanged answers against its limit)
  async read(fresh) {
    const r = await fetch(this.url(), { cache: 'no-store', headers: this.headers(!fresh && this.etag ? { 'If-None-Match': this.etag } : {}) });
    if (r.status === 304) return false;
    if (r.status === 404) { this.sha = null; this.etag = null; this.state = empty(); return true; }
    if (!r.ok) throw { status: r.status };
    const j = await r.json();
    this.sha = j.sha;
    this.etag = r.headers.get('ETag');
    this.state = { ...empty(), ...dec(j.content) };
    return true;
  },
  // change the desk: re-read, apply, save against that version; if someone else saved first, start again
  async write(change, message) {
    for (let attempt = 0; attempt < 6; attempt++) {
      await this.read(true);
      const next = structuredClone(this.state);
      if (change(next) === false) return false;
      const r = await fetch(this.url(), { method: 'PUT', cache: 'no-store', headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message, content: enc(next), ...(this.sha ? { sha: this.sha } : {}) }) });
      if (r.ok) {
        const j = await r.json();
        this.sha = j.content.sha;
        this.etag = null;
        this.state = next;
        this.emit();
        return true;
      }
      if (r.status !== 409 && r.status !== 422) throw { status: r.status };
      await new Promise(res => setTimeout(res, 250 + Math.random() * 500 * (attempt + 1)));
    }
    throw { status: 'busy' };
  },
  emit() { this.listeners.forEach(fn => fn(this.state)); },
};

// ------------------------------------------------------------------ derived state
const deskOf = id => S.desk.get(id) || { status: 'open', history: [] };
const isOut = id => deskOf(id).status === 'out';
const isDone = id => deskOf(id).status === 'done';
const isPartly = id => { const d = deskOf(id); return d.status === 'open' && d.resumeAt > 1; };
function busyPolls() {
  const busy = new Map();
  for (const r of S.routes) if (isOut(r.id)) for (const p of r.polls) busy.set(p, [...(busy.get(p) || []), deskOf(r.id).name]);
  return busy;
}
function pollStates() {
  const by = new Map();
  for (const r of S.routes) for (const p of r.polls) (by.get(p) || by.set(p, []).get(p)).push(r);
  return [...by.entries()].sort((a, b) => +a[0] - +b[0]).map(([poll, rs]) => {
    const out = rs.filter(r => isOut(r.id)), done = rs.filter(r => isDone(r.id));
    const state = out.length ? 'out' : done.length === rs.length ? 'done' : done.length || rs.some(r => isPartly(r.id)) ? 'part' : 'open';
    return { poll, rs, state, names: out.map(r => deskOf(r.id).name) };
  });
}
// the next route for a volunteer: book order, open routes only, and (unless switched off) none in a poll someone is already in
function candidates() {
  const open = S.routes.filter(r => deskOf(r.id).status === 'open');
  if (!S.settings.onePerPoll) return { fit: open, crowded: [] };
  const busy = busyPolls();
  return { fit: open.filter(r => !r.polls.some(p => busy.has(p))), crowded: open.filter(r => r.polls.some(p => busy.has(p))) };
}
const routeOutFor = name => S.routes.find(r => isOut(r.id) && deskOf(r.id).nameKey === key(name));
const where = r => r.place ? `${r.area} · ${r.place}` : r.area;
const pollsText = r => `Poll${r.polls.length > 1 ? 's' : ''} ${r.polls.join(', ')}`;

// ------------------------------------------------------------------ writes
function friendly(e) {
  if (e && (e.status === 401 || e.status === 403)) { S.readOnly = true; return 'GitHub refused the save: this device’s access token can’t write to the desk repository. Reconnect it with a token that has Contents: Read and write.'; }
  if (e && e.status === 404) return 'GitHub can’t find the desk repository. Check the repository name, or that the token covers it.';
  if (e && e.status === 'busy') return 'Several people saved at once. Try again.';
  return 'The desk couldn’t reach GitHub just now. Check the internet connection and try again.';
}
// claim a route for a name: saved only if, in the latest version of the desk, the route is still free (and, unless the route was
// picked by hand, still in a poll nobody else is in)
async function claim(route, name, picked) {
  return store.write(st => {
    const prev = st.desk[route.id];
    if (!st.routes.some(r => r.id === route.id) || (prev && prev.status !== 'open')) return false;
    if (!picked && st.settings?.onePerPoll !== false) {
      const busy = new Set(st.routes.filter(r => st.desk[r.id]?.status === 'out').flatMap(r => r.polls));
      if (route.polls.some(p => busy.has(p))) return false;
    }
    if (Object.entries(st.desk).some(([, d]) => d.status === 'out' && d.nameKey === key(name))) return false;  // one route per person
    st.desk[route.id] = { status: 'out', name: tidy(name), nameKey: key(name), outAt: new Date().toISOString(), resumeAt: prev?.resumeAt || 0, history: prev?.history || [] };
  }, `${tidy(name)} took ${route.id}`);
}
async function giveRoute(name, chosen) {
  const tryList = chosen ? [chosen] : candidates().fit;
  for (const r of tryList) {
    if (await claim(r, name, !!chosen)) return r;
    apply(store.state);  // someone else took it: look again at the latest desk
  }
  return null;
}
async function bringBack(route, f) {
  let who = '';
  await store.write(st => {
    const d = st.desk[route.id];
    if (!d || d.status !== 'out') return false;  // already handed in from another device
    const now = new Date().toISOString();
    who = d.name;
    const entry = { name: d.name, outAt: d.outAt, backAt: now, knocked: f.knocked, home: f.home, rides: f.rides, finished: f.finished, stoppedAt: f.finished ? 0 : f.stoppedAt, note: f.note };
    st.desk[route.id] = { status: f.finished ? 'done' : 'open', name: f.finished ? d.name : '', nameKey: '', outAt: '', backAt: now,
      resumeAt: f.finished ? 0 : (f.stoppedAt || 0) + 1, history: [...(d.history || []), entry] };
  }, `${deskOf(route.id).name || 'Someone'} handed in ${route.id}${f.finished ? '' : ` (stopped at ${f.stoppedAt})`}`);
  return who;
}
async function release(route) {
  await store.write(st => {
    const d = st.desk[route.id];
    if (!d || d.status !== 'out') return false;
    st.desk[route.id] = { status: 'open', name: '', nameKey: '', outAt: '', resumeAt: d.resumeAt || 0,
      history: [...(d.history || []), { name: d.name, outAt: d.outAt, backAt: new Date().toISOString(), released: true }] };
  }, `Released ${route.id}`);
}
async function reopen(route) {
  await store.write(st => {
    const d = st.desk[route.id];
    if (!d) return false;
    st.desk[route.id] = { status: 'open', name: '', nameKey: '', outAt: '', resumeAt: 0, history: d.history || [] };
  }, `Reopened ${route.id}`);
}

// ------------------------------------------------------------------ volunteer side
function setFlow(flow) { S.flow = flow; renderKiosk(); }
function ticket(r, name, fresh) {
  const d = deskOf(r.id), resume = d.resumeAt > 1;
  return `<div class="ticket">
    <p class="for">${fresh ? `${esc(name)}, your route is` : `${esc(name)} has route`}</p>
    <p class="code">${esc(r.id)}</p>
    <p class="where">${esc(where(r))} · ${esc(pollsText(r))}</p>
    <div class="facts"><div><b>${r.doors}</b><span>doors</span></div><div><b>${r.km} km</b><span>walking</span></div><div><b>${hm(r.minutes)}</b><span>about</span></div></div>
    <p class="streets"><b>Streets:</b> ${esc(r.streets.join(', '))}</p>
    ${resume ? `<p class="pick"><b>Partly done.</b> Start at stop ${d.resumeAt} on the house sheet; the doors before it were knocked.</p>` : ''}
    <p class="pick">Take packet <b>${esc(r.id)}</b> from the desk: the route map and the house sheet. Tick Home, Not home, Ride and Voted as you go.</p>
    ${r.area === 'Other polls' ? '<p class="note">These doors are spread out. A car helps.</p>' : ''}
  </div>`;
}
function renderKiosk() {
  const k = $('kiosk'), f = S.flow;
  if (!S.ready) { k.innerHTML = `<div class="empty"><h2>Connecting to the desk…</h2><p class="note">Reading the desk from GitHub.</p></div>`; return; }
  if (!S.routes.length) { k.innerHTML = `<div class="empty"><h2>No routes loaded yet</h2><p class="note">The coordinator loads the route book on the Board tab. It comes from the Poll map: Routes tab, then “Build the route book”.</p></div>`; return; }
  if (f.step === 'ask') {
    const left = candidates(), open = S.routes.filter(r => deskOf(r.id).status === 'open').length;
    k.innerHTML = `<div><h2>Here to knock on doors?</h2><p class="lead">Type your name. You’ll get a route nobody else is on${S.settings.onePerPoll ? ', in a poll nobody else is in' : ''}. Coming back? Type the same name.</p></div>
      <form class="namebox" id="nameForm" autocomplete="off"><input id="vName" name="vName" placeholder="First and last name" aria-label="Your name" required maxlength="60">
        <button class="btn go" type="submit" id="vGo">Continue</button></form>
      <p class="err" id="vErr" role="alert"></p>
      <p class="note">${open} of ${S.routes.length} routes are free${S.settings.onePerPoll && left.crowded.length ? `, ${left.fit.length} of them in polls with nobody out` : ''}.</p>`;
    $('nameForm').addEventListener('submit', onName);
    setTimeout(() => $('vName')?.focus(), 0);
    return;
  }
  if (f.step === 'assigned' || f.step === 'already') {
    k.innerHTML = ticket(f.route, f.name, f.step === 'assigned') + `<div class="row">
      ${f.step === 'already' ? `<button class="btn go" type="button" data-act="back">I’m back: hand in ${esc(f.route.id)}</button>` : ''}
      <button class="btn primary" type="button" data-act="next">Done, next volunteer</button></div>`;
    return;
  }
  if (f.step === 'none') {
    const c = candidates();
    k.innerHTML = `<div><h2>${c.crowded.length ? 'Every free route is in a poll someone is already in' : 'Every route is taken or done'}</h2>
      <p class="lead">${c.crowded.length ? `These routes don’t share any doors with the people out now, so ${esc(f.name)} can still take one:` : 'Ask the coordinator for the next area. Thank you for coming in.'}</p></div>
      ${c.crowded.length ? `<div class="choice">${c.crowded.slice(0, 6).map(r => `<button class="btn" type="button" data-take="${esc(r.id)}"><b>${esc(r.id)}</b>&nbsp;· ${esc(pollsText(r))} · ${r.doors} doors · with ${esc((busyPolls().get(r.polls.find(p => busyPolls().has(p))) || []).join(', '))} in the poll</button>`).join('')}</div>` : ''}
      <p class="err" id="vErr" role="alert"></p>
      <div class="row"><button class="btn quiet" type="button" data-act="next">Back</button></div>`;
    return;
  }
  if (f.step === 'return') { k.innerHTML = returnForm(f.route, 'kiosk'); wireReturn(k, f.route, () => setFlow({ step: 'thanks', route: f.route, name: f.name })); return; }
  if (f.step === 'thanks') {
    const d = deskOf(f.route.id), last = (d.history || []).at(-1) || {};
    k.innerHTML = `<div class="ticket"><p class="for">Thank you, ${esc(f.name)}</p><p class="code">${esc(f.route.id)}</p>
      <p class="where">${last.finished ? 'Route finished.' : `Back on the board from stop ${d.resumeAt} for the next person.`}${last.rides ? ` ${last.rides} ride${last.rides > 1 ? 's' : ''} needed: the office will call.` : ''}</p></div>
      <div class="row"><button class="btn go" type="button" data-act="again">Get another route</button><button class="btn primary" type="button" data-act="next">Done, next volunteer</button></div>`;
  }
}
async function onName(e) {
  e.preventDefault();
  const name = tidy($('vName').value);
  if (name.length < 2) { $('vErr').textContent = 'Type your name to continue.'; return; }
  if (S.readOnly) { $('vErr').textContent = 'This device can’t save to the desk. Reconnect it on the Board tab.'; return; }
  const out = routeOutFor(name);
  if (out) return setFlow({ step: 'already', route: out, name: deskOf(out.id).name || name });
  await assign(name);
}
async function assign(name, chosen) {
  const btn = $('vGo');
  if (btn) { btn.disabled = true; btn.textContent = 'Finding a route…'; }
  try {
    const r = await giveRoute(name, chosen);
    setFlow(r ? { step: 'assigned', route: r, name } : { step: 'none', name });
  } catch (x) {
    setFlow({ step: 'ask' });
    $('vErr').textContent = friendly(x);
  }
}
$('kiosk').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  const f = S.flow;
  if (b.dataset.act === 'next') return setFlow({ step: 'ask' });
  if (b.dataset.act === 'back') return setFlow({ step: 'return', route: f.route, name: f.name });
  if (b.dataset.act === 'again') return assign(f.name);
  if (b.dataset.take) {
    const r = S.routes.find(x => x.id === b.dataset.take);
    b.disabled = true;
    try { const got = await giveRoute(f.name, r); setFlow(got ? { step: 'assigned', route: got, name: f.name } : { step: 'none', name: f.name }); }
    catch (x) { $('vErr').textContent = friendly(x); b.disabled = false; }
  }
});

// the hand-in form, used by volunteers and on the board
function returnForm(r, where_) {
  const d = deskOf(r.id);
  return `<form class="form" id="retForm" data-where="${where_}">
    <h3 style="margin:0;font:800 22px/1.2 var(--display)">Hand in ${esc(r.id)}</h3>
    <p class="note">${esc(d.name)} took it at ${clock(d.outAt)} (${since(d.outAt)} ago). Count from the house sheet.</p>
    <div class="three">
      <label class="field">Doors knocked<input id="fKnocked" type="number" min="0" max="${r.doors}" inputmode="numeric" required></label>
      <label class="field">People home<input id="fHome" type="number" min="0" inputmode="numeric" value="0"></label>
      <label class="field">Rides needed<input id="fRides" type="number" min="0" inputmode="numeric" value="0"></label>
    </div>
    <div class="field" style="display:grid;gap:6px;font-weight:600;font-size:14px">Did you finish the route?
      <div class="seg" role="group" aria-label="Finished"><button type="button" data-fin="yes" aria-pressed="true">Yes, every door</button><button type="button" data-fin="no" aria-pressed="false">No, I stopped early</button></div></div>
    <label class="field" id="fStopWrap" hidden>Last stop knocked <small>The next person starts at the stop after it.</small><input id="fStop" type="number" min="1" max="${r.doors}" inputmode="numeric"></label>
    <label class="field">Notes for the office <small>Optional. Rides: write the address and time on the house sheet too.</small><input id="fNote" maxlength="200"></label>
    <p class="err" id="fErr" role="alert"></p>
    <div class="row"><button class="btn go" type="submit" id="fSave">Hand it in</button><button class="btn quiet" type="button" data-cancel>Cancel</button></div>
  </form>`;
}
function wireReturn(root, r, after) {
  const form = root.querySelector('#retForm');
  let finished = true;
  form.addEventListener('click', e => {
    const fin = e.target.closest('[data-fin]');
    if (fin) {
      finished = fin.dataset.fin === 'yes';
      form.querySelectorAll('[data-fin]').forEach(b => b.setAttribute('aria-pressed', b === fin));
      form.querySelector('#fStopWrap').hidden = finished;
    }
    if (e.target.closest('[data-cancel]')) { if (form.dataset.where === 'kiosk') setFlow({ step: 'ask' }); else closeOverlay(); }
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const n = id => Math.max(0, Math.round(+form.querySelector(id).value || 0));
    const f = { knocked: n('#fKnocked'), home: n('#fHome'), rides: n('#fRides'), finished, stoppedAt: n('#fStop'), note: tidy(form.querySelector('#fNote').value) };
    if (!finished && !f.stoppedAt) { form.querySelector('#fErr').textContent = 'Enter the last stop you knocked, so the next person knows where to start.'; return; }
    const btn = form.querySelector('#fSave');
    btn.disabled = true;
    try { await bringBack(r, f); after(); } catch (x) { form.querySelector('#fErr').textContent = friendly(x); btn.disabled = false; }
  });
  setTimeout(() => form.querySelector('#fKnocked')?.focus(), 0);
}

// ------------------------------------------------------------------ board
function closeOverlay() { $('overlay').hidden = true; $('overlay').innerHTML = ''; }
$('overlay').addEventListener('click', e => { if (e.target === $('overlay')) closeOverlay(); });
addEventListener('keydown', e => { if (e.key === 'Escape' && !$('overlay').hidden) closeOverlay(); });
function statusCell(r) {
  const d = deskOf(r.id), last = (d.history || []).filter(h => !h.released).at(-1);
  if (d.status === 'out') return `<span class="pill out">Out</span><span class="who">${esc(d.name)} · since ${clock(d.outAt)} (${since(d.outAt)})</span>`;
  if (d.status === 'done') return `<span class="pill done">Done</span><span class="who">${esc(last?.name || d.name)} · ${last?.knocked ?? 0} knocked${last?.rides ? ` · ${last.rides} ride${last.rides > 1 ? 's' : ''}` : ''}</span>`;
  if (d.resumeAt > 1) return `<span class="pill part">Partly done</span><span class="who">Resume at stop ${d.resumeAt}${last ? ` · last ${esc(last.name)}` : ''}</span>`;
  return '<span class="pill open">Free</span>';
}
function renderBoard() {
  const b = $('boardBody');
  if (!S.ready) { b.innerHTML = '<div class="empty"><h2>Connecting…</h2><p class="note">Reading the desk from GitHub.</p></div>'; return; }
  const total = S.routes.length, done = S.routes.filter(r => isDone(r.id)).length, out = S.routes.filter(r => isOut(r.id)).length;
  const hist = S.routes.flatMap(r => (deskOf(r.id).history || []).filter(h => !h.released).map(h => ({ ...h, id: r.id })));
  const sum = k => hist.reduce((t, h) => t + (h[k] || 0), 0), doorsTotal = S.routes.reduce((t, r) => t + r.doors, 0);
  const pct = n => total ? (n / total) * 100 : 0;
  let h = '';
  if (total) {
    h += `<div class="stats">
      <div class="stat"><b>${done}<span class="num" style="font-size:18px;color:var(--muted)"> / ${total}</span></b><span>routes done</span>
        <div class="bar" aria-hidden="true"><i style="width:${pct(done)}%;background:var(--green)"></i><i style="width:${pct(out)}%;background:var(--blue)"></i></div></div>
      <div class="stat"><b>${out}</b><span>volunteers out now</span></div>
      <div class="stat"><b>${sum('knocked').toLocaleString('en-CA')}</b><span>doors knocked of ${doorsTotal.toLocaleString('en-CA')}</span></div>
      <div class="stat"><b>${sum('home').toLocaleString('en-CA')}</b><span>people home</span></div>
      <div class="stat"><b>${sum('rides')}</b><span>rides needed</span></div>
    </div>`;
    const ps = pollStates();
    h += `<section><div class="section-head"><h2>Polls</h2>
        <label class="switch"><input type="checkbox" id="onePerPoll" ${S.settings.onePerPoll ? 'checked' : ''}> One volunteer per poll at a time</label></div>
      <div class="legend"><span><i style="background:var(--card)"></i>Free</span><span><i style="background:var(--blue-soft);border-color:var(--blue)"></i>Someone out</span>
        <span><i style="background:var(--gold-soft);border-color:var(--gold)"></i>Partly done</span><span><i style="background:var(--green-soft);border-color:var(--green)"></i>Done</span></div>
      <div class="polls" style="margin-top:10px">${ps.map(p => `<div class="pchip ${p.state}"><b>${esc(p.poll)}</b><span>${p.state === 'out' ? esc(p.names.join(', ')) : p.state === 'done' ? 'Done' : p.state === 'part' ? 'Partly done' : `${p.rs.length} route${p.rs.length > 1 ? 's' : ''}`}</span></div>`).join('')}</div></section>`;
    let lastArea = null;
    h += `<section><div class="section-head"><h2>Routes</h2><p class="note">Handed out in this order: the party’s priority groups first, then other polls by focus rank.</p></div>
      <div class="table-wrap"><table><thead><tr><th>Route</th><th>Polls</th><th>Doors</th><th>Time</th><th>Status</th><th></th></tr></thead><tbody>${S.routes.map(r => {
        const band = r.area !== lastArea ? (lastArea = r.area, `<tr class="group"><td colspan="6">${esc(where(r))}</td></tr>`) : '';
        const d = deskOf(r.id), acts = S.readOnly ? '' : d.status === 'out'
          ? `<button class="btn small" data-board="back" data-id="${esc(r.id)}">Hand in</button> <button class="btn small quiet" data-board="release" data-id="${esc(r.id)}">Release</button>`
          : d.status === 'done' ? `<button class="btn small quiet" data-board="reopen" data-id="${esc(r.id)}">Reopen</button>`
          : `<button class="btn small" data-board="assign" data-id="${esc(r.id)}">Give to…</button>`;
        return `${band}<tr><td class="code">${esc(r.id)}</td><td>${esc(r.polls.join(', '))}</td><td class="num">${r.doors}</td><td class="num">${hm(r.minutes)}</td><td>${statusCell(r)}</td><td class="acts">${acts}</td></tr>`;
      }).join('')}</tbody></table></div></section>`;
    const events = hist.map(e => ({ t: e.backAt, text: `${esc(e.name)} handed in ${esc(e.id)}: ${e.knocked} knocked${e.rides ? `, ${e.rides} ride${e.rides > 1 ? 's' : ''}` : ''}${e.finished ? '' : `, stopped at stop ${e.stoppedAt}`}${e.note ? ` (“${esc(e.note)}”)` : ''}` }))
      .concat(S.routes.filter(r => isOut(r.id)).map(r => ({ t: deskOf(r.id).outAt, text: `${esc(deskOf(r.id).name)} took ${esc(r.id)}` })))
      .filter(e => e.t).sort((a, b) => b.t.localeCompare(a.t)).slice(0, 14);
    if (events.length) h += `<section><div class="section-head"><h2>Latest</h2></div><ul class="log">${events.map(e => `<li><time>${clock(e.t)}</time><span>${e.text}</span></li>`).join('')}</ul></section>`;
  } else {
    h += `<div class="empty"><h2>No route book yet</h2><p class="note">On the <a href="${MAP_URL}">Poll map</a>, open the Routes tab and choose “Build the route book”, then “Copy for the check-in desk”, and paste it below.</p></div>`;
  }
  if (S.canAdmin) h += `<details class="admin" ${total ? '' : 'open'}><summary>Load a route book</summary>
      <p class="note">Paste the text from the Poll map (Routes tab, “Copy for the check-in desk”). Routes keep their status when the codes match; routes that are out stay on the board until they’re handed in.
      Print the matching packets from the same route book.</p>
      <textarea id="bookPaste" aria-label="Route book text"></textarea>
      <div class="row" style="margin-top:10px"><button class="btn primary" type="button" id="bookLoad">Load route book</button><span class="note" id="bookMsg">${esc(S.bookMsg || '')}</span></div>
      ${S.meta ? `<p class="note" style="margin-top:8px">Loaded now: built ${esc(S.meta.built)} from the Poll Summary of ${esc(S.meta.pollSummary || 'unknown date')}, ${S.meta.count} routes of up to ${S.meta.perRoute} doors${S.meta.maxWalkKm ? ` and ${S.meta.maxWalkKm} km` : ''}, knocking ${esc(S.meta.knock)}.</p>` : ''}
    </details>`;
  h += `<p class="note">This device saves to <b>${esc(S.conn.repo)}</b> on GitHub; every change is a commit there. <button class="btn small quiet" type="button" id="copyLink">Copy desk link for another laptop</button> <button class="btn small quiet" type="button" id="disconnect">Disconnect this device</button> <span class="note" id="linkMsg"></span></p>`;
  b.innerHTML = h;
}
$('boardBody').addEventListener('change', async e => {
  if (e.target.id !== 'onePerPoll') return;
  const on = e.target.checked;
  try { await store.write(st => { st.settings = { ...st.settings, onePerPoll: on }; }, `One volunteer per poll: ${on ? 'on' : 'off'}`); } catch (x) { banner(friendly(x)); e.target.checked = !on; }
});
$('boardBody').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'bookLoad') return loadBook();
  if (b.id === 'copyLink') {
    const link = deskLink(S.conn);
    try { await navigator.clipboard.writeText(link); $('linkMsg').textContent = 'Copied. Anyone with this link can use the desk, so share it only with the office team.'; }
    catch (x) { window.prompt('Copy this desk link. Anyone with it can use the desk, so share it only with the office team.', link); }
    return;
  }
  if (b.id === 'disconnect') { try { localStorage.removeItem(CONN_KEY); } catch (x) { /* storage blocked */ } location.reload(); return; }
  const r = S.routes.find(x => x.id === b.dataset.id);
  if (!r) return;
  if (b.dataset.board === 'back') { $('overlay').innerHTML = returnForm(r, 'board'); $('overlay').hidden = false; wireReturn($('overlay'), r, closeOverlay); return; }
  if (b.dataset.board === 'assign') {
    $('overlay').innerHTML = `<form class="form" id="giveForm"><h3>Give ${esc(r.id)} to…</h3><p class="note">${esc(where(r))} · ${esc(pollsText(r))} · ${r.doors} doors</p>
      <label class="field">Volunteer’s name<input id="gName" required maxlength="60" autocomplete="off"></label><p class="err" id="gErr" role="alert"></p>
      <div class="row"><button class="btn go" type="submit">Give route</button><button class="btn quiet" type="button" data-cancel>Cancel</button></div></form>`;
    $('overlay').hidden = false;
    const form = $('giveForm');
    form.querySelector('[data-cancel]').addEventListener('click', closeOverlay);
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const name = tidy($('gName').value), has = routeOutFor(name);
      if (has) { $('gErr').textContent = `${name} already has ${has.id} out. Hand that one in first.`; return; }
      try { (await giveRoute(name, r)) ? closeOverlay() : ($('gErr').textContent = 'Someone else just took this route.'); } catch (x) { $('gErr').textContent = friendly(x); }
    });
    setTimeout(() => $('gName').focus(), 0);
    return;
  }
  b.disabled = true;
  try { if (b.dataset.board === 'release') await release(r); if (b.dataset.board === 'reopen') await reopen(r); } catch (x) { banner(friendly(x)); b.disabled = false; }
});
async function loadBook() {
  const msg = { set textContent(t) { S.bookMsg = t; const el = $('bookMsg'); if (el) el.textContent = t; } };
  let book;
  try { book = JSON.parse($('bookPaste').value); } catch (x) { msg.textContent = 'That isn’t the route book text. Copy it again from the Poll map.'; return; }
  if (book?.kind !== 'route-book' || !Array.isArray(book.routes) || !book.routes.length) { msg.textContent = 'That isn’t the route book text. Copy it again from the Poll map.'; return; }
  const ok = r => typeof r.id === 'string' && /^[A-Za-z0-9-]{1,20}$/.test(r.id) && Array.isArray(r.polls) && Number.isFinite(r.doors);
  if (!book.routes.every(ok)) { msg.textContent = 'Some routes in that text are damaged. Copy it again from the Poll map.'; return; }
  const btn = $('bookLoad');
  btn.disabled = true;
  try {
    const clean = book.routes.map(r => ({ id: r.id, order: +r.order || 0, area: String(r.area || ''), place: String(r.place || ''), polls: r.polls.map(String),
      doors: +r.doors, people: +r.people || 0, km: +r.km || 0, minutes: +r.minutes || 0, streets: (r.streets || []).map(String).slice(0, 40) }));
    await store.write(st => {
      const ids = new Set(clean.map(r => r.id));
      // routes that are out stay on the board until they're handed in, even if the new book drops them
      st.routes = clean.concat(st.routes.filter(r => !ids.has(r.id) && st.desk[r.id]?.status === 'out'));
      st.meta = { built: String(book.built || ''), pollSummary: String(book.pollSummary || ''), knock: String(book.knock || ''),
        perRoute: +book.perRoute || 0, maxWalkKm: +book.maxWalkKm || 0, count: clean.length };
    }, `Loaded a route book: ${clean.length} routes`);
    msg.textContent = `Loaded ${book.routes.length} routes.`;
    if ($('bookPaste')) $('bookPaste').value = '';
  } catch (x) { msg.textContent = friendly(x); }
  if ($('bookLoad')) $('bookLoad').disabled = false;
}

// ------------------------------------------------------------------ shell
function banner(text) { $('banner').textContent = text || ''; }
function selectTab(name) {
  S.view = name;
  for (const t of ['checkin', 'board']) {
    const btn = $('tab-' + t), on = t === name;
    btn.setAttribute('aria-selected', on);
    btn.tabIndex = on ? 0 : -1;
    $(t).hidden = !on;
  }
  render();
}
document.querySelector('.tabs').addEventListener('click', e => { const t = e.target.closest('[role="tab"]'); if (t) selectTab(t.id.slice(4)); });
document.querySelector('.tabs').addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const next = S.view === 'checkin' ? 'board' : 'checkin';
  selectTab(next);
  $('tab-' + next).focus();
});
function render() {
  // keep a half-typed name or an open form intact when other people's changes arrive
  const typing = document.activeElement && ['vName', 'bookPaste'].includes(document.activeElement.id);
  if (S.view === 'checkin') { if (!(typing && S.flow.step === 'ask') && S.flow.step !== 'return') renderKiosk(); }
  else if (!(typing || document.activeElement?.closest?.('#boardBody details[open] textarea'))) renderBoard();
}
setInterval(() => { if (S.view === 'board' && $('overlay').hidden) render(); }, 30000);  // keep "out for" times current
// a kiosk left on a ticket goes back to the name screen after two minutes
let idle = 0;
addEventListener('pointerdown', () => { idle = 0; });
addEventListener('keydown', () => { idle = 0; });
setInterval(() => { if (++idle >= 4 && S.view === 'checkin' && ['assigned', 'already', 'thanks', 'none'].includes(S.flow.step)) setFlow({ step: 'ask' }); }, 30000);

// ------------------------------------------------------------------ connecting a device, and keeping up with the others
function apply(st) {
  S.routes = [...st.routes].sort((a, b) => a.order - b.order);
  S.desk = new Map(Object.entries(st.desk || {}));
  S.settings = { onePerPoll: st.settings?.onePerPoll !== false };
  S.meta = st.meta;
  render();
}
store.listeners.push(apply);
function showSetup(err) {
  $('main').hidden = true;
  document.querySelector('.tabs').hidden = true;
  const box = $('setup');
  box.hidden = false;
  box.innerHTML = `<div><h2 style="margin:0;font:800 28px/1.15 var(--display)">Connect this device to the desk</h2>
      <p class="note" style="margin-top:6px;font-size:16px">The desk keeps its list in the campaign’s private GitHub repository. Do this once on each office computer or tablet.</p></div>
    <ol class="note" style="font-size:15px;color:var(--ink)">
      <li>On GitHub, create a <b>private</b> repository for the desk, for example <code>scc-canvass-desk</code>.</li>
      <li>Create a fine-grained access token (Settings → Developer settings → Personal access tokens → Fine-grained): <b>Only select repositories</b> → that repository; <b>Permissions</b> → Repository → <b>Contents: Read and write</b>. Nothing else.</li>
      <li>Enter both below. The token stays in this browser; it only reaches that one repository.</li>
      <li>After that, use <b>Copy desk link for another laptop</b> on the Board tab. Other laptops open that link and need no setup.</li>
    </ol>
    <form class="form" id="connForm" autocomplete="off">
      <label class="field">Repository <small>owner/name</small><input id="cRepo" required placeholder="coder1893/scc-canvass-desk" pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"></label>
      <label class="field">Access token<input id="cToken" required type="password" placeholder="github_pat_…" spellcheck="false"></label>
      <p class="err" id="cErr" role="alert">${esc(err || '')}</p>
      <div class="row"><button class="btn go" type="submit" id="cGo">Connect</button></div>
    </form>`;
  $('connForm').addEventListener('submit', async e => {
    e.preventDefault();
    const conn = { repo: tidy($('cRepo').value).replace(/^https:\/\/github\.com\//, '').replace(/\/$/, ''), token: $('cToken').value.trim() };
    $('cGo').disabled = true;
    $('cGo').textContent = 'Checking…';
    try {
      S.conn = conn;
      await store.read(true);
      try { localStorage.setItem(CONN_KEY, JSON.stringify(conn)); } catch (x) { /* storage blocked: connected for this visit only */ }
      start();
    } catch (x) {
      S.conn = null;
      $('cErr').textContent = x.status === 401 ? 'GitHub didn’t accept that token. Copy it again.' : x.status === 404 || x.status === 403 ? 'GitHub can’t open that repository with this token. Check the name and that the token covers it.' : friendly(x);
      $('cGo').disabled = false;
      $('cGo').textContent = 'Connect';
    }
  });
}
let polling = 0;
async function start() {
  $('setup').hidden = true;
  $('main').hidden = false;
  document.querySelector('.tabs').hidden = false;
  S.ready = true;
  apply(store.state);
  clearInterval(polling);
  polling = setInterval(async () => {
    if (document.hidden) return;
    try { if (await store.read(false)) apply(store.state); banner(''); } catch (x) { banner(friendly(x)); }
  }, 8000);
}
renderKiosk();
(async () => {
  let conn = connFromLink();
  if (conn) { try { localStorage.setItem(CONN_KEY, JSON.stringify(conn)); } catch (x) { /* storage blocked: connected for this visit only */ } }
  else { try { conn = JSON.parse(localStorage.getItem(CONN_KEY) || 'null'); } catch (x) { /* storage blocked */ } }
  if (!conn) return showSetup();
  S.conn = conn;
  try { await store.read(true); start(); } catch (x) { S.conn = null; showSetup(friendly(x)); }
})();
