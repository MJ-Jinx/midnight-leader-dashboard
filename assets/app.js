/* Midnight on X: the KPI dashboard. Fills the page from config.json, plan.json and data/*.json.
   No dependencies. Every element it writes into carries data-bind="<name>".
   View-only for visitors; the owner's browser (a saved GitHub key, see "owner mode") also gets the targets, link
   clicks, X API spend and the controls that change things. Elements marked data-owner show only in owner mode.
   The numbers are worked out exactly as in the first dashboard (compute, KPIS, series stats, summary). */
(() => {
  'use strict';

  const $b = (name, root = document) => root.querySelector(`[data-bind="${name}"]`);
  const $$b = (name) => [...document.querySelectorAll(`[data-bind="${name}"]`)];
  const SVGNS = 'http://www.w3.org/2000/svg';
  const nf = new Intl.NumberFormat('en-GB');
  const compact = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 });
  const dShort = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
  const dLong = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  // refresh stamps are shown in the dashboard's own time zone (config.json "timezone"), whatever the viewer's clock says
  let zoneDay; let zoneLong; let zoneTime; let zoneLabel;
  function setZone(cfg) {
    let tz = { timeZone: cfg.timezone || 'UTC' };
    try { new Intl.DateTimeFormat('en-GB', tz); } catch { tz = { timeZone: 'UTC' }; }
    zoneDay = new Intl.DateTimeFormat('en-GB', { ...tz, day: 'numeric', month: 'short' });
    zoneLong = new Intl.DateTimeFormat('en-GB', { ...tz, day: 'numeric', month: 'short', year: 'numeric' });
    zoneTime = new Intl.DateTimeFormat('en-GB', { ...tz, hour: '2-digit', minute: '2-digit' });
    zoneLabel = cfg.timezoneLabel || new Intl.DateTimeFormat('en-GB', { ...tz, timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value || tz.timeZone;
  }
  const zoneStamp = (d, long) => `${(long ? zoneLong : zoneDay).format(d)}, ${zoneTime.format(d)} ${zoneLabel}`;
  // the optional focus area (config.json "local"): a region or topic whose share of posts is tracked; hidden when it has no terms
  const focusOn = () => !!(S && S.config.local && Array.isArray(S.config.local.terms) && S.config.local.terms.length);
  const focusLabel = () => (S && S.config.local && S.config.local.label) || 'Focus area';
  const focusShort = () => (S && S.config.local && S.config.local.short) || focusLabel();
  const pct = (x, d = 1) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(d) + '%');
  const signed = (v) => (v > 0 ? '+' : '') + nf.format(v);
  const KIND = { original: 'Original', reply: 'Reply', thread: 'Thread', quote: 'Quote', repost: 'Repost' };
  const ROWS_PER_PAGE = 12;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) if (kid != null && kid !== '') el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  function s(tag, attrs, text) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    if (text != null) el.textContent = text;
    return el;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const mondayOf = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
  const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
  const eng = (p) => (p.metrics.likes || 0) + (p.metrics.replies || 0) + (p.metrics.reposts || 0) + (p.metrics.quotes || 0);
  const snippet = (t, n = 200) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  let S = null;
  let owner = false; // true on the owner's browser: its GitHub key can change the repository (see checkOwner)
  let current = null;
  let list = [];
  const app = { page: 0, sort: { key: 'date', dir: 'desc' }, selected: null };

  /* ---------- tooltip ---------- */
  const tip = h('div', { class: 'mx-tip', role: 'tooltip', hidden: true });
  function showTip(evt, value, label, anchor) {
    if (!tip.isConnected) document.body.append(tip);
    tip.replaceChildren(h('strong', { text: value }), h('span', { text: label }));
    tip.hidden = false;
    const r = anchor.getBoundingClientRect();
    let x = evt && evt.clientX != null ? evt.clientX + 14 : r.left + r.width / 2 + 8;
    let y = evt && evt.clientY != null ? evt.clientY - 10 : r.top - 8;
    if (x + tip.offsetWidth > innerWidth - 8) x = Math.max(8, x - tip.offsetWidth - 28);
    if (y + tip.offsetHeight > innerHeight - 8) y = innerHeight - tip.offsetHeight - 8;
    tip.style.left = x + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };
  function bindTip(el, get) {
    el.addEventListener('pointerenter', (e) => { const [v, l] = get(); showTip(e, v, l, el); });
    el.addEventListener('pointermove', (e) => { const [v, l] = get(); showTip(e, v, l, el); });
    el.addEventListener('pointerleave', hideTip);
    el.addEventListener('focus', () => { const [v, l] = get(); showTip(null, v, l, el); });
    el.addEventListener('blur', hideTip);
  }

  /* ---------- data ---------- */
  // Visitors read the files this site publishes, and never plan.json. In owner mode (checkOwner) every file is read
  // straight from the repository through the GitHub API instead: fresher, and it includes what the public copy of the
  // site leaves out (plan.json with the targets, link clicks, X API spend).
  async function load(bust = false) {
    const q = bust ? `?t=${Date.now()}` : '';
    const site = (p) => fetch(p + q, { cache: bust ? 'no-store' : 'no-cache' }).then((r) => { if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`); return r.json(); });
    const get = owner ? (p) => ghFile(p).catch(() => site(p)) : site;
    const noPlan = { quarters: {}, calendar: [] };
    const [config, plan, posts, history, mentions, meta, buildersFile, previews] = await Promise.all([
      get('config.json'), owner ? ghFile('plan.json').catch(() => noPlan) : noPlan,
      get('data/posts.json'), get('data/history.json'), get('data/mentions.json'), get('data/meta.json'),
      get('builders.json').catch(() => null),
      get('data/builder-previews.json').catch(() => ({})),
    ]);
    setZone(config);
    const series = (config.series || []).map((x) => ({ ...x, label: x.label || x.id, phrases: (x.phrases || []).map((p) => String(p).toLowerCase()), kinds: x.kinds || ['original', 'quote', 'thread'] }));
    // the same rule as seriesOf() in scripts/lib/classify.mjs, so config edits show without a re-fetch
    const seriesOf = (p) => {
      const day = String(p.created_at || '').slice(0, 10);
      const txt = String(p.text || '').toLowerCase().replace(/[‘’]/g, "'");
      for (const x of series) {
        if (x.from && day < x.from) continue;
        if (x.to && day > x.to) continue;
        if (!x.kinds.includes(p.kind)) continue;
        if (x.phrases.some((ph) => txt.includes(ph))) return x.id;
      }
      return null;
    };
    const themes = new Map((config.themes || []).map((t) => [t.id, t]));
    themes.set('general', { id: 'general', label: 'General', pillar: null });
    const all = [...posts.posts, ...posts.other];
    return {
      config, plan, meta, themes, series, buildersFile, builders: normBuilders(buildersFile), previews: previews || {},
      seriesById: new Map(series.map((x) => [x.id, x])),
      history: history.days || {},
      mentions: mentions.days || {},
      posts: posts.posts.map((p) => ({ ...p, t: new Date(p.created_at), series: seriesOf(p) })),
      other: posts.other.map((p) => ({ ...p, t: new Date(p.created_at) })),
      dataStart: startOfDay(new Date(Math.min(Date.now(), ...all.map((p) => Date.parse(p.created_at))))),
    };
  }

  function periods() {
    const now = new Date();
    const ey = S.dataStart.getFullYear();
    const eq = Math.floor(S.dataStart.getMonth() / 3) + 1;
    const out = [];
    for (let y = now.getFullYear(), q = Math.floor(now.getMonth() / 3) + 1; (y > ey || (y === ey && q >= eq)) && out.length < 40;) {
      const key = `${y}-Q${q}`;
      out.push({ key, group: 'Quarters', label: S.plan.quarters?.[key]?.label || `Q${q} ${y}`, start: new Date(y, (q - 1) * 3, 1), end: new Date(y, q * 3, 1), calendar: true });
      q -= 1;
      if (q === 0) { q = 4; y -= 1; }
    }
    const planYears = Object.keys(S.plan.years || {}).map(Number).filter((n) => n >= 2006 && n <= now.getFullYear());
    for (let yr = now.getFullYear(); yr >= Math.min(ey, ...planYears); yr--) {
      const key = String(yr);
      const base = S.plan.years?.[key]?.label || key;
      out.push({ key, group: 'Years', label: yr === now.getFullYear() ? `${base} (year to date)` : base, start: new Date(yr, 0, 1), end: new Date(yr + 1, 0, 1), calendar: true });
    }
    const tomorrow = addDays(startOfDay(now), 1);
    out.push({ key: 'last30', group: 'Rolling', label: 'Last 30 days', start: addDays(tomorrow, -30), end: tomorrow });
    out.push({ key: 'last90', group: 'Rolling', label: 'Last 90 days', start: addDays(tomorrow, -90), end: tomorrow });
    out.push({ key: 'all', group: 'Rolling', label: 'All time', start: S.dataStart, end: tomorrow });
    return out;
  }
  const planEntry = (P) => (P.group === 'Quarters' ? S.plan.quarters?.[P.key] : P.group === 'Years' ? S.plan.years?.[P.key] : null) || null;

  function compute(P) {
    const inP = (p) => p.t >= P.start && p.t < P.end;
    const mid = S.posts.filter(inP);
    const own = mid.filter((p) => p.kind !== 'repost');
    const reposts = mid.filter((p) => p.kind === 'repost');
    const others = S.other.filter(inP);
    const withImpr = own.filter((p) => p.metrics && p.metrics.impressions != null);
    const impressions = sum(withImpr, (p) => p.metrics.impressions);
    const engagements = sum(withImpr, eng);
    const local = own.filter((p) => p.class && p.class.local).length;
    const sk = dayKey(P.start);
    const ek = dayKey(P.end);
    const snaps = Object.entries(S.history).filter(([, v]) => v && v.followers != null).sort(([a], [b]) => (a < b ? -1 : 1));
    const before = snaps.filter(([d]) => d < sk);
    const within = snaps.filter(([d]) => d >= sk && d < ek);
    const base = before.length ? before[before.length - 1] : within[0];
    const last = within.length ? within[within.length - 1] : null;
    const followersNet = base && last && base !== last ? last[1].followers - base[1].followers : null;
    const ment = Object.entries(S.mentions).filter(([d]) => d >= sk && d < ek);
    return {
      P, mid, own, reposts, others, withImpr, impressions, engagements, local,
      er: impressions > 0 ? engagements / impressions : null,
      localShare: own.length ? local / own.length : null,
      sov: mid.length + others.length ? mid.length / (mid.length + others.length) : null,
      followersNet, folTotal: last ? last[1].followers : null,
      followerPoints: within.map(([d, v]) => ({ t: new Date(d + 'T12:00'), value: v.followers })),
      hasMentions: ment.length > 0, mentionsMid: sum(ment, ([, v]) => v.midnight), mentionsTotal: sum(ment, ([, v]) => v.total),
    };
  }

  // KPIs: the tile shows `get`; the target and status are judged on `net` where it exists (followers).
  const KPIS = [
    { key: 'midnightPosts', label: 'Midnight posts', type: 'count', get: (c) => c.own.length, fmt: (v) => nf.format(v), meta: (c) => `+ ${c.reposts.length} reposts` },
    { key: 'impressions', label: 'Impressions', type: 'count', get: (c) => (c.withImpr.length ? c.impressions : null), fmt: (v) => compact.format(v), meta: (c) => (c.withImpr.length < c.own.length ? `${c.own.length - c.withImpr.length} posts without data` : `across ${nf.format(c.withImpr.length)} posts`) },
    { key: 'engagementRate', label: 'Engagement rate', type: 'rate', get: (c) => c.er, fmt: (v) => pct(v), meta: (c) => `${nf.format(c.engagements)} likes, replies, reposts, quotes` },
    {
      key: 'followersNet', label: 'Total followers', planLabel: 'Net new followers', type: 'count',
      get: (c) => c.folTotal, fmt: (v) => nf.format(v), net: (c) => c.followersNet, netFmt: signed,
      meta: (c, tt) => `Net new ${c.followersNet == null ? '— (from the 2nd daily snapshot)' : signed(c.followersNet)}${tt ? ` · target ${tt}` : ''}`,
    },
    { key: 'localShare', focus: true, get label() { return `${focusLabel()} share`; }, type: 'rate', get: (c) => c.localShare, fmt: (v) => pct(v, 0), meta: (c) => `${c.local} of ${c.own.length} posts` },
    { key: 'sov', label: 'Share of voice', type: 'info', get: (c) => c.sov, fmt: (v) => pct(v, 0), meta: () => 'Midnight posts ÷ all your posts' },
    { key: 'midnightMentions', label: 'Midnight mentions', type: 'count', get: (c) => (c.hasMentions ? c.mentionsMid : null), fmt: (v) => nf.format(v), meta: (c) => (c.hasMentions ? `of ${nf.format(c.mentionsTotal)} mentions of you` : 'Starts with the first refresh') },
  ];
  const K = (key) => KPIS.find((k) => k.key === key);
  const activeKpis = () => KPIS.filter((k) => !k.focus || focusOn());
  const kVal = (k, c) => (k.net ? k.net(c) : k.get(c));
  const kFmt = (k, v) => (k.net ? k.netFmt(v) : k.fmt(v));
  const kLabel = (k) => k.planLabel || k.label;
  const targetFor = (k, P) => { const t = planEntry(P)?.targets?.[k.key]; return t == null ? null : Number(t); };
  const pace = (P) => { const span = P.end - P.start; return span ? Math.min(Math.max(Date.now() - P.start, 0), span) / span : 1; };

  function statusOf(k, v, t, P) {
    if (k.type === 'info') return { cls: 'none', label: 'Context' };
    if (t == null) return { cls: 'none', label: P.calendar ? 'No target set' : 'No target (rolling)' };
    if (v == null) return { cls: 'none', label: k.key === 'followersNet' ? 'Net pending' : 'No data yet' };
    if (k.type === 'rate') return v >= t ? { cls: '', label: 'Target met' } : v >= t * 0.8 ? { cls: 'warn', label: 'Close to target' } : { cls: 'out', label: 'Below target' };
    const expected = t * pace(P);
    if (v >= t) return { cls: '', label: 'Target met' };
    if (v >= expected) return { cls: '', label: 'On pace' };
    if (v >= expected * 0.75) return { cls: 'warn', label: 'Slightly behind' };
    return { cls: 'out', label: 'Behind pace' };
  }
  function targetText(k, t, P, withPace = true) {
    if (t == null) return '—';
    if (k.type === 'rate') return `≥ ${pct(t, t < 0.1 ? 1 : 0)}`;
    const base = k.key === 'followersNet' ? `+${nf.format(t)}` : nf.format(t);
    const f = pace(P);
    return withPace && f < 1 ? `${base} (≈${nf.format(Math.round(t * f))} by today)` : base;
  }
  const chip = (st) => h('span', { class: 'mx-chip' + (st.cls ? ' mx-chip--' + st.cls : ''), text: st.label });

  /* ---------- charts ---------- */
  function niceMax(v, integer) {
    if (v <= 0) return integer ? 2 : 1;
    if (integer && v <= 10) return Math.max(2, Math.ceil(v / 2) * 2);
    const p = 10 ** Math.floor(Math.log10(v));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }
  const roundedTop = (x, y, w, hh, r) => `M${x},${y + hh}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hh}Z`;
  const empty = (el, text) => el.replaceChildren(h('div', { class: 'mx-empty', text }));

  function barChart(el, rows, { fmt = (v) => nf.format(v), integer = false, max: fixedMax = null } = {}) {
    if (!rows.length || rows.every((r) => !r.value)) return empty(el, 'No posts in this period yet.');
    const W = Math.max(200, el.clientWidth || 420);
    const H = Math.max(90, el.clientHeight || 190);
    const m = { t: 6, r: 2, b: 20, l: 36 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const max = niceMax(fixedMax ?? Math.max(...rows.map((r) => r.value || 0)), integer);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
    for (const t of [0, max / 2, max]) {
      const y = m.t + ih - (t / max) * ih;
      svg.append(s('line', { class: t === 0 ? 'base' : 'grid-l', x1: m.l, x2: W - m.r, y1: y, y2: y }));
      svg.append(s('text', { x: m.l - 6, y: y + 4, 'text-anchor': 'end' }, compact.format(t)));
    }
    const band = iw / rows.length;
    const bw = Math.max(2, Math.min(26, band - 2));
    const every = Math.ceil(rows.length / Math.max(1, Math.floor(iw / 50)));
    rows.forEach((r, i) => {
      const x0 = m.l + i * band;
      const bh = (r.value / max) * ih;
      const hit = s('rect', { class: 'hit' + (r.href ? ' link' : ''), x: x0, y: m.t, width: band, height: ih, tabindex: 0, 'aria-label': `${r.tip || r.label}: ${fmt(r.value)}` });
      bindTip(hit, () => [fmt(r.value), r.tip || r.label]);
      if (r.href) {
        hit.setAttribute('role', 'link');
        const open = () => window.open(r.href, '_blank', 'noopener');
        hit.addEventListener('click', open);
        hit.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      }
      svg.append(hit);
      if (bh > 0) svg.append(s('path', { class: 'bar', d: roundedTop(x0 + (band - bw) / 2, m.t + ih - bh, bw, bh, Math.min(4, bw / 2, bh)) }));
      if (i % every === 0) svg.append(s('text', { x: x0 + band / 2, y: H - 4, 'text-anchor': 'middle' }, r.label));
    });
    el.replaceChildren(svg);
  }

  function lineChart(el, pts) {
    if (pts.length < 2) {
      const p = pts[0];
      if (!p) return empty(el, 'No follower snapshot in this period.');
      return el.replaceChildren(h('div', { class: 'mx-single' }, h('strong', { text: nf.format(p.value) }), h('span', { text: `Followers on ${dLong.format(p.t)}. Needs at least two daily snapshots for a line; they build up as the daily refresh runs.` })));
    }
    const W = Math.max(200, el.clientWidth || 420);
    const H = Math.max(90, el.clientHeight || 190);
    const m = { t: 8, r: 46, b: 20, l: 44 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    let lo = Math.min(...pts.map((p) => p.value));
    let hi = Math.max(...pts.map((p) => p.value));
    if (lo === hi) { lo -= 2; hi += 2; }
    const pv = (hi - lo) * 0.12;
    lo = Math.floor(lo - pv); hi = Math.ceil(hi + pv);
    const t0 = pts[0].t.getTime();
    const t1 = pts[pts.length - 1].t.getTime();
    const X = (t) => m.l + ((t - t0) / (t1 - t0 || 1)) * iw;
    const Y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}` });
    [lo, Math.round((lo + hi) / 2), hi].forEach((v, i) => {
      svg.append(s('line', { class: i === 0 ? 'base' : 'grid-l', x1: m.l, x2: m.l + iw, y1: Y(v), y2: Y(v) }));
      svg.append(s('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, nf.format(v)));
    });
    [0, pts.length - 1].forEach((i, j) => svg.append(s('text', { x: X(pts[i].t.getTime()), y: H - 4, 'text-anchor': j ? 'end' : 'start' }, dShort.format(pts[i].t))));
    svg.append(s('path', { class: 'line', d: pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t.getTime()).toFixed(1)},${Y(p.value).toFixed(1)}`).join('') }));
    const lastP = pts[pts.length - 1];
    svg.append(s('text', { class: 'endlabel', x: X(t1) + 8, y: Y(lastP.value) + 4 }, nf.format(lastP.value)));
    const cross = s('line', { class: 'cross', y1: m.t, y2: m.t + ih, visibility: 'hidden' });
    const dot = s('circle', { class: 'dot', r: 4.5, visibility: 'hidden' });
    const overlay = s('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent', tabindex: 0, 'aria-label': 'Followers by day. Arrow keys read each day.' });
    let idx = pts.length - 1;
    const place = (i, evt) => {
      idx = Math.max(0, Math.min(pts.length - 1, i));
      const p = pts[idx];
      const x = X(p.t.getTime());
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x); dot.setAttribute('cy', Y(p.value)); dot.setAttribute('visibility', 'visible');
      showTip(evt, nf.format(p.value), dLong.format(p.t), dot);
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); };
    overlay.addEventListener('pointermove', (e) => {
      const r = overlay.getBoundingClientRect();
      const t = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
      let best = 0;
      pts.forEach((p, i) => { if (Math.abs(p.t - t) < Math.abs(pts[best].t - t)) best = i; });
      place(best, e);
    });
    overlay.addEventListener('pointerleave', hide);
    overlay.addEventListener('focus', () => place(idx, null));
    overlay.addEventListener('blur', hide);
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); place(idx - 1, null); }
      if (e.key === 'ArrowRight') { e.preventDefault(); place(idx + 1, null); }
    });
    svg.append(cross, dot, overlay);
    el.replaceChildren(svg);
  }

  function heatmap(el, P, counts) {
    const today = startOfDay(new Date());
    let start = new Date(Math.max(P.start.getTime(), S.dataStart.getTime()));
    const end = new Date(Math.min(P.end.getTime(), addDays(today, 1).getTime()));
    if ((end - start) / 864e5 > 371) start = addDays(end, -364);
    if (end <= start) return empty(el, 'No posts in this period yet.');
    const weeks = Math.ceil((end - mondayOf(start)) / (7 * 864e5));
    const c = Math.max(8, Math.min(22, Math.floor(((el.clientHeight || 190) - 30) / 7) - 3, Math.floor(((el.clientWidth || 420) - 36) / weeks) - 3));
    const labels = h('div', { class: 'mx-heat__days', 'aria-hidden': 'true' });
    ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].forEach((d) => labels.append(h('span', { text: d })));
    const grid = h('div', { class: 'mx-heat__grid' });
    for (let d = mondayOf(start); d < end; d = addDays(d, 1)) {
      const out = d < startOfDay(start) || d > today;
      const n = counts.get(dayKey(d)) || 0;
      const lvl = n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 3 : 4;
      const cell = h('i', { class: out ? 'out' : 'l' + lvl, tabindex: out ? null : 0, 'aria-label': out ? null : `${dLong.format(d)}: ${n} posts` });
      if (!out) { const dd = new Date(d); bindTip(cell, () => [`${n} post${n === 1 ? '' : 's'}`, dLong.format(dd)]); }
      grid.append(cell);
    }
    const wrap = h('div', { class: 'mx-heat' }, labels, grid);
    wrap.style.setProperty('--c', c + 'px');
    const legend = h('div', { class: 'mx-legend' }, h('span', { text: 'Less' }));
    for (let i = 0; i <= 4; i++) { const sw = h('i'); sw.style.background = `var(--mx-seq-${i})`; legend.append(sw); }
    legend.append(h('span', { text: 'More (0 · 1 · 2 · 3–4 · 5+)' }));
    el.replaceChildren(h('div', { class: 'mx-heat-wrap' }, wrap, legend));
    requestAnimationFrame(() => { wrap.scrollLeft = wrap.scrollWidth; });
  }

  function bars(el, rows) {
    if (!rows.length || rows.every((r) => !r.value)) return empty(el, 'No posts in this period yet.');
    const max = Math.max(1, ...rows.map((r) => r.value));
    el.replaceChildren(...rows.map((r) => {
      const fill = h('div', { class: 'mx-bar__fill' });
      fill.style.width = ((r.value / max) * 100).toFixed(1) + '%';
      const row = h('div', { class: 'mx-bar' + (r.muted ? ' mx-bar--muted' : ''), title: r.tip || null },
        h('div', { class: 'mx-bar__name' }, h('span', { text: r.label }), r.pillar ? h('span', { class: 'mx-pill', title: `Pillar ${r.pillar}`, text: `P${r.pillar}` }) : null),
        h('div', { class: 'mx-bar__track' }, fill),
        h('div', { class: 'mx-bar__n', text: nf.format(r.value) }));
      return row;
    }));
  }

  function table(headers, rows, numeric = []) {
    return h('table', { class: 'mx-table' },
      h('thead', null, h('tr', null, headers.map((x, i) => h('th', { class: numeric.includes(i) ? 'n' : null, scope: 'col', text: x })))),
      h('tbody', null, rows.map((r) => h('tr', { class: r.cls || null }, (r.cells || r).map((cell, i) => h('td', { class: numeric.includes(i) ? 'n' : null }, cell))))));
  }

  /* ---------- KPI tiles ---------- */
  // a small picture per KPI: progress to its target (today's pace marked), a share bar, or its trend
  function paceBar(value, target, expected) {
    const svg = s('svg', { class: 'mx-pace', viewBox: '0 0 200 10', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    svg.append(s('rect', { class: 'mx-pace__track', x: 0, y: 2, width: 200, height: 6, rx: 3 }));
    const f = target ? Math.max(0, Math.min(1, (value || 0) / target)) : 0;
    if (f > 0) svg.append(s('rect', { class: 'mx-pace__fill', x: 0, y: 2, width: Math.max(6, 200 * f), height: 6, rx: 3 }));
    if (expected != null && target) svg.append(s('rect', { class: 'mx-pace__tick', x: Math.min(198, 200 * Math.min(1, expected / target)), y: 0, width: 2, height: 10 }));
    return svg;
  }
  function sparkline(values) {
    const svg = s('svg', { class: 'mx-spark', viewBox: '0 0 200 24', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    if (values.length < 2) { svg.append(s('line', { class: 'mx-spark__base', x1: 0, x2: 200, y1: 23, y2: 23 })); return svg; }
    const max = Math.max(1e-9, ...values);
    const pts = values.map((v, i) => `${(i / (values.length - 1)) * 200},${22 - ((v || 0) / max) * 20}`);
    svg.append(s('polyline', { class: 'mx-spark__line', points: pts.join(' '), 'vector-effect': 'non-scaling-stroke' }));
    return svg;
  }
  function kpiPicture(k, c) {
    const t = targetFor(k, c.P);
    const v = kVal(k, c);
    if (t != null) return paceBar(v, t, k.type === 'count' ? t * pace(c.P) : t);
    if (k.key === 'sov' || k.key === 'localShare') return paceBar(v, 1, null);
    const { list: bk } = bucketsFor(c.P);
    const inB = (arr, b) => arr.filter((p) => p.t >= b.start && p.t < b.end);
    if (k.key === 'midnightPosts') return sparkline(bk.map((b) => inB(c.own, b).length));
    if (k.key === 'impressions') return sparkline(bk.map((b) => sum(inB(c.withImpr, b), (p) => p.metrics.impressions)));
    if (k.key === 'engagementRate') return sparkline(bk.map((b) => { const w = inB(c.withImpr, b); const im = sum(w, (p) => p.metrics.impressions); return im ? sum(w, eng) / im : 0; }));
    if (k.key === 'midnightMentions') return sparkline(Object.entries(S.mentions).filter(([d]) => d >= dayKey(c.P.start) && d < dayKey(c.P.end)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, x]) => x.midnight));
    return sparkline(c.followerPoints.map((x) => x.value));
  }
  function renderKpis(c) {
    // one row of tiles on wide screens, whatever the count (6 without a focus area, 7 with one); 3 or 4 a row on medium screens
    const tiles = activeKpis().length;
    $b('kpi-cards').style.setProperty('--kpi-n', tiles);
    $b('kpi-cards').style.setProperty('--kpi-mid', tiles % 3 === 0 ? 3 : 4);
    $b('kpi-cards').replaceChildren(...activeKpis().map((k) => {
      const v = k.get(c);
      const t = targetFor(k, c.P);
      const st = statusOf(k, kVal(k, c), t, c.P);
      const tt = t != null ? targetText(k, t, c.P) : null;
      return h('div', { class: 'db-tile' },
        h('p', { class: 'db-tile__k', text: k.label }),
        h('p', { class: 'db-tile__v', text: v == null ? '—' : k.fmt(v) }),
        owner ? chip(st) : null, // the status compares against targets, which only the owner sees
        kpiPicture(k, c),
        h('p', { class: 'db-tile__m', text: k.net ? k.meta(c, tt) : tt != null ? `Target ${tt}` : k.meta(c) }));
    }));
  }

  /* ---------- trends ---------- */
  function bucketsFor(P) {
    const end = new Date(Math.min(P.end.getTime(), addDays(startOfDay(new Date()), 1).getTime()));
    const start = new Date(Math.max(P.start.getTime(), S.dataStart.getTime())); // no empty buckets before the data begins
    const monthly = (end - start) / 864e5 > 190;
    const out = [];
    if (monthly) {
      for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d < end;) {
        const n = new Date(d.getFullYear(), d.getMonth() + 1, 1);
        out.push({ start: d, end: n, label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }), tip: d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) });
        d = n;
      }
    } else {
      for (let d = mondayOf(start); d < end; d = addDays(d, 7)) out.push({ start: d, end: addDays(d, 7), label: dShort.format(d), tip: `Week of ${dLong.format(d)}` });
    }
    return { monthly, list: out };
  }

  function renderTrends(c) {
    const { monthly, list: bk } = bucketsFor(c.P);
    const per = monthly ? 'month' : 'week';
    $b('posts-title').textContent = `Midnight posts per ${per}`;
    $b('impr-title').textContent = `Impressions per ${per}`;
    const rowsPosts = bk.map((b) => ({ label: b.label, tip: b.tip, value: c.own.filter((p) => p.t >= b.start && p.t < b.end).length }));
    const rowsImpr = bk.map((b) => ({ label: b.label, tip: b.tip, value: sum(c.withImpr.filter((p) => p.t >= b.start && p.t < b.end), (p) => p.metrics.impressions) }));
    barChart($b('ch-posts'), rowsPosts, { integer: true });
    barChart($b('ch-impr'), rowsImpr);
    $b('tb-posts').replaceChildren(table([monthly ? 'Month' : 'Week of', 'Posts'], rowsPosts.map((r) => [r.tip.replace(/^Week of /, ''), nf.format(r.value)]), [1]));
    $b('tb-impr').replaceChildren(table([monthly ? 'Month' : 'Week of', 'Impressions'], rowsImpr.map((r) => [r.tip.replace(/^Week of /, ''), nf.format(r.value)]), [1]));
    lineChart($b('ch-fol'), c.followerPoints);
    $b('tb-fol').replaceChildren(table(['Date', 'Followers'], c.followerPoints.map((p) => [dLong.format(p.t), nf.format(p.value)]), [1]));
    const counts = new Map();
    for (const p of c.own) counts.set(dayKey(p.t), (counts.get(dayKey(p.t)) || 0) + 1);
    heatmap($b('ch-heat'), c.P, counts);
    bars($b('ch-themes'), [...S.themes.values()].map((t) => ({ label: t.label, pillar: t.pillar, value: c.mid.filter((p) => (p.class?.themes || []).includes(t.id)).length }))
      .filter((r) => r.value > 0 || r.pillar).sort((a, b) => b.value - a.value));
    bars($b('ch-kinds'), Object.keys(KIND).map((k) => ({ label: KIND[k], value: c.mid.filter((p) => p.kind === k).length })));
  }

  function topPosts(c, n = 5) {
    const ranked = c.withImpr.length ? [...c.withImpr].sort((a, b) => b.metrics.impressions - a.metrics.impressions) : [...c.own].sort((a, b) => eng(b) - eng(a));
    return ranked.slice(0, n);
  }
  function renderTop(c) {
    const ranked = topPosts(c);
    const topImpr = Math.max(1, ...ranked.map((p) => p.metrics.impressions || 0));
    const impBar = (v) => { const svg = s('svg', { class: 'mx-impbar', viewBox: '0 0 100 6', preserveAspectRatio: 'none', 'aria-hidden': 'true' }); svg.append(s('rect', { class: 'mx-impbar__track', x: 0, y: 0, width: 100, height: 6, rx: 3 }), s('rect', { class: 'mx-impbar__fill', x: 0, y: 0, width: Math.max(3, ((v || 0) / topImpr) * 100), height: 6, rx: 3 })); return svg; };
    $b('top-list').replaceChildren(...(ranked.length ? ranked.map((p) => {
      const impr = p.metrics.impressions;
      return h('li', null,
        h('div', null, h('a', { class: 'mx-top__text', href: p.url, target: '_blank', rel: 'noopener', text: snippet(p.text, 240) }),
          h('div', { class: 'mx-top__when', text: `${dLong.format(p.t)} · ${KIND[p.kind] || p.kind}${p.series ? ' · ' + (S.seriesById.get(p.series)?.label || '') : ''}${p.class?.local && focusOn() ? ' · ' + focusLabel() : ''}` })),
        h('div', { class: 'mx-top__stats' }, h('strong', { text: impr != null ? `${compact.format(impr)} impressions` : `${nf.format(eng(p))} engagements` }), impr ? `${pct(eng(p) / impr)} engagement` : '', impBar(impr)));
    }) : [h('li', { class: 'empty', text: 'No Midnight posts in this period yet.' })]));
  }

  /* ---------- series ---------- */
  function median(nums) {
    if (!nums.length) return null;
    const a = [...nums].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function postStats(posts) {
    const w = posts.filter((p) => p.metrics.impressions != null);
    const total = sum(w, (p) => p.metrics.impressions);
    const ts = posts.map((p) => p.t.getTime());
    return {
      n: posts.length, total, avg: w.length ? total / w.length : null, median: median(w.map((p) => p.metrics.impressions)),
      er: total ? sum(w, eng) / total : null,
      best: [...w].sort((a, b) => b.metrics.impressions - a.metrics.impressions)[0] || null,
      first: posts.length ? new Date(Math.min(...ts)) : null, last: posts.length ? new Date(Math.max(...ts)) : null,
    };
  }
  /** Series groups (best median first) and the "loose" comparison set, from a list of posts. */
  function seriesFrom(mid) {
    const groups = S.series.map((x) => ({ s: x, posts: mid.filter((p) => p.series === x.id).sort((a, b) => a.t - b.t) }))
      .filter((g) => g.posts.length).map((g) => ({ ...g, st: postStats(g.posts) }))
      .sort((a, b) => (b.st.median ?? -1) - (a.st.median ?? -1));
    const loose = postStats(mid.filter((p) => !p.series && (p.kind === 'original' || p.kind === 'quote')));
    return { groups, loose, all: postStats(groups.flatMap((g) => g.posts)) };
  }
  const ratio = (a, b) => (a != null && b ? a / b : null);
  const vsChip = (r) => (r == null ? chip({ cls: 'none', label: 'n/a' }) : chip({ cls: r >= 1.1 ? '' : r <= 0.9 ? 'out' : 'none', label: `${r.toFixed(1)}× loose` }));
  function episodeLabel(p) {
    const t = String(p.text || '');
    const m = t.match(/\b(\d{1,3})\s*\/\s*\d{1,3}\b/) || t.match(/#\s*(\d{1,4})/) || t.match(/\btrack\s*(\d{1,2})\b/i);
    return m ? (/track/i.test(m[0]) ? `T${m[1]}` : `#${m[1]}`) : null;
  }

  // Series are finite campaigns, so this section always shows every series over its full run,
  // whatever the Period menu says (the quarterly summary still lists only the period's series).
  function renderSeries() {
    const { groups, loose, all } = seriesFrom(S.posts);
    const fmtImp = (v) => (v == null ? '—' : nf.format(Math.round(v)));
    if (!groups.length) {
      $b('series-tiles').replaceChildren();
      $b('series-table').replaceChildren(h('p', { class: 'mx-empty', text: `No series posts found yet. Series tracked: ${S.series.map((x) => x.label).join(', ') || 'none defined yet'}.` }));
      $b('series-bars').replaceChildren();
      $b('series-grid').replaceChildren();
      return;
    }
    const r = ratio(all.median, loose.median);
    const tile = (label, value, extra, meta) => h('div', { class: 'db-tile' }, h('p', { class: 'db-tile__k', text: label }), h('p', { class: 'db-tile__v', text: value }), extra, h('p', { class: 'db-tile__m', text: meta }));
    $b('series-tiles').replaceChildren(
      tile('Series posts', nf.format(all.n), null, `median ${fmtImp(all.median)} impressions · ${pct(all.er)} engagement`),
      tile('Loose posts', nf.format(loose.n), null, `median ${fmtImp(loose.median)} impressions · ${pct(loose.er)} engagement`),
      tile('Series vs loose', r == null ? '—' : `${r.toFixed(1)}×`, vsChip(r), 'median impressions per post'));

    const run = (st) => (st.first ? `${dShort.format(st.first)} – ${dShort.format(st.last)}` : '—');
    const best = (st) => (st.best ? h('a', { href: st.best.url, target: '_blank', rel: 'noopener', title: st.best.text, text: `${snippet(st.best.text, 48)} (${compact.format(st.best.metrics.impressions)})` }) : '—');
    const rows = groups.map((g) => [g.s.label, nf.format(g.st.n), run(g.st), fmtImp(g.st.median), fmtImp(g.st.avg), pct(g.st.er), vsChip(ratio(g.st.median, loose.median)), best(g.st)]);
    rows.push({ cls: 'loose', cells: ['Loose posts (comparison)', nf.format(loose.n), run(loose), fmtImp(loose.median), fmtImp(loose.avg), pct(loose.er), '—', best(loose)] });
    $b('series-table').replaceChildren(table(['Series', 'Posts', 'Run', 'Median impr.', 'Avg impr.', 'Eng. rate', 'vs loose', 'Best post'], rows, [1, 3, 4, 5]));

    bars($b('series-bars'), [
      ...groups.map((g) => ({ label: g.s.label, value: Math.round(g.st.median || 0), tip: `${g.s.label}: median impressions over ${g.st.n} posts` })),
      { label: 'Loose posts', value: Math.round(loose.median || 0), tip: `Loose posts: median impressions over ${loose.n} posts`, muted: true },
    ]);

    const grid = $b('series-grid');
    grid.replaceChildren();
    const sharedMax = Math.max(1, ...groups.flatMap((g) => g.posts.map((p) => p.metrics.impressions || 0)));
    for (const g of groups) {
      const chart = h('div', { class: 'db-ep__chart', role: 'img', 'aria-label': `${g.s.label}: impressions for each post` });
      grid.append(h('div', { class: 'db-ep' }, h('h4', { text: g.s.label }), h('p', { text: `${g.st.n} posts · ${run(g.st)} · median ${fmtImp(g.st.median)}` }), chart));
    }
    requestAnimationFrame(() => {
      [...grid.querySelectorAll('.db-ep__chart')].forEach((chart, i) => {
        const g = groups[i];
        barChart(chart, g.posts.map((p) => ({
          label: episodeLabel(p) || dShort.format(p.t), value: p.metrics.impressions || 0,
          tip: `${episodeLabel(p) ? episodeLabel(p) + ' · ' : ''}${dLong.format(p.t)} · ${snippet(p.text, 60)}`, href: p.url,
        })), { max: sharedMax });
      });
    });
  }

  /* ---------- plan & report ---------- */
  function summaryText(c) {
    const P = c.P;
    const handle = S.meta.handle ? '@' + S.meta.handle : 'my account';
    const today = startOfDay(new Date());
    const lastDay = new Date(Math.min(addDays(P.end, -1).getTime(), today.getTime()));
    const totalDays = Math.round((P.end - P.start) / 864e5);
    const dayN = Math.min(totalDays, Math.round((addDays(lastDay, 1) - P.start) / 864e5));
    const line = (k) => {
      const v = kVal(k, c);
      const t = targetFor(k, P);
      const st = statusOf(k, v, t, P);
      const tt = t != null ? ` (target ${targetText(k, t, P, false)}: ${st.label.toLowerCase()})` : '';
      return `• ${kLabel(k)}: ${v == null ? 'no data yet' : kFmt(k, v)}${tt}`;
    };
    const kinds = Object.keys(KIND).filter((k) => k !== 'repost').map((k) => `${KIND[k].toLowerCase()}s ${c.own.filter((p) => p.kind === k).length}`).join(' · ');
    const sd = seriesFrom(c.mid);
    const out = [
      `Midnight on X — ${P.label} (${dLong.format(P.start)} – ${dLong.format(lastDay)}${P.calendar ? `, day ${dayN} of ${totalDays}` : ''})`,
      `Account: ${handle}`,
      '',
      line(K('midnightPosts')) + ` — ${kinds}; plus ${c.reposts.length} reposts`,
      line(K('impressions')),
      line(K('engagementRate')),
      line(K('followersNet')) + (c.folTotal != null ? `; ${nf.format(c.folTotal)} total followers` : '') + (focusOn() ? ` (X does not attribute follows to ${focusShort()} content)` : ''),
      ...(focusOn() ? [line(K('localShare'))] : []),
      `• Share of voice: ${pct(c.sov, 0)} of all posts were Midnight-related`,
      ...sd.groups.map((g) => {
        const r = ratio(g.st.median, sd.loose.median);
        return `• Series, ${g.s.label}: ${g.st.n} posts, median ${g.st.median == null ? 'n/a' : nf.format(Math.round(g.st.median))} impressions${r != null ? ` (${r.toFixed(1)}× loose posts)` : ''}`;
      }),
      line(K('midnightMentions')),
    ];
    const top = topPosts(c, 1)[0];
    if (top) out.push('', `Top post: "${snippet(top.text, 140)}" — ${top.metrics.impressions != null ? nf.format(top.metrics.impressions) + ' impressions, ' + pct(eng(top) / top.metrics.impressions) + ' engagement' : nf.format(eng(top)) + ' engagements'} — ${top.url}`);
    const asOf = S.meta.lastRun?.at ? zoneLong.format(new Date(S.meta.lastRun.at)) : 'n/a';
    out.push('', `Source: X API v2, refreshed daily (data as of ${asOf}). Engagement rate = (likes + replies + reposts + quotes) ÷ impressions.`);
    if (S.meta.demo) out.unshift('[DEMO DATA — not real results]');
    return out.join('\n');
  }

  function renderPlan(c) {
    const P = c.P;
    $b('plan-hint').textContent = P.calendar
      ? `Targets for ${P.label} come from plan.json (${P.group === 'Years' ? '"years"' : '"quarters"'}). Counts are judged against pace: the share of the target expected by today.`
      : 'Targets apply to quarter and year views. Pick one in the Period menu to compare against them.';
    $b('report-targets').replaceChildren(table(['KPI', 'Target', 'Actual', 'Status'], activeKpis().filter((k) => k.type !== 'info').map((k) => {
      const v = kVal(k, c);
      const t = targetFor(k, P);
      return [kLabel(k), targetText(k, t, P), v == null ? '—' : kFmt(k, v), chip(statusOf(k, v, t, P))];
    }), [2]));
    $b('summary').textContent = summaryText(c);
    $b('copy').textContent = P.group === 'Years' ? 'Copy yearly summary' : P.group === 'Quarters' ? 'Copy quarterly summary' : 'Copy summary';

    const focus = planEntry(P)?.focus || [];
    $b('report-focus').replaceChildren(...(focus.length ? focus.map((f) => h('li', { text: f })) : [h('li', { text: 'No focus notes for this period. Add "focus" to the quarter or year in plan.json.' })]));

    const today = dayKey(new Date());
    const horizon = dayKey(addDays(new Date(), 45));
    const sk = dayKey(P.start);
    const ek = dayKey(P.end);
    const items = (S.plan.calendar || []).filter((i) => (i.date >= sk && i.date < ek) || (i.date >= today && i.date <= horizon)).sort((a, b) => (a.date < b.date ? -1 : 1));
    const calRows = items.map((i) => {
      const overdue = i.date < today && i.status !== 'done';
      return [
        h('span', { class: overdue ? 'overdue' : null, text: dShort.format(new Date(i.date + 'T12:00')) + (overdue ? ' · overdue' : '') }),
        i.link ? h('a', { href: i.link, target: '_blank', rel: 'noopener', text: i.title }) : i.title,
        i.pillar ? h('span', { class: 'mx-pill', title: `Pillar ${i.pillar}`, text: `P${i.pillar}` }) : '—',
        h('span', { class: 'mx-cal-status', text: i.status || 'idea' }),
      ];
    });
    $b('report-calendar').replaceChildren(calRows.length ? table(['Date', 'Item', 'Pillar', 'Status'], calRows) : h('p', { class: 'db-status', text: 'Nothing scheduled. Add items to "calendar" in plan.json.' }));
  }

  /* ---------- the post explorer ---------- */
  const themeText = (p) => (p.class?.themes || []).map((t) => S.themes.get(t)?.label || t).join(', ');
  const erOf = (p) => (p.metrics.impressions ? eng(p) / p.metrics.impressions : null);
  const COLS = [
    { key: 'date', label: 'Date', first: 'desc', value: (p) => p.t.getTime() },
    { key: 'post', label: 'Post', first: 'asc', value: (p) => String(p.text || '').trim() },
    { key: 'type', label: 'Type', first: 'asc', value: (p) => KIND[p.kind] || p.kind },
    { key: 'themes', label: 'Themes', first: 'asc', value: (p) => themeText(p) },
    { key: 'impr', label: 'Impr.', first: 'desc', n: true, value: (p) => p.metrics.impressions },
    { key: 'er', label: 'Eng. rate', first: 'desc', n: true, value: erOf },
  ];
  function filtered(c) {
    const root = $b('app');
    const q = root.querySelector('.app__search').value.trim().toLowerCase();
    const f = (name) => root.querySelector(`[data-filter="${name}"]`);
    const th = f('theme').value; const kd = f('kind').value; const se = f('series').value;
    const loc = f('local').checked; const rev = f('review').checked;
    const col = COLS.find((x) => x.key === app.sort.key) || COLS[0];
    const sign = app.sort.dir === 'asc' ? 1 : -1;
    return c.mid.filter((p) => (!q || p.text.toLowerCase().includes(q)) && (!th || (p.class?.themes || []).includes(th)) && (!kd || p.kind === kd)
      && (!se || (se === '__any' ? p.series : se === '__loose' ? !p.series : p.series === se)) && (!loc || p.class?.local) && (!rev || p.class?.review))
      .sort((a, b) => {
        const va = col.value(a); const vb = col.value(b);
        if (va == null && vb != null) return 1; // empty values always last
        if (vb == null && va != null) return -1;
        const d = va == null ? 0 : typeof va === 'string' ? va.localeCompare(vb, 'en', { sensitivity: 'base' }) : va - vb;
        return d !== 0 ? d * sign : b.t - a.t; // ties: newest first
      });
  }
  function renderApp(c) {
    const posts = filtered(c);
    const pages = Math.max(1, Math.ceil(posts.length / ROWS_PER_PAGE));
    app.page = Math.min(app.page, pages - 1);
    const shown = posts.slice(app.page * ROWS_PER_PAGE, (app.page + 1) * ROWS_PER_PAGE);
    if (!app.selected || !posts.includes(app.selected)) app.selected = shown[0] || null;

    $b('app-cols').replaceChildren(...COLS.map((col) => {
      const on = col.key === app.sort.key;
      return h('button', { type: 'button', class: col.n ? 'n' : null, 'aria-pressed': on ? 'true' : 'false', 'data-sort': col.key, title: `Sort by ${col.label}`, onclick: () => {
        app.sort = on ? { key: col.key, dir: app.sort.dir === 'asc' ? 'desc' : 'asc' } : { key: col.key, dir: col.first };
        app.page = 0; renderApp(compute(current));
        $b('app-cols').querySelector(`[data-sort="${col.key}"]`)?.focus();
      } }, col.label, h('span', { class: 'arrow', 'aria-hidden': 'true', text: on ? (app.sort.dir === 'asc' ? '▲' : '▼') : '↕' }));
    }));
    const pick = (p) => { app.selected = p; renderApp(compute(current)); };
    $b('app-rows').replaceChildren(...(shown.length ? shown.map((p) => {
      const impr = p.metrics.impressions;
      return h('li', {
        class: 'app__row', tabindex: 0, role: 'button', 'aria-selected': p === app.selected ? 'true' : 'false', 'aria-label': `${dShort.format(p.t)}: ${snippet(p.text, 80)}`,
        onclick: () => pick(p), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(p); } },
      },
      h('span', { class: 'd', text: dShort.format(p.t) }),
      h('span', { class: 't' }, snippet(p.text, 220), p.series ? h('span', { class: 'mx-pill mx-pill--series', text: S.seriesById.get(p.series)?.label || p.series }) : null, owner && p.class?.review ? h('span', { class: 'flag', text: ' · needs review' }) : null),
      h('span', { class: 'k', text: KIND[p.kind] || p.kind }),
      h('span', { class: 'th', title: themeText(p), text: themeText(p) + (p.class?.local && focusOn() ? ' · ' + focusShort() : '') }),
      h('span', { class: 'n', text: impr == null ? '—' : nf.format(impr) }),
      h('span', { class: 'n', text: impr ? pct(eng(p) / impr) : '—' }));
    }) : [h('li', { class: 'app__row app__row--empty', text: 'No posts match these filters.' })]));
    $b('app-count').textContent = `${nf.format(posts.length)} post${posts.length === 1 ? '' : 's'}`;
    $b('app-page').textContent = `${app.page + 1} of ${pages}`;
    const root = $b('app');
    root.querySelector('.app__pg[data-page="prev"]').disabled = app.page === 0;
    root.querySelector('.app__pg[data-page="next"]').disabled = app.page >= pages - 1;

    const open = $b('app-open');
    const p = app.selected;
    if (!p) { open.replaceChildren(h('p', { class: 'app-open__why', text: 'Pick a post to see its numbers.' })); return; }
    const impr = p.metrics.impressions;
    const stat = (k, v) => h('div', null, h('dt', { text: k }), h('dd', { text: v }));
    open.replaceChildren(
      h('div', { class: 'app-open__meta' }, h('span', { class: 'mx-tag', text: dLong.format(p.t) }), h('span', { class: 'mx-tag', text: KIND[p.kind] || p.kind }),
        p.series ? h('span', { class: 'mx-tag', text: S.seriesById.get(p.series)?.label }) : null, p.class?.local && focusOn() ? h('span', { class: 'mx-tag', text: focusLabel() }) : null,
        owner && p.class?.review ? h('span', { class: 'mx-tag', text: 'Needs review' }) : null),
      h('p', { class: 'app-open__text', text: p.text }),
      h('dl', { class: 'app-open__stats' }, stat('Impressions', impr == null ? '—' : nf.format(impr)), stat('Engagement', impr ? pct(eng(p) / impr) : '—'),
        stat('Likes', nf.format(p.metrics.likes || 0)), stat('Replies', nf.format(p.metrics.replies || 0)), stat('Reposts', nf.format(p.metrics.reposts || 0)),
        stat('Quotes', nf.format(p.metrics.quotes || 0)), stat('Bookmarks', p.metrics.bookmarks == null ? '—' : nf.format(p.metrics.bookmarks)),
        owner ? stat('Link clicks', p.private?.link_clicks == null ? '—' : nf.format(p.private.link_clicks)) : null),
      h('p', { class: 'app-open__why', text: `Matched: ${(p.class?.reasons || []).join(', ') || 'manual include'}. Themes: ${themeText(p) || '—'}.` }),
      h('a', { class: 'app-open__link', href: p.url, target: '_blank', rel: 'noopener', text: 'Open the post on X →' }));
  }
  function setupApp() {
    const root = $b('app');
    const f = (name) => root.querySelector(`[data-filter="${name}"]`);
    f('theme').replaceChildren(h('option', { value: '', text: 'All themes' }), ...[...S.themes.values()].map((t) => h('option', { value: t.id, text: t.label })));
    f('kind').replaceChildren(h('option', { value: '', text: 'All types' }), ...Object.entries(KIND).map(([k, v]) => h('option', { value: k, text: v })));
    f('series').replaceChildren(h('option', { value: '', text: 'All posts' }), h('option', { value: '__any', text: 'In a series' }), h('option', { value: '__loose', text: 'Not in a series' }), ...S.series.map((x) => h('option', { value: x.id, text: x.label })));
    root.querySelector('.app__search').addEventListener('input', () => { app.page = 0; renderApp(compute(current)); });
    for (const name of ['theme', 'kind', 'series', 'local', 'review']) f(name).addEventListener('change', () => { app.page = 0; renderApp(compute(current)); });
    root.querySelector('.app__pg[data-page="prev"]').addEventListener('click', () => { app.page = Math.max(0, app.page - 1); renderApp(compute(current)); });
    root.querySelector('.app__pg[data-page="next"]').addEventListener('click', () => { app.page += 1; renderApp(compute(current)); });
  }

  /* ---------- builders (builders.json, edited by hand or through the form below) ---------- */
  const safeUrl = (v) => {
    v = String(v || '').trim();
    if (!v) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v;
    try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; } catch { return null; }
  };
  // a handle or username, from "@name", "name" or a profile link on that site
  const handleOf = (v) => {
    v = String(v || '').trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v) || /^[\w.-]+\.[a-z]{2,}\//i.test(v)) {
      try { v = new URL(/^https?:/i.test(v) ? v : 'https://' + v).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; }
    }
    v = v.replace(/^@/, '');
    return /^[A-Za-z0-9_.-]{1,39}$/.test(v) ? v : '';
  };
  // Discord: an invite or profile link on a Discord domain, or a plain username ('' empty, null not valid)
  const discordOf = (v) => {
    v = String(v || '').trim();
    if (!v) return '';
    if (/^(https?:\/\/)?([\w-]+\.)*(discord\.gg|discord\.com|discordapp\.com)\//i.test(v)) return safeUrl(v);
    if (/^https?:\/\//i.test(v)) return null;
    const n = v.replace(/^@/, '');
    return /^[A-Za-z0-9_.]{2,32}(#\d{4})?$/.test(n) ? n : null;
  };
  const LINKS = [
    { key: 'userX', name: 'X profile', handle: true, url: (x) => `https://x.com/${x}`, label: (x) => '@' + x, icon: 'assets/icons/x.svg' },
    { key: 'projectX', name: 'Project on X', handle: true, url: (x) => `https://x.com/${x}`, label: (x) => `Project @${x}`, icon: 'assets/icons/x.svg' },
    { key: 'github', name: 'GitHub', handle: true, url: (x) => `https://github.com/${x}`, label: (x) => x, icon: 'assets/icons/github.svg' },
    { key: 'linkedin', name: 'LinkedIn', label: () => 'LinkedIn' },
    { key: 'website', name: 'Website', label: (u) => new URL(u).hostname.replace(/^www\./, '') },
    { key: 'discord', name: 'Discord', discord: true },
    { key: 'youtube', name: 'YouTube', label: () => 'YouTube' },
  ];
  function normBuilders(file) {
    return (Array.isArray(file?.builders) ? file.builders : []).filter((b) => b && String(b.name || '').trim())
      .map((b) => ({ ...b, name: String(b.name).trim(), t: /^\d{4}-\d{2}-\d{2}$/.test(b.since || '') ? new Date(b.since + 'T12:00') : null }))
      .sort((a, b) => (b.t || 0) - (a.t || 0) || a.name.localeCompare(b.name));
  }
  const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0].toUpperCase()).join('') || '?';
  function linkChips(links) {
    return LINKS.map((L) => {
      const raw = links?.[L.key] ?? (L.key === 'userX' ? links?.x : undefined);
      if (!raw) return null;
      if (L.discord) {
        const d = discordOf(raw);
        if (!d) return null;
        if (/^https?:/i.test(d)) return h('a', { class: 'db-link', href: d, target: '_blank', rel: 'noopener nofollow', title: `Discord: ${d}` }, h('span', { text: 'Discord' }));
        // a username has no public link, so the chip copies it
        const txt = h('span', { text: `Discord: ${d}` });
        return h('button', { type: 'button', class: 'db-link', title: 'Copy the Discord username', onclick: () => {
          navigator.clipboard?.writeText(d).then(() => { txt.textContent = 'Copied'; setTimeout(() => { txt.textContent = `Discord: ${d}`; }, 1200); }).catch(() => {});
        } }, txt);
      }
      let url; let label;
      if (L.handle) { const x = handleOf(raw); if (!x) return null; url = L.url(x); label = L.label(x); } else { url = safeUrl(raw); if (!url) return null; label = L.label(url); }
      return h('a', { class: 'db-link', href: url, target: '_blank', rel: 'noopener nofollow', title: `${L.name}: ${url}` },
        L.icon ? h('img', { src: L.icon, alt: '', width: 14, height: 14 }) : null, h('span', { text: label }));
    }).filter(Boolean);
  }
  function renderBuilders(c) {
    const all = S.builders;
    const inP = all.filter((b) => b.t && b.t >= c.P.start && b.t < c.P.end).length;
    $b('builders-sub').textContent = all.length ? `People helped to get started building · ${nf.format(all.length)} listed${inP ? ` · ${nf.format(inP)} started in ${c.P.label}` : ''}` : 'People helped to get started building';
    const el = $b('builders');
    const toggle = $b('mq-toggle');
    if (!all.length) {
      toggle.hidden = true;
      el.replaceChildren(h('div', { class: 'db-builders__empty' }, h('b', { text: 'No builders listed yet.' }), owner ? ' Use Add a builder to showcase someone you have helped get started.' : null));
      return;
    }
    // one tile per builder, never repeated to fill space; the line moves only when they don't all fit across the strip
    const tile = (b, copy) => h('button', { type: 'button', class: 'db-tile-b', 'aria-hidden': copy ? 'true' : null, tabindex: copy ? -1 : null, 'aria-label': copy ? null : `${b.name}: open the profile`, onclick: () => openProfile(b) },
      builderBanner(b),
      h('span', { class: 'db-tile-b__meta' }, b.stage ? h('span', { class: 'mx-chip', text: String(b.stage) }) : null, b.t ? h('span', { text: `Since ${dShort.format(b.t)} ${b.t.getFullYear()}` }) : null),
      b.building ? h('span', { class: 'db-tile-b__what', text: String(b.building) }) : null);
    const set = h('div', { class: 'db-mq__set' }, all.map((b) => tile(b, false)));
    const track = h('div', { class: 'db-mq__track' }, set);
    const strip = h('div', { class: 'db-mq', role: 'region', 'aria-label': 'Builders, moving line' }, track);
    el.replaceChildren(strip);
    toggle.hidden = true;
    strip.classList.toggle('is-paused', toggle.getAttribute('aria-pressed') === 'true');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return; // stands still; swipe to see the rest
    requestAnimationFrame(() => {
      const cs = getComputedStyle(strip);
      const room = strip.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const need = set.scrollWidth - parseFloat(getComputedStyle(set).paddingRight);
      if (need <= room) return; // they all fit: a still row
      // too many to fit: one hidden copy follows the real tiles so the loop has no gap
      const copy = set.cloneNode(false);
      all.forEach((b) => copy.append(tile(b, true)));
      copy.setAttribute('aria-hidden', 'true');
      track.append(copy);
      toggle.hidden = false;
      const shift = set.getBoundingClientRect().width;
      track.style.setProperty('--mq-shift', `${shift}px`);
      track.style.setProperty('--mq-dur', `${Math.max(18, shift / 38).toFixed(1)}s`);
      strip.classList.add('is-moving');
    });
  }

  // the card's banner: the picture of their website taken by the Builder previews workflow, with their name on it
  function builderBanner(b, big) {
    const site = safeUrl(b.links?.website);
    const pv = S.previews?.[b.name.toLowerCase()];
    const img = pv && pv.file && site && pv.url === site ? `${pv.file}?v=${encodeURIComponent(pv.takenAt || '')}` : null;
    const host = site ? new URL(site).hostname.replace(/^www\./, '') : null;
    return h('span', { class: 'db-bb' + (img ? ' db-bb--img' : '') + (big ? ' db-bb--big' : '') },
      img ? h('img', { src: img, alt: '', loading: 'lazy', decoding: 'async' }) : h('img', { class: 'db-bb__logo', src: 'assets/brand/midnight-logo-white.svg', alt: '', decoding: 'async' }),
      h('span', { class: 'db-bb__name' }, h(big ? 'h3' : 'span', { class: 'db-bb__title', id: big ? 'pf-name' : null, text: b.name }), host ? h('span', { class: 'db-bb__host', text: host }) : null));
  }

  function openProfile(b) {
    const dlg = $b('profile-dialog');
    const site = safeUrl(b.links?.website);
    const chips = linkChips(b.links);
    $b('profile-body').replaceChildren(
      builderBanner(b, true),
      h('div', { class: 'db-pf' },
        h('p', { class: 'db-builder__meta' }, b.t ? `Started building ${dLong.format(b.t)}` : null, b.stage ? h('span', { class: 'mx-chip', text: String(b.stage) }) : null),
        b.building ? h('p', { class: 'db-builder__what', text: `Building ${String(b.building)}` }) : null,
        b.note ? h('div', { class: 'db-pf__note' }, h('span', { text: 'How I helped' }), h('p', { text: String(b.note) })) : null,
        chips.length ? h('div', { class: 'db-builder__links' }, chips) : h('p', { class: 'db-status', text: 'No links added yet.' }),
        h('div', { class: 'db-form__foot' },
          site ? h('a', { class: 'db-btn', href: site, target: '_blank', rel: 'noopener nofollow', text: 'Visit the website ↗' }) : null,
          h('button', { type: 'button', class: 'db-btn db-btn--ghost', text: 'Close', autofocus: true, onclick: () => dlg.close() }))));
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function setupBuilderStrip() {
    const toggle = $b('mq-toggle');
    toggle.addEventListener('click', () => {
      const paused = toggle.getAttribute('aria-pressed') !== 'true';
      toggle.setAttribute('aria-pressed', paused ? 'true' : 'false');
      toggle.textContent = paused ? 'Play' : 'Pause';
      document.querySelector('.db-mq')?.classList.toggle('is-paused', paused);
    });
    const dlg = $b('profile-dialog');
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // a click on the backdrop closes it
  }

  /* ---------- owner mode and GitHub ---------- */
  // The owner signs in once per browser with a fine-grained GitHub key limited to the dashboard's repository
  // (Contents: read and write). It is stored in localStorage, sent only to api.github.com, and never written into a
  // file. With it the page reads every file from the repository (a private one too) and the Add a builder form
  // commits builders.json itself. Everyone else gets the view-only page: no targets, link clicks, spend or controls.
  const GH_KEY = 'mx-gh-token';
  let bootRepo = ''; // config.json "repo", read before the data loads
  let ownerNote = ''; // why a saved key didn't give owner mode, shown in the footer
  // owner/repo: from config.json, else read from the GitHub Pages address (owner.github.io/repo/)
  const repoGuess = () => {
    const host = location.hostname.toLowerCase();
    if (!host.endsWith('.github.io')) return '';
    const first = location.pathname.split('/').filter(Boolean)[0];
    return `${host.slice(0, -'.github.io'.length)}/${first || host}`;
  };
  const repoName = () => (S && S.config && S.config.repo) || bootRepo || repoGuess();
  const ghToken = () => store.get(GH_KEY) || '';
  const forgetKey = () => { try { localStorage.removeItem(GH_KEY); } catch { /* storage unavailable */ } };
  const b64ToText = (b64) => new TextDecoder().decode(Uint8Array.from(atob(String(b64).replace(/\s+/g, '')), (ch) => ch.charCodeAt(0)));
  const textToB64 = (txt) => {
    const bytes = new TextEncoder().encode(txt);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  async function gh(path, token, opts = {}) {
    const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const r = await fetch(`https://api.github.com/repos/${repoName()}${path}`, { ...opts, headers, cache: 'no-store' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(body.message || `HTTP ${r.status}`), { status: r.status });
    return body;
  }
  // one file from the repository through the API, parsed as JSON (works on a private repository)
  async function ghFile(path) {
    const r = await fetch(`https://api.github.com/repos/${repoName()}/contents/${path}?ref=main`, {
      headers: { Accept: 'application/vnd.github.raw+json', Authorization: `Bearer ${ghToken()}`, 'X-GitHub-Api-Version': '2022-11-28' }, cache: 'no-cache',
    });
    if (!r.ok) throw Object.assign(new Error(`${path} → GitHub HTTP ${r.status}`), { status: r.status });
    return r.json();
  }
  const canWrite = (repo) => !repo.permissions || !!(repo.permissions.push || repo.permissions.admin);
  // owner mode: this browser holds a key that GitHub accepts for changing the repository
  async function checkOwner() {
    owner = false;
    ownerNote = '';
    const token = ghToken();
    if (token) {
      try {
        if (!S) bootRepo = (await fetch('config.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => ({}))).repo || '';
        if (repoName()) owner = canWrite(await gh('', token));
        if (!owner) ownerNote = `Your saved GitHub key can't change ${repoName()}, so this is the public view.`;
      } catch (e) {
        if (e.status === 401) { forgetKey(); ownerNote = 'GitHub no longer accepts your saved key (it may have expired), so this is the public view.'; }
        else ownerNote = e.status === 403 || e.status === 404 ? `Your saved GitHub key can't open ${repoName()}, so this is the public view.` : "GitHub didn't answer, so this is the public view. Reload to try again.";
      }
    }
    document.documentElement.classList.toggle('is-owner', owner);
    return owner;
  }
  function openOwner() {
    const dlg = $b('owner-dialog');
    const form = $b('owner-form');
    const [who, repo] = repoName().split('/');
    form.reset();
    $b('owner-error').textContent = '';
    $b('owner-repo').textContent = repo || "this dashboard's repository";
    $b('owner-new').href = 'https://github.com/settings/personal-access-tokens/new?' + new URLSearchParams({
      name: 'Leader dashboard owner', description: `Lets the dashboard show its owner-only numbers and save builders in ${repoName()}.`,
      target_name: who || '', expires_in: '366', contents: 'write',
    });
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    form.elements.ghtoken.focus();
  }
  const signOut = () => { forgetKey(); location.reload(); };
  function setupOwner() {
    const dlg = $b('owner-dialog');
    const form = $b('owner-form');
    const err = $b('owner-error');
    const go = $b('owner-go');
    $b('owner-close').addEventListener('click', () => (dlg.close ? dlg.close() : dlg.removeAttribute('open')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (go.disabled) return;
      const token = String(form.elements.ghtoken.value || '').replace(/\s+/g, '');
      err.textContent = '';
      if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) { err.textContent = "That GitHub key doesn't look right. Copy it again from GitHub."; form.elements.ghtoken.focus(); return; }
      if (!repoName()) { err.textContent = 'This copy has no repository set ("repo" in config.json), so there is nothing to sign in to.'; return; }
      go.disabled = true;
      go.textContent = 'Checking…';
      try {
        if (!canWrite(await gh('', token))) throw Object.assign(new Error('read only'), { status: 403 });
        store.set(GH_KEY, token); // kept only once GitHub has accepted it
        location.reload(); // start again in owner mode
      } catch (e2) {
        err.textContent = e2.status === 401 ? 'GitHub did not accept that key. Make a new one and paste it here.'
          : e2.status === 403 || e2.status === 404 ? `That key can't change ${repoName()}. Make a new one with access to that repository and Contents set to Read and write.`
          : `Could not reach GitHub (${e2.message}). Check the connection and try again.`;
        go.disabled = false;
        go.textContent = 'Sign in';
      }
    });
  }
  const ghProblem = (e) => (e.status === 401 ? 'GitHub did not accept your key. It may have expired: reload the page and use Owner sign-in at the bottom to add a new one.'
    : e.status === 403 || e.status === 404 ? `Your key can't change files in ${repoName()}. Sign in again with a key that has Contents set to Read and write for that repository.`
    : e.status === 409 || e.status === 422 ? 'builders.json changed on GitHub at the same moment. Press Add the builder again.'
    : e.status === 0 ? e.message
    : `Could not reach GitHub (${e.message}). Check the connection and try again.`);
  const sameBuilder = (a, b) => String(a.name || '').trim().toLowerCase() === String(b.name || '').trim().toLowerCase();
  const bySince = (a, b) => String(b.since || '').localeCompare(String(a.since || '')) || String(a.name).localeCompare(String(b.name));
  const readBuildersFile = async (token) => {
    const cur = await gh('/contents/builders.json?ref=main', token);
    try { return { sha: cur.sha, file: JSON.parse(b64ToText(cur.content)) }; } catch { throw Object.assign(new Error('builders.json on GitHub is not valid JSON, so nothing was changed. Fix it on GitHub first.'), { status: 0 }); }
  };
  // adds or replaces (same name) one builder in builders.json on GitHub; that commit starts the Builder previews workflow
  async function commitBuilder(entry, token) {
    for (let attempt = 1; ; attempt++) {
      const { sha, file } = await readBuildersFile(token);
      const list = Array.isArray(file.builders) ? file.builders : [];
      const updated = list.some((b) => sameBuilder(b, entry));
      const next = { ...file, builders: [...list.filter((b) => !sameBuilder(b, entry)), entry].sort(bySince) };
      try {
        await gh('/contents/builders.json', token, { method: 'PUT', body: JSON.stringify({ message: `builders: ${updated ? 'update' : 'add'} ${entry.name}`, content: textToB64(JSON.stringify(next, null, 2) + '\n'), sha, branch: 'main' }) });
        return { file: next, updated };
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 3) continue; // someone else committed in between: read again
        throw e;
      }
    }
  }
  const setBuilders = (file) => { S.buildersFile = file; S.builders = normBuilders(file); renderBuilders(compute(current)); };
  // the website picture arrives with the Builder previews workflow's commit, a minute or two after the builder;
  // the owner's page reads it from the repository, before the public site has it
  let picWatch = null;
  function watchPicture(name, site) {
    if (picWatch) clearInterval(picWatch);
    const key = name.toLowerCase();
    const until = Date.now() + 8 * 60e3;
    const status = $b('builders-status');
    const tick = async () => {
      if (Date.now() > until) { clearInterval(picWatch); picWatch = null; status.textContent = `${name} is added. The picture of their website isn't published yet: it shows the next time you open the page (or see Builder previews under Actions on GitHub).`; return; }
      try {
        const pv = owner ? await ghFile('data/builder-previews.json') : await fetch(`data/builder-previews.json?t=${Date.now()}`, { cache: 'no-store' }).then((r) => r.json());
        const e = pv && pv[key];
        if (!e || e.url !== site) return;
        clearInterval(picWatch);
        picWatch = null;
        S.previews = pv;
        renderBuilders(compute(current));
        status.textContent = e.file ? `${name} is added, with the picture of their website.` : `${name} is added. Their website didn't load for a picture, so the card keeps the Midnight logo.`;
      } catch { /* try again on the next tick */ }
    };
    picWatch = setInterval(tick, 20e3);
  }

  function setupBuilderForm() {
    const dlg = $b('builder-dialog');
    const form = $b('builder-form');
    const err = $b('builder-error');
    const save = $b('builder-save');
    const close = () => (dlg.close ? dlg.close() : dlg.removeAttribute('open'));
    const reset = () => { form.reset(); form.elements.since.value = dayKey(new Date()); err.textContent = ''; save.disabled = false; save.textContent = 'Add the builder'; };
    $b('builder-add').addEventListener('click', () => { reset(); if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); form.elements.name.focus(); });
    $b('builder-close').addEventListener('click', close);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!S || save.disabled) return;
      const f = form.elements;
      const v = (n) => String(f[n].value || '').trim();
      const fail = (msg, field) => { err.textContent = msg; if (field) f[field].focus(); };
      err.textContent = '';
      if (!v('name')) return fail('Add their name.', 'name');
      const links = {};
      for (const [k, n] of [['userX', 'user X handle'], ['projectX', 'project X handle'], ['github', 'GitHub username']]) {
        if (!v(k)) continue;
        const x = handleOf(v(k));
        if (!x) return fail(`That ${n} doesn't look right.`, k);
        links[k] = x;
      }
      for (const [k, n] of [['linkedin', 'LinkedIn link'], ['website', 'website link'], ['youtube', 'YouTube link']]) {
        if (!v(k)) continue;
        const u = safeUrl(v(k));
        if (!u) return fail(`That ${n} doesn't look right.`, k);
        links[k] = u;
      }
      if (v('discord')) {
        const d = discordOf(v('discord'));
        if (!d) return fail("That Discord invite link or username doesn't look right.", 'discord');
        links.discord = d;
      }
      const token = ghToken();
      if (!owner || !token) return fail('Sign in as the owner first: Owner sign-in is at the bottom of the page.');

      const entry = { name: v('name') };
      if (v('since')) entry.since = v('since');
      if (v('stage')) entry.stage = v('stage');
      if (v('building')) entry.building = v('building');
      if (v('note')) entry.note = v('note');
      if (Object.keys(links).length) entry.links = links;

      save.disabled = true;
      save.textContent = 'Adding…';
      try {
        const res = await commitBuilder(entry, token);
        setBuilders(res.file);
        close();
        const site = safeUrl(links.website);
        $b('builders-status').textContent = `${res.updated ? 'Updated' : 'Added'} ${entry.name}. Visitors see it in a minute or two${site ? ', and the picture of their website follows a few minutes later.' : '.'}`;
        if (site) watchPicture(entry.name, site);
      } catch (e2) {
        if (e2.status === 401) forgetKey();
        fail(ghProblem(e2));
      } finally {
        save.disabled = false;
        save.textContent = 'Add the builder';
      }
    });
  }

  /* ---------- refresh: reload the saved data now, or watch for a new X fetch ---------- */
  let watch = null;
  function fillPeriods(selects) {
    const groups = [...new Set(list.map((p) => p.group))];
    for (const sel of selects) sel.replaceChildren(...groups.map((g) => h('optgroup', { label: g }, list.filter((p) => p.group === g).map((p) => h('option', { value: p.key, text: p.label })))));
  }
  async function reloadData() {
    const fresh = await load(true);
    const before = S.meta.lastRun?.at || '';
    const keep = current.key;
    S = fresh;
    list = periods();
    const selects = [...document.querySelectorAll('select.js-period')];
    fillPeriods(selects);
    current = list.find((p) => p.key === keep) || list[0];
    selects.forEach((sel) => { sel.value = current.key; });
    renderChrome();
    renderSeries();
    render();
    return (S.meta.lastRun?.at || '') !== before;
  }
  const runStamp = () => (S.meta.lastRun?.at ? zoneStamp(new Date(S.meta.lastRun.at)) : 'not yet');
  function stopWatch(msg) {
    if (watch) clearInterval(watch.timer);
    watch = null;
    $b('refresh-btn').classList.remove('is-watching');
    if (msg) $b('refresh-status').textContent = msg;
  }
  async function checkWatch() {
    if (!watch || watch.busy) return;
    if (Date.now() > watch.until) { stopWatch('No new data after 15 minutes. Check the run under Actions on GitHub, then press Reload the latest data.'); return; }
    watch.busy = true;
    try {
      const m = owner ? await ghFile('data/meta.json') : await fetch(`data/meta.json?t=${Date.now()}`, { cache: 'no-store' }).then((r) => r.json());
      if ((m.lastRun?.at || '') !== watch.since) { await reloadData(); stopWatch(`New data loaded: refreshed ${runStamp()}.`); }
    } catch { /* try again on the next check */ } finally { if (watch) watch.busy = false; }
  }
  function startWatch() {
    if (!S) return;
    if (watch) clearInterval(watch.timer);
    watch = { since: S.meta.lastRun?.at || '', until: Date.now() + 15 * 60e3, timer: setInterval(checkWatch, 30e3), busy: false };
    $b('refresh-btn').classList.add('is-watching');
    $b('refresh-status').textContent = 'Watching for new data. Run the workflow on GitHub and keep this tab open.';
  }
  function setupRefresh() {
    const btn = $b('refresh-btn');
    const pop = $b('refresh-panel');
    const status = $b('refresh-status');
    const open = (on) => { pop.hidden = !on; btn.setAttribute('aria-expanded', on ? 'true' : 'false'); };
    btn.addEventListener('click', (e) => { e.stopPropagation(); open(pop.hidden); });
    document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) open(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { open(false); btn.focus(); } });
    const reload = $b('reload');
    reload.addEventListener('click', async () => {
      if (!S) return;
      reload.disabled = true;
      btn.classList.add('is-busy');
      status.textContent = 'Loading…';
      try { const changed = await reloadData(); status.textContent = changed ? `Loaded newer data: refreshed ${runStamp()}.` : `Already up to date: refreshed ${runStamp()}.`; }
      catch (err) { status.textContent = `Could not reload the data (${err.message}).`; }
      finally { reload.disabled = false; btn.classList.remove('is-busy'); }
    });
    $b('fetch-x').addEventListener('click', startWatch);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && watch) checkWatch(); });
  }

  /* ---------- chrome: header line, banners, footer ---------- */
  function renderChrome() {
    const m = S.meta;
    const handle = m.handle || S.config.handle;
    const sub = $b('sub');
    sub.replaceChildren();
    if (handle && !m.demo) sub.append(h('a', { href: `https://x.com/${handle}`, target: '_blank', rel: 'noopener', text: '@' + handle }), ' · ');
    const profile = S.config.profile || {};
    const against = profile.framework || (owner ? 'the targets in plan.json' : '');
    sub.append(`Midnight-related posts and X KPIs, refreshed daily from the X API${against ? ` and tracked against ${against}` : ''}.`);
    $b('brand-sub').textContent = [profile.role, profile.area].filter(Boolean).join(' · ') || 'KPI dashboard';
    const [hh, mm] = String(S.config.refreshUtc || '04:15').split(':').map(Number);
    const daily = new Date(Date.UTC(2026, 0, 15, hh || 0, mm || 0));
    $b('refresh-hint').textContent = `Loads the newest numbers already saved by the daily ${zoneTime.format(daily)} ${zoneLabel} refresh.`;
    $b('focus-filter').hidden = !focusOn();
    $b('focus-filter-label').textContent = focusLabel();

    const at = m.lastRun?.at ? new Date(m.lastRun.at) : null;
    $$b('refresh-short').forEach((el) => { el.textContent = at ? zoneStamp(at) : 'not yet'; });
    const repoUrl = `https://github.com/${repoName()}`;
    $b('fetch-x').href = `${repoUrl}/actions/workflows/refresh.yml`;
    $b('fetch-cost').textContent = owner && m.lastRun?.estCostUSD != null ? `The last run (${m.lastRun.mode}) cost about $${Number(m.lastRun.estCostUSD).toFixed(2)} of X API credit.` : '';

    const banner = $b('banner');
    banner.replaceChildren();
    banner.hidden = true;
    if (m.demo) {
      banner.append(h('strong', { text: 'Demo data. ' }), 'Everything below is synthetic sample data. The first real refresh replaces it.');
      banner.hidden = false;
    } else if (at && Date.now() - at > 3 * 864e5) {
      const days = Math.floor((Date.now() - at) / 864e5);
      banner.append(h('strong', { text: `Data is ${days} days old.` }), owner ? ' Check the "Refresh X data" job under the repo\'s Actions tab.' : null);
      banner.hidden = false;
    }

    const month = new Date().toISOString().slice(0, 7);
    const spend = m.costByMonth?.[month];
    const repo = repoName();
    $b('foot').replaceChildren(
      h('span', { text: at ? `Last refresh ${zoneStamp(at, true)}${owner ? ` (${m.lastRun.mode})` : ''}.${owner && spend != null ? ` Estimated X API spend this month: $${spend.toFixed(2)}.` : ''}` : 'Not refreshed yet.' }),
      h('span', { text: `Data starts ${dLong.format(S.dataStart)}. ${nf.format(S.posts.length)} Midnight posts tracked, out of ${nf.format(S.posts.length + S.other.length)} posts seen in total. Engagement rate = (likes + replies + reposts + quotes) ÷ impressions.` }),
      h('span', null, `Community planning tool${profile.role ? ` by ${/^[aeiou]/i.test(profile.role) ? 'an' : 'a'} ${profile.role}` : ''}. Not an official Midnight Network or Midnight Foundation publication. Midnight and the Midnight logo are trademarks of their owners.`,
        owner && repo ? h('span', null, ' · ', h('a', { href: `https://github.com/${repo}/edit/main/plan.json`, target: '_blank', rel: 'noopener', text: 'Edit plan.json' }), ' · ', h('a', { href: `https://github.com/${repo}/edit/main/builders.json`, target: '_blank', rel: 'noopener', text: 'Edit builders.json' })) : null),
      owner
        ? h('span', { class: 'db-foot__owner' }, 'Signed in as the owner on this browser. ', h('button', { type: 'button', class: 'db-textbtn', onclick: signOut, text: 'Sign out' }))
        : h('span', { class: 'db-foot__owner' }, ownerNote ? `${ownerNote} ` : '', h('button', { type: 'button', class: 'db-textbtn', onclick: openOwner, text: 'Owner sign-in' })));
  }

  /** Days into a calendar period, and a note on periods that start before the stored data does. */
  function renderPeriodInfo(c) {
    const P = c.P;
    const today = startOfDay(new Date());
    const lastDay = new Date(Math.min(addDays(P.end, -1).getTime(), today.getTime()));
    const totalDays = Math.round((P.end - P.start) / 864e5);
    const dayN = Math.min(totalDays, Math.max(0, Math.round((addDays(lastDay, 1) - P.start) / 864e5)));
    $b('period-days').textContent = P.calendar ? (dayN >= totalDays ? `${dLong.format(P.start)} – ${dLong.format(addDays(P.end, -1))}` : `Day ${dayN} of ${totalDays}`) : `${dLong.format(P.start)} – ${dLong.format(lastDay)}`;
    const el = $b('period-note');
    el.replaceChildren();
    el.hidden = true;
    if (S.meta.demo || P.key === 'all' || P.start >= S.dataStart) return;
    const since = dLong.format(S.dataStart);
    if (P.end <= S.dataStart) el.append(h('strong', { text: `No posts stored for ${P.label}. ` }), `Stored posts start on ${since}.`);
    else el.append(h('strong', { text: 'Partial period. ' }), `Stored posts start on ${since}.`);
    el.hidden = false;
  }

  /* section tabs follow the scroll */
  function setupTabs() {
    const links = [...document.querySelectorAll('.db-tabs a')];
    const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
    const mark = (id) => links.forEach((a) => a.setAttribute('aria-current', a === byId.get(id) ? 'true' : 'false'));
    // the current section is the last one whose top has passed just under the sticky bar
    const ids = [...byId.keys()];
    let raf = 0;
    const update = () => {
      raf = 0;
      const line = (document.querySelector('.db-top')?.offsetHeight || 60) + 48;
      const shown = ids.filter((id) => document.getElementById(id)?.getClientRects().length); // Plan & report is hidden from visitors
      let cur = shown[0];
      for (const id of shown) { if (document.getElementById(id).getBoundingClientRect().top <= line) cur = id; }
      if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) cur = shown[shown.length - 1];
      mark(cur);
    };
    addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(update); }, { passive: true });
    addEventListener('resize', () => { if (!raf) raf = requestAnimationFrame(update); });
    update();
  }

  function render() {
    const c = compute(current);
    $$b('period-label').forEach((el) => { el.textContent = current.label; });
    renderPeriodInfo(c);
    renderKpis(c);
    renderTrends(c);
    renderTop(c);
    renderBuilders(c);
    if (owner) renderPlan(c);
    renderApp(c);
  }

  async function main() {
    setupTabs();
    setupRefresh();
    setupBuilderForm();
    setupBuilderStrip();
    setupOwner();
    try {
      await checkOwner();
      S = await load();
    } catch (err) {
      $b('sub').textContent = `Could not load data (${err.message}). If you opened index.html straight from disk, serve the folder over HTTP instead (e.g. python -m http.server).`;
      return;
    }
    list = periods();
    const selects = [...document.querySelectorAll('select.js-period')];
    fillPeriods(selects);
    const fromUrl = new URLSearchParams(location.search).get('period');
    current = list.find((p) => p.key === fromUrl) || list.find((p) => p.key === store.get('mx-period')) || list[0];
    selects.forEach((sel) => { sel.value = current.key; });
    selects.forEach((sel) => sel.addEventListener('change', () => {
      current = list.find((p) => p.key === sel.value) || list[0];
      selects.forEach((o) => { o.value = current.key; });
      store.set('mx-period', current.key);
      try { const u = new URL(location.href); u.searchParams.set('period', current.key); history.replaceState(null, '', u); } catch { /* no history API */ }
      app.page = 0;
      render();
    }));
    setupApp();
    renderChrome();
    renderSeries();
    render();
    $b('copy').addEventListener('click', async () => {
      const text = summaryText(compute(current));
      const status = $b('copy-status');
      try { await navigator.clipboard.writeText(text); status.textContent = 'Copied. Paste it into your report.'; } catch { status.textContent = 'Copying is blocked here. Open the preview below and copy it by hand.'; }
    });
    let lastW = innerWidth;
    let timer;
    addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (Math.abs(innerWidth - lastW) < 30) return; lastW = innerWidth; const cc = compute(current); renderTrends(cc); renderSeries(); renderBuilders(cc); }, 150);
    });
  }

  main();
})();
