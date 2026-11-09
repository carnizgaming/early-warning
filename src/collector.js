// Early Warning collector: pulls public feeds, scores them and returns one data object for the dashboard.
// Each feed is independent: one failing never stops the rest. State (cache, history, seen items) lives in dataDir.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const KW = require('./keywords');

const UA = 'EarlyWarningDashboard/1.0 (personal use)';
const RANK = { info: 0, watch: 1, warning: 2, critical: 3 };
const maxLevel = (a, b) => (RANK[a] >= RANK[b] ? a : b);

// ---------------- small helpers ----------------
function iso(d) { return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function toIso(v) {
  if (v === null || v === undefined || v === '') return null;
  let s = String(v).trim();
  s = s.replace(/\s+BST$/, ' +0100');
  const d = new Date(s);
  return isNaN(d) ? null : iso(d);
}
function ageHours(t) { if (!t) return 9999; const d = new Date(t); return isNaN(d) ? 9999 : (Date.now() - d.getTime()) / 3600e3; }
function stripHtml(s) {
  if (!s) return '';
  s = String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/\s+/g, ' ').trim();
  return s.length > 300 ? s.slice(0, 297) + '...' : s;
}
function fmtWhen(t) { try { return new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }).replace(',', ''); } catch { return ''; } }
function titleCase(s) { return String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); }
function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } }
function writeJson(p, o) { const tmp = p + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(o)); fs.renameSync(tmp, p); }

function expandUrl(u) {
  const n = new Date(), d = x => iso(x), day = x => iso(x).slice(0, 10);
  return u.replace('{now}', d(n)).replace('{minus60m}', d(new Date(n - 3600e3))).replace('{minus1d}', d(new Date(n - 864e5)))
    .replace('{minus3d}', d(new Date(n - 3 * 864e5))).replace('{unixNow}', String(Math.floor(n / 1000)))
    .replace('{unixMinus1d}', String(Math.floor(n / 1000) - 86400)).replace('{date40}', day(new Date(n - 40 * 864e5))).replace('{today}', day(n));
}
async function getText(url) {
  const res = await fetch(expandUrl(url), { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(30000), redirect: 'follow' });
  if (!res.ok) { const e = new Error(`The server returned an error: (${res.status}) ${res.statusText}`); e.status = res.status; throw e; }
  return await res.text();
}
async function getJson(url) { return JSON.parse(await getText(url)); }

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, textNodeName: '#text', processEntities: true, htmlEntities: true });
const txt = v => (v === undefined || v === null) ? '' : (typeof v === 'object' ? (v['#text'] !== undefined ? String(v['#text']) : '') : String(v));
// all text inside a parsed XML node (Atom xhtml content is nested elements)
const deepText = v => v === undefined || v === null ? '' : typeof v !== 'object' ? String(v) : Array.isArray(v) ? v.map(deepText).join(' ') : Object.keys(v).filter(k => k[0] !== '@').map(k => deepText(v[k])).join(' ');
const arr = v => v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]);
// Generic RSS / Atom reader -> [{title, link, time, summary, raw}]
async function readFeed(url) {
  const doc = xml.parse(await getText(url));
  const ch = doc.rss ? doc.rss.channel : (doc.RDF || doc.rdf);
  if (ch && (ch.item || (doc.RDF && doc.RDF.item))) {
    return arr(ch.item || doc.RDF.item).map(i => ({
      title: txt(i.title).trim(), link: txt(i.link).trim(), time: toIso(txt(i.pubDate) || txt(i.date) || txt(i.updated)),
      summary: stripHtml(txt(i.description)), raw: i
    }));
  }
  const feed = doc.feed;
  if (!feed) return [];
  return arr(feed.entry).map(e => {
    const links = arr(e.link); const l = links.find(x => !x['@rel'] || x['@rel'] === 'alternate') || links[0] || {};
    const content = e.summary !== undefined ? e.summary : e.content;
    return { title: deepText(e.title).trim(), link: typeof l === 'string' ? l : (l['@href'] || txt(l)), time: toIso(txt(e.published) || txt(e.updated)), summary: stripHtml(deepText(content)), raw: e };
  });
}

// ---------------- the collector ----------------
async function collect(settings, feeds, dataDir, log = () => {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const now = new Date();
  const home = settings.home;
  const localWords = (home.localWords || []).map(w => w.toLowerCase()).filter(Boolean);
  const kw = settings.keywords || KW;

  const isLocal = text => { const t = String(text).toLowerCase(); return localWords.some(w => t.includes(w)); };
  const keywordLevel = text => {
    const t = ' ' + String(text).toLowerCase() + ' ';
    const soft = (kw.notWords || []).some(n => n && t.includes(n));
    let r = ['info', ''];
    for (const k of kw.critical) if (t.includes(k)) { r = ['critical', k]; break; }
    if (r[0] === 'info') for (const k of kw.warning) if (t.includes(k)) { r = ['warning', k]; break; }
    if (r[0] === 'info') for (const k of kw.watch) if (t.includes(k)) { r = ['watch', k]; break; }
    if (soft) r[0] = { critical: 'warning', warning: 'watch', watch: 'info', info: 'info' }[r[0]];
    return r;
  };
  const newItem = (f, title, link, time, summary, level, local = false, tag = '') => ({
    id: crypto.createHash('sha1').update(`${f.id}|${title}|${link}`).digest('hex').slice(0, 16),
    source: f.name, feed: f.id, panel: f.panel, title, link, time, summary, level, local: !!local, tag
  });
  const chart = (title, unit, points, refs = [], future = false) => ({ title, unit, points, refs, future });

  // ---------- handlers ----------
  const H = {};
  H.govalerts = async f => (await readFeed(f.url)).filter(e => ageHours(e.time) <= 24 * 30).map(e => {
    const text = `${e.title} ${e.summary}`, age = ageHours(e.time);
    let lvl = 'info';
    if (age <= 48) { lvl = 'warning'; if (/wales|england|scotland|northern ireland|united kingdom|\buk\b|national/i.test(text) || isLocal(text)) lvl = 'critical'; }
    else if (age <= 24 * 7) lvl = 'watch';
    return newItem(f, 'Emergency Alert: ' + e.title, e.link, e.time, e.summary, lvl, isLocal(text), 'alert');
  });
  H.threat = async f => {
    const e = (await readFeed(f.url))[0]; if (!e) return [];
    const t = `${e.title} ${e.summary}`; const word = ['CRITICAL', 'SEVERE', 'SUBSTANTIAL', 'MODERATE', 'LOW'].find(w => new RegExp(`\\b${w}\\b`, 'i').test(t)) || '';
    const lvl = { CRITICAL: 'critical', SEVERE: 'watch', SUBSTANTIAL: 'watch' }[word] || 'info';
    return [newItem(f, word ? `UK threat level: ${word}` : e.title, e.link, e.time, e.summary, lvl, false, 'threat')];
  };
  H.metoffice = async f => (await readFeed(f.url)).map(e => {
    const t = `${e.title} ${e.summary}`;
    const lvl = /\bred\b/i.test(t) ? 'critical' : /\bamber\b/i.test(t) ? 'warning' : 'watch';
    return newItem(f, e.title, e.link, e.time, e.summary, lvl, isLocal(t), 'weather');
  });
  H.eafloods = async f => arr((await getJson(f.url)).items).filter(w => +w.severityLevel < 4).map(w => {
    const sev = +w.severityLevel, lvl = { 1: 'critical', 2: 'warning', 3: 'watch' }[sev] || 'info';
    const summary = stripHtml(`${w.eaAreaName}. ${w.message || ''}`);
    return newItem(f, `${w.severity}: ${w.description}`, 'https://check-for-flooding.service.gov.uk/target-area/' + w.floodAreaID, toIso(w.timeRaised), summary, lvl, isLocal(`${w.description} ${summary}`), 'flood');
  });
  H.powercuts = async f => {
    const lines = (await getText(f.url)).split(/\r?\n/).filter(Boolean);
    const parseCsv = line => { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; };
    const cols = parseCsv(lines[0] || '');
    const pick = (row, re) => { for (let k = 0; k < cols.length; k++) if (re.test(cols[k]) && row[k]) return row[k]; return ''; };
    const hp = home.postcodes || [], np = home.nearPostcodes || [];
    let total = 0, homeCount = 0, nearCount = 0; const out = [];
    for (const l of lines.slice(1)) {
      const row = parseCsv(l); total++;
      const line = row.join(' ');
      const isHome = hp.some(p => new RegExp(`\\b${p}\\b`, 'i').test(line)), isNear = np.some(p => new RegExp(`\\b${p}\\b`, 'i').test(line));
      if (!isHome && !isNear) continue;
      if (isHome) homeCount++; else nearCount++;
      let pc = pick(row, /postcode/i); const pcs = pc.split(/\s*[,;]\s*/).filter(Boolean); if (pcs.length > 3) pc = pcs.slice(0, 3).join(', ') + ` and ${pcs.length - 3} more`;
      const status = pick(row, /status|type/i), cust = pick(row, /customer|propert|homes/i), etr = pick(row, /restor|etr|estimat/i), start = pick(row, /start|reported|time|date/i), ref = pick(row, /ref|incident|id/i);
      const summary = [status && `Status: ${status}`, etr && `Estimated restore: ${etr}`, ref && `Ref: ${ref}`].filter(Boolean).join('. ');
      out.push(newItem(f, `Power cut ${pc || 'near you'}${cust ? ` (${cust} affected)` : ''}`, f.link, toIso(start), summary, isHome ? 'warning' : 'watch', isHome, 'power'));
    }
    const s = newItem(f, `${total} power cuts across the network now, ${homeCount} in ${hp.join('/') || 'your area'}, ${nearCount} nearby`, f.link, iso(now), 'A sudden jump in network-wide cuts can be the first sign of a big storm or wider grid trouble.', total >= 400 ? 'warning' : total >= 150 ? 'watch' : 'info', false, 'power-summary');
    Object.assign(s, { value: total, homeCount, nearCount }); out.push(s);
    return out;
  };
  H.news = async f => {
    const out = [];
    for (const e of await readFeed(f.url)) {
      if (ageHours(e.time) > 48) continue;
      if (out.length >= 40) break;
      const text = `${e.title} ${e.summary}`, k = keywordLevel(text);
      const it = newItem(f, e.title.replace(/\s+-\s+[^-]{2,40}$/, ''), e.link, e.time, e.summary, k[0], isLocal(text), k[1]);
      it.isNews = true; out.push(it);
    }
    return out;
  };
  H.gdacs = async f => (await readFeed(f.url)).filter(e => ageHours(e.time) <= 24 * 7).map(e => {
    const al = txt(e.raw.alertlevel); let lvl = /red/i.test(al) ? 'warning' : /orange/i.test(al) ? 'watch' : 'info';
    const local = /united kingdom|\bUK\b/i.test(e.title); if (local) lvl = maxLevel(lvl, 'warning');
    return lvl === 'info' ? null : newItem(f, e.title, e.link, e.time, e.summary, lvl, local, 'disaster');
  }).filter(Boolean);
  H.usgs = async f => arr((await getJson(f.url)).features).map(q => {
    const m = +q.properties.mag, tsu = q.properties.tsunami === 1;
    let lvl = m >= 7.5 ? 'warning' : m >= 6.5 ? 'watch' : 'info'; if (tsu) lvl = maxLevel(lvl, 'watch');
    return newItem(f, `M${m.toFixed(1)} earthquake, ${q.properties.place}`, q.properties.url, iso(q.properties.time), `Alert: ${q.properties.alert || 'none'}.${tsu ? ' Tsunami possible.' : ''}`, lvl, false, 'quake');
  });
  H.bgs = async f => (await readFeed(f.url)).filter(e => ageHours(e.time) <= 24 * 14).map(e => {
    const m = +((`${e.title} ${e.summary}`.match(/M(?:L)?\s*(\d+(?:\.\d)?)/i) || [])[1] || 0);
    return newItem(f, 'UK quake: ' + e.title.replace(/^UK Earthquake alert\s*:\s*/i, ''), e.link, e.time, e.summary, m >= 4 ? 'warning' : m >= 3 ? 'watch' : 'info', isLocal(`${e.title} ${e.summary}`), 'quake');
  });
  H.fcdo = async f => (await readFeed(f.url)).filter(e => ageHours(e.time) <= 72).slice(0, 15).map(e =>
    newItem(f, 'Travel advice: ' + e.title, e.link, e.time, e.summary, /against all travel|leave .* now|leave immediately|airspace/i.test(`${e.title} ${e.summary}`) ? 'watch' : 'info', false, 'travel'));
  H.kp = async f => {
    const j = await getJson(f.url); const last = j[j.length - 1];
    const kp = Array.isArray(last) ? +last[1] : +last.Kp, tt = Array.isArray(last) ? last[0] : last.time_tag;
    const g = kp >= 9 ? 'G5 extreme' : kp >= 8 ? 'G4 severe' : kp >= 7 ? 'G3 strong' : kp >= 6 ? 'G2 moderate' : kp >= 5 ? 'G1 minor' : 'no storm';
    const it = newItem(f, `Geomagnetic Kp ${kp.toFixed(1)}: ${g}`, f.link, toIso(String(tt).replace(' ', 'T') + (String(tt).endsWith('Z') ? '' : 'Z')), 'Kp 0-4 normal. G3+ storms can disrupt GPS, radio and, at G4-G5, power grids.', kp >= 9 ? 'critical' : kp >= 7 ? 'warning' : kp >= 5 ? 'watch' : 'info', false, 'kp');
    it.value = kp; return [it];
  };
  H.swpc = async f => (await getJson(f.url)).slice(0, 25).map(a => {
    const tm = toIso(String(a.issue_datetime).replace(' ', 'T') + 'Z'); if (ageHours(tm) > 72) return null;
    const msg = String(a.message || ''); const first = (msg.split(/\r?\n/).find(l => /^(ALERT|WARNING|WATCH|SUMMARY|EXTENDED WARNING|CANCEL)/.test(l)) || '').trim(); if (!first) return null;
    const lvl = /\bG[45]\b|K-index of [89]|X-?ray flux.*X\d|R[45]\b|S[45]\b/i.test(msg) ? 'warning' : /\bG3\b|K-index of 7|X-class|\bX\d/i.test(msg) ? 'watch' : 'info';
    return newItem(f, first, f.link, tm, '', lvl, false, 'space');
  }).filter(Boolean);
  H.ncsc = async f => (await readFeed(f.url)).filter(e => ageHours(e.time) <= 24 * 14).slice(0, 12).map(e =>
    newItem(f, e.title, e.link, e.time, e.summary, /alert|critical|actively exploited|urgent|ongoing/i.test(e.title) ? 'watch' : 'info', false, 'cyber'));
  H.status = async f => (await readFeed(f.url)).filter(e => ageHours(e.time) <= 48).slice(0, 8).map(e => {
    const t = `${e.title} ${e.summary}`; return newItem(f, e.title, e.link, e.time, e.summary, /resolved|completed|scheduled|maintenance/i.test(t) ? 'info' : 'watch', false, 'status');
  });
  const neoSize = (h, diam) => (diam !== null && diam !== undefined && diam !== '') ? +diam * 1000 : (h ? 1329000 / Math.sqrt(0.14) * Math.pow(10, -(+h) / 5) : 0);
  H.neo = async f => {
    const j = await getJson(f.url); const fi = {}; j.fields.forEach((k, i) => fi[k] = i);
    return arr(j.data).map(r => { const au = +r[fi.dist]; return { des: r[fi.des], cd: r[fi.cd], ld: au / 0.00257, km: au * 149597870.7, size: neoSize(r[fi.h], fi.diameter !== undefined ? r[fi.diameter] : null), v: +r[fi.v_rel] }; })
      .sort((a, b) => a.ld - b.ld).slice(0, 8).map(o => {
        const lvl = (o.size >= 140 && o.ld < 1) ? 'warning' : ((o.size >= 50 && o.ld < 1) || (o.size >= 300 && o.ld < 5)) ? 'watch' : 'info';
        const when = toIso(o.cd.replace(/^(\d{4})-(\w{3})-(\d{2}) (\d{2}:\d{2})$/, '$3 $2 $1 $4 UTC'));
        const sz = o.size >= 1000 ? `${(o.size / 1000).toFixed(1)} km` : `~${Math.round(o.size)} m`;
        return newItem(f, `Asteroid ${o.des} (${sz}) passes ${o.ld.toFixed(1)} lunar distances on ${o.cd.replace(/ \d\d:\d\d$/, '')}`, 'https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=' + encodeURIComponent(o.des), when, `${Math.round(o.km).toLocaleString('en-GB')} km from Earth at ${o.v.toFixed(1)} km/s. 1 lunar distance = the Moon's orbit. Close passes are normal; a miss is a miss.`, lvl, false, 'neo');
      });
  };
  H.sentry = async f => {
    const j = await getJson(f.url); const out = [];
    for (const o of arr(j.data)) {
      const ts = /^\d+$/.test(String(o.ts_max)) ? +o.ts_max : 0; if (ts < 1) continue;
      out.push(newItem(f, `Impact risk: ${String(o.fullname).trim()}, Torino scale ${ts}`, 'https://cneos.jpl.nasa.gov/sentry/details.html#?des=' + encodeURIComponent(o.des), iso(now), `Chance of impact ${(+o.ip * 100).toFixed(4)}% (${o.range}), about ${Math.round(+o.diameter * 1000)} m across. Torino 1 = routine, usually ruled out after more observation; 5+ = serious.`, ts >= 8 ? 'critical' : ts >= 5 ? 'warning' : 'watch', false, 'impact'));
    }
    if (!out.length) out.push(newItem(f, 'No known asteroid rated above 0 on the Torino impact scale', f.link, iso(now), `NASA Sentry is tracking ${j.count} objects, all negligible risk.`, 'info', false, 'impact'));
    return out;
  };
  H.donki = async f => {
    const names = { FLR: 'Solar flare', CME: 'Coronal mass ejection', GST: 'Geomagnetic storm', SEP: 'Solar energetic particles', IPS: 'Interplanetary shock', RBE: 'Radiation belt enhancement', MPC: 'Magnetopause crossing' };
    return arr(await getJson(f.url)).sort((a, b) => String(b.messageIssueTime).localeCompare(a.messageIssueTime)).slice(0, 15).map(m => {
      const tm = toIso(String(m.messageIssueTime).replace(/Z?$/, 'Z')); const type = String(m.messageType);
      if (ageHours(tm) > 72 || type === 'Report') return null;
      const body = String(m.messageBody || ''); const sm = body.match(/## Summary:\s*([\s\S]+?)(##|$)/); const sum = stripHtml(sm ? sm[1] : body);
      let lvl = (type === 'GST' || (type === 'FLR' && /\bX\d/.test(body))) ? 'watch' : 'info';
      if (/\bG[45]\b|Kp\s*(index)?\s*(of|=|reached)?\s*[89]/i.test(body)) lvl = 'warning';
      if (type === 'CME' && /earth|glancing blow|arrival/i.test(body)) lvl = maxLevel(lvl, 'watch');
      return newItem(f, 'NASA: ' + (names[type] || type), m.messageURL, tm, sum, lvl, false, 'space');
    }).filter(Boolean);
  };
  const distKm = (a1, o1, a2, o2) => { const r = Math.PI / 180, dl = (a2 - a1) * r, dn = (o2 - o1) * r; const a = Math.sin(dl / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dn / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(a)); };
  H.eonet = async f => arr((await getJson(f.url)).events).map(e => {
    const g = arr(e.geometry).slice(-1)[0] || {}; const km = (g.type === 'Point' && g.coordinates) ? distKm(home.lat, home.lon, +g.coordinates[1], +g.coordinates[0]) : 99999;
    return { e, tm: toIso(g.date), km, cat: arr(e.categories).map(c => c.title).join(', ') };
  }).sort((a, b) => ((a.km > 800) - (b.km > 800)) || (new Date(b.tm) - new Date(a.tm))).slice(0, 12).map(x => {
    let lvl = 'info', local = false;
    if (x.km < 150) { lvl = 'warning'; local = true; } else if (x.km < 800) lvl = 'watch'; else if (/volcano/i.test(x.cat) && x.km < 2500) lvl = 'watch';
    const src = (arr(x.e.sources)[0] || {}).url;
    return newItem(f, `${x.cat}: ${x.e.title}`, src || x.e.link, x.tm, `Seen by NASA Earth observation${x.km < 99999 ? ` (${Math.round(x.km).toLocaleString('en-GB')} km away)` : ''}.`, lvl, local, 'eonet');
  });
  H.gdelt = async f => {
    const j = await getJson(f.url); const series = j.timeline ? arr(j.timeline)[0].data : j.data;
    const pts = arr(series).filter(d => d && d.value !== undefined).map(d => { const m = String(d.date).match(/^(\d{4})(\d\d)(\d\d)T?(\d\d)?(\d\d)?/); return { t: m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : new Date(d.date).getTime(), v: +d.value }; }).filter(p => !isNaN(p.t)).sort((a, b) => a.t - b.t);
    if (pts.length < 6) throw new Error(`GDELT returned too little data (${pts.length} points)`);
    const cut = pts[pts.length - 1].t - 864e5; const rec = pts.filter(p => p.t > cut), bef = pts.filter(p => p.t <= cut);
    if (!rec.length || !bef.length) throw new Error(`GDELT data doesn't cover the last week (${pts.length} points)`);
    const avg = a => a.reduce((s, p) => s + p.v, 0) / a.length; const ra = avg(rec), ba = avg(bef), ratio = ba > 0 ? ra / ba : 1;
    const it = newItem(f, `Conflict share of world news: ${ra.toFixed(2)}% (x${ratio.toFixed(2)} vs previous 6 days)`, f.link, iso(now), 'GDELT monitors news worldwide in 65 languages.', 'info', false, 'gdelt');
    it.value = Math.round(ratio * 1000) / 1000; return [it];
  };
  H.wind = async f => {
    const j = await getJson(f.url); const pts = []; let max = 0, maxT = '', maxS = 0;
    j.hourly.time.forEach((t, k) => { const tm = t + ':00Z', a = ageHours(tm); if (a > 1 || a < -48) return; const g = +j.hourly.wind_gusts_10m[k], s = +j.hourly.wind_speed_10m[k]; pts.push([tm, Math.round(g)]); if (g > max) { max = g; maxT = tm; } if (s > maxS) maxS = s; });
    if (!pts.length) throw new Error('No forecast hours returned');
    const it = newItem(f, `Gusts up to ${Math.round(max)} mph at ${home.name}, ${fmtWhen(maxT)}`, f.link, iso(now), `Strongest steady wind ${Math.round(maxS)} mph in the next 48 hours. 50 mph+ brings down branches and fences; 60 mph+ means damage and bridge closures.`, max >= 60 ? 'warning' : max >= 50 ? 'watch' : 'info', true, 'wind');
    it.chart = chart('Wind gusts, next 48 hours', 'mph', pts, [{ v: 50, label: 'strong' }, { v: 60, label: 'damaging' }], true); return [it];
  };
  H.aqi = async f => {
    const j = await getJson(f.url); const pts = []; let max = 0, maxT = '';
    j.hourly.time.forEach((t, k) => { const tm = t + ':00Z', a = ageHours(tm); const v = j.hourly.european_aqi[k]; if (a > 1 || a < -48 || v === null) return; pts.push([tm, Math.round(+v)]); if (+v > max) { max = +v; maxT = tm; } });
    if (!pts.length) throw new Error('No air quality hours returned');
    const band = max >= 100 ? 'extremely poor' : max >= 80 ? 'very poor' : max >= 60 ? 'poor' : max >= 40 ? 'moderate' : max >= 20 ? 'fair' : 'good';
    const it = newItem(f, `Air quality: ${band} (index ${Math.round(max)}) at worst, ${fmtWhen(maxT)}`, f.link, iso(now), 'European air quality index for the next 48 hours. Smoke from big fires shows up here first.', max >= 100 ? 'warning' : max >= 80 ? 'watch' : 'info', true, 'aqi');
    it.chart = chart('Air quality index, next 48 hours', 'AQI', pts, [{ v: 60, label: 'poor' }, { v: 80, label: 'very poor' }], true); return [it];
  };
  H.tide = async f => {
    const st = (await getJson(f.url)).items; const label = String(st.label || 'tide gauge').replace(/\s+/g, ' ');
    let ss = null; try { const u = typeof st.stageScale === 'string' ? st.stageScale : (st.stageScale || {})['@id']; if (u) ss = (await getJson(u)).items; } catch {}
    const rd = arr((await getJson(f.url + '/readings?_sorted&_limit=400')).items).filter(r => /level/i.test(r.measure) && r.value !== null && ageHours(r.dateTime) <= 48).sort((a, b) => String(a.dateTime).localeCompare(b.dateTime));
    if (!rd.length) throw new Error('No recent tide readings');
    const last = rd[rd.length - 1], v = +last.value; const prev = rd.filter(r => ageHours(r.dateTime) >= 0.5).slice(-1)[0];
    const trend = prev && v > +prev.value + 0.05 ? 'rising' : prev && v < +prev.value - 0.05 ? 'falling' : 'steady';
    const peak24 = Math.max(...rd.filter(r => ageHours(r.dateTime) <= 24).map(r => +r.value));
    const refs = []; let lvl = 'info', note = '';
    if (ss) {
      if (ss.typicalRangeHigh) refs.push({ v: +ss.typicalRangeHigh, label: 'typical high' });
      if (ss.highestRecent && ss.highestRecent.value) { const hr = +ss.highestRecent.value; refs.push({ v: hr, label: 'highest recent' }); if (peak24 >= hr) { lvl = 'watch'; note = ' Above the highest recent tide.'; } }
      if (ss.maxOnRecord && ss.maxOnRecord.value && peak24 >= +ss.maxOnRecord.value - 0.3) { lvl = 'warning'; note = ' Within 30 cm of the highest ever recorded here.'; }
    }
    const it = newItem(f, `Tide at ${label}: ${v.toFixed(2)} m, ${trend}`, f.link, toIso(last.dateTime), `Highest in the last 24 h: ${peak24.toFixed(2)} m.${note} A storm surge shows here hours before flooding.`, lvl, true, 'tide');
    it.chart = chart('Tide level, last 48 hours', 'm', rd.map(r => [toIso(r.dateTime), Math.round(+r.value * 100) / 100]), refs); return [it];
  };
  H.freq = async f => {
    const d = arr((await getJson(f.url)).data).sort((a, b) => String(a.measurementTime).localeCompare(b.measurementTime));
    if (!d.length) throw new Error('No frequency data');
    const vals = d.map(x => +x.frequency), min = Math.min(...vals), max = Math.max(...vals), last = vals[vals.length - 1];
    const lvl = (min < 49.5 || max > 50.5) ? 'warning' : (min < 49.8 || max > 50.2) ? 'watch' : 'info';
    const it = newItem(f, `Grid frequency ${last.toFixed(2)} Hz (last hour ${min.toFixed(2)} to ${max.toFixed(2)})`, f.link, toIso(d[d.length - 1].measurementTime), 'The whole GB grid runs at 50 Hz. Dips below 49.8 Hz mean power stations have tripped; below 49.5 Hz automatic blackouts start.', lvl, false, 'freq');
    const step = Math.max(1, Math.floor(d.length / 120)); const pts = []; for (let k = 0; k < d.length; k += step) pts.push([toIso(d[k].measurementTime), Math.round(+d[k].frequency * 1000) / 1000]);
    it.chart = Object.assign(chart('Grid frequency, last hour', 'Hz', pts, [{ v: 49.8, label: 'low limit' }, { v: 50.2, label: 'high limit' }]), { min: 49.6, max: 50.4 }); return [it];
  };
  H.syswarn = async f => {
    const out = [];
    for (const w of arr((await getJson(f.url)).data).sort((a, b) => String(b.publishTime).localeCompare(a.publishTime))) {
      const type = String(w.warningType || ''), t = stripHtml(w.warningText || ''), all = `${type} ${t}`;
      if (/SO-SO|TRADES/i.test(type)) continue;
      let lvl = 'info';
      if (!/IT systems? outage|systems? maintenance|planned outage of|BMRS|data publication/i.test(all)) {
        if (/demand control|demand reduction|load shedding|rota/i.test(all)) lvl = 'warning';
        else if (/margin|capacity market|system warning|nism|inadequate/i.test(all)) lvl = 'watch';
        if (/cancel|withdraw/i.test(all)) lvl = 'info';
      }
      out.push(newItem(f, 'Grid notice: ' + titleCase(type), f.link, toIso(w.publishTime), t, lvl, false, 'syswarn'));
      if (out.length >= 8) break;
    }
    if (!out.length) out.push(newItem(f, 'No grid warnings in the last 3 days', f.link, iso(now), 'Electricity margin notices and demand control warnings from the grid operator appear here.', 'info', false, 'syswarn'));
    return out;
  };
  H.traffic = async f => {
    const html = await getText(f.url);
    const titles = [...new Set([...html.matchAll(/(?<![A-Za-z])((?:M|A|B)\d{1,4}[A-Z]?\s:\s[^<>"]{8,240}?)\s*(?:<|")/g)].map(m => stripHtml(m[1]).trim()))];
    if (!titles.length) throw new Error('Traffic page format changed (no alerts found)');
    // an alert is "ours" if it mentions any watched road or place as a whole word (e.g. M6, Thelwall, Warrington)
    const roads = (home.roads || []).map(r => r.trim()).filter(Boolean);
    const res = roads.map(r => new RegExp('(^|[^A-Za-z0-9])' + r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^A-Za-z0-9])', 'i'));
    const hits = titles.filter(t => res.some(re => re.test(t)));
    const out = hits.slice(0, 10).map(h => {
      let lvl = /closed due|high winds|accident|collision|incident|broken down|vehicle fire|emergency/i.test(h) ? 'watch' : /roadworks|carriageway maintenance|planned|resurfacing|works/i.test(h) ? 'info' : /closed/i.test(h) ? 'watch' : 'info';
      if (/(M\d+).*(closed).*(wind|bridge)|bridge.*closed/i.test(h) && !/roadworks|planned/i.test(h)) lvl = 'warning';
      return newItem(f, h.replace(/[:\s]+$/, ''), f.link, iso(now), '', lvl, true, 'traffic');
    });
    if (!out.length) out.push(newItem(f, `No incidents on ${roads.length ? roads.slice(0, 4).join(', ') : 'your watched roads'}`, f.link, iso(now), `Traffic Wales has ${titles.length} alerts elsewhere.`, 'info', true, 'traffic'));
    return out;
  };
  H.ioda = async f => {
    const al = arr((await getJson(f.url)).data).filter(a => /critical|warning/i.test(a.level));
    const crit = al.filter(a => /critical/i.test(a.level)).length; const src = [...new Set(al.map(a => a.datasource))].join(', ');
    return [newItem(f, al.length ? `UK internet: ${al.length} outage signals in 24 h (${src})` : 'UK internet: no national outage signals in 24 h', f.link, iso(now), 'IODA watches routing, probing and traffic for country-wide internet disruption.', crit >= 3 ? 'warning' : crit >= 1 ? 'watch' : 'info', false, 'ioda')];
  };
  // CISA Known Exploited Vulnerabilities: flaws confirmed as being attacked in the wild. Counted per week to show the trend.
  H.kev = async f => {
    const v = arr((await getJson(f.url)).vulnerabilities).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.dateAdded || ''));
    if (v.length < 100) throw new Error('KEV list looks incomplete');
    const DAY = 864e5, d = new Date(now); d.setUTCHours(0, 0, 0, 0);
    const thisMon = d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY;     // Monday 00:00 UTC of this week
    const weekOf = s => { const t = Date.parse(s + 'T00:00:00Z'); return t - ((new Date(t).getUTCDay() + 6) % 7) * DAY; };
    const counts = {}; for (const x of v) { const w = weekOf(x.dateAdded); counts[w] = (counts[w] || 0) + 1; }
    const wk = n => counts[thisMon - n * 7 * DAY] || 0;               // n = 1 is last full week
    const sofar = counts[thisMon] || 0;
    const prior = []; for (let n = 5; n <= 56; n++) prior.push(wk(n)); prior.sort((a, b) => a - b);
    const normal = (prior[25] + prior[26]) / 2;                        // median of the year before the last month
    const recent = (wk(1) + wk(2) + wk(3) + wk(4)) / 4;
    const ratio = normal ? recent / normal : 1;
    const lvl = ratio >= 2 ? 'warning' : ratio >= 1.5 ? 'watch' : 'info';
    const trend = ratio >= 1.5 ? `${ratio.toFixed(1)}x normal` : ratio >= 1.2 ? 'above normal' : ratio <= 0.7 ? 'below normal' : 'normal';
    const it = newItem(f, `Actively exploited flaws: ${recent.toFixed(1)}/week over the last month (${trend}; usual ${normal}/week)`, f.link, iso(now),
      `${sofar} added so far this week, ${wk(1)} last week. CISA adds a flaw only once it is confirmed being attacked in the wild. A sustained rise means attackers are finding and using holes faster.`, lvl, false, 'kev');
    const pts = []; for (let n = 26; n >= 1; n--) pts.push([iso(new Date(thisMon - n * 7 * DAY)), wk(n)]);
    it.chart = chart('Exploited flaws added per week (CISA)', '/wk', pts, [{ v: normal, label: 'usual' }]);
    const out = [it];
    for (const x of v.filter(x => Date.now() - Date.parse(x.dateAdded) <= 7 * DAY).sort((a, b) => b.dateAdded.localeCompare(a.dateAdded)).slice(0, 5)) {
      const ransom = /known/i.test(x.knownRansomwareCampaignUse || '');
      out.push(newItem(f, `${x.cveID}: ${x.vulnerabilityName}${ransom ? ' (used by ransomware)' : ''}`, 'https://nvd.nist.gov/vuln/detail/' + x.cveID, x.dateAdded + 'T12:00:00Z', x.shortDescription || '', ransom ? 'watch' : 'info', false, 'kev'));
    }
    return out;
  };
  H.who = async f => arr((await getJson(f.url)).value).slice(0, 12).map(o => {
    const tm = toIso(o.PublicationDate); if (ageHours(tm) > 24 * 45) return null;
    const t = String(o.Title), sum = stripHtml(o.Summary);
    let lvl = /novel|unknown|undetermined|avian influenza|H5N1|H7N9|pandemic|ebola|marburg|MERS|SARS|nipah|plague/i.test(`${t} ${sum}`) ? 'watch' : 'info';
    if (/United Kingdom|\bUK\b|England|Wales|Scotland/i.test(t)) lvl = 'warning';
    return newItem(f, t, 'https://www.who.int/emergencies/disease-outbreak-news/item/' + o.UrlName, tm, sum, lvl, /United Kingdom/i.test(t), 'outbreak');
  }).filter(Boolean);
  H.ukhsa = async f => (await readFeed(f.url)).filter(e => ageHours(e.time) <= 24 * 14).slice(0, 10).map(e =>
    newItem(f, e.title, e.link, e.time, e.summary, /outbreak|rise in cases|increase in cases|alert|pandemic|avian|measles|warning/i.test(`${e.title} ${e.summary}`) ? 'watch' : 'info', false, 'ukhsa'));
  H.fsa = async f => arr((await getJson(f.url)).items).slice(0, 15).map(a => {
    const tm = toIso(a.created); if (ageHours(tm) > 24 * 21) return null;
    const types = arr(a.type).join(' '); const kind = /FAFA/.test(types) ? 'Food alert for action' : /\/AA\b/.test(types) ? 'Allergy alert' : 'Recall';
    let risk = ''; try { risk = stripHtml(arr(a.problem)[0].riskStatement); } catch {}
    return newItem(f, `${kind}: ${a.title}`, a.alertURL, tm, risk, /FAFA/.test(types) ? 'watch' : 'info', false, 'food');
  }).filter(Boolean);
  H.fx = async f => {
    const j = await getJson(f.url); const days = Object.keys(j.rates || {}).sort();
    if (days.length < 5) throw new Error('Too few exchange rate days');
    const usd = days.map(d => ({ d, v: +j.rates[d].USD, e: +j.rates[d].EUR }));
    const n1 = usd[usd.length - 1], wk = usd[Math.max(0, usd.length - 6)], mo = usd[0];
    const c7 = (n1.v / wk.v - 1) * 100, c30 = (n1.v / mo.v - 1) * 100; const sg = x => (x >= 0 ? '+' : '') + x.toFixed(1);
    const it = newItem(f, `£1 = $${n1.v.toFixed(3)} / €${n1.e.toFixed(3)} (${sg(c7)}% this week, ${sg(c30)}% this month)`, f.link, n1.d + 'T16:00:00Z', 'A sharp fall in the pound pushes fuel and food prices up a few weeks later. Rates are the European Central Bank reference, once a working day.', c7 <= -6 ? 'warning' : c7 <= -3 ? 'watch' : 'info', false, 'fx');
    it.chart = chart('Pound to US dollar, last 40 days', '$', usd.map(u => [u.d + 'T16:00:00Z', Math.round(u.v * 10000) / 10000]), []); return [it];
  };

  // ---------- run every feed (cache, back-off, last-good fallback) ----------
  let items = [], sources = [];
  await Promise.all(feeds.filter(f => f.enabled !== false).map(async f => {
    if (f.kind === 'link') { sources.push({ id: f.id, name: f.name, panel: f.panel, link: f.link, ok: null, count: 0, error: f.note || 'Open the link to check (no free feed)' }); return; }
    const h = H[f.kind]; if (!h) return;
    const cacheFile = path.join(dataDir, `cache-${f.id}.json`), failFile = path.join(dataDir, `fail-${f.id}.txt`);
    const mtimeMin = p => { try { return (Date.now() - fs.statSync(p).mtimeMs) / 60000; } catch { return Infinity; } };
    let got = null;
    try {
      if (f.everyMinutes && mtimeMin(cacheFile) < f.everyMinutes) got = readJson(cacheFile, null);
      if (!got) {
        const wait = f.backoffMinutes || 15;
        if (mtimeMin(failFile) < wait) throw new Error('waiting to retry: ' + fs.readFileSync(failFile, 'utf8'));
        got = await h(f);
        try { fs.unlinkSync(failFile); } catch {}
        if (f.everyMinutes) writeJson(cacheFile, got);
      }
      items.push(...got);
      sources.push({ id: f.id, name: f.name, panel: f.panel, link: f.link, ok: true, count: got.length, error: '' });
    } catch (e) {
      const msg = String(e.message || e).slice(0, 160);
      if (!msg.startsWith('waiting to retry')) { log(`FAIL ${f.id}: ${msg}`); try { fs.writeFileSync(failFile, msg); } catch {} }
      const stale = f.everyMinutes ? readJson(cacheFile, []) : [];
      items.push(...(stale || []));
      sources.push({ id: f.id, name: f.name, panel: f.panel, link: f.link, ok: false, count: (stale || []).length, error: stale && stale.length ? `showing last good data; ${msg}` : msg });
    }
  }));
  // keep panel order stable (Promise.all finishes in any order)
  const order = Object.fromEntries(feeds.map((f, i) => [f.id, i]));
  items.sort((a, b) => order[a.feed] - order[b.feed]); sources.sort((a, b) => order[a.id] - order[b.id]);

  // charts travel separately
  const charts = {};
  for (const i of items) if (i.chart) { charts[i.feed] = i.chart; delete i.chart; }

  // ---------- power-cut history and surge detection ----------
  let power = null;
  const ps = items.find(i => i.tag === 'power-summary');
  const phFile = path.join(dataDir, 'power-history.json');
  let ph = readJson(phFile, []).filter(x => x && ageHours(x.t) < 24 * 14);
  if (ps && ps.value !== undefined) { ph.push({ t: iso(now), total: ps.value, local: (ps.homeCount || 0) + (ps.nearCount || 0) }); writeJson(phFile, ph); }
  if (ph.length) {
    const basePts = ph.filter(x => { const a = ageHours(x.t); return a > 3 && a <= 24 * 7; }).map(x => x.total).sort((a, b) => a - b);
    const baseline = basePts.length >= 24 ? basePts[Math.floor(basePts.length / 2)] : null;
    const cur = ph[ph.length - 1].total, ratio = baseline ? Math.round(cur / baseline * 100) / 100 : null;
    if (ps && ratio !== null) {
      const jump = cur - baseline;
      if (ratio >= 2 && jump >= 30) { ps.level = maxLevel(ps.level, 'warning'); ps.title = `Power cuts surging: ${cur} now, x${ratio} normal (${baseline})`; }
      else if (ratio >= 1.5 && jump >= 15) { ps.level = maxLevel(ps.level, 'watch'); ps.title = `Power cuts rising: ${cur} now, x${ratio} normal (${baseline})`; }
    }
    const byHour = {};
    for (const x of ph.filter(x => ageHours(x.t) <= 24 * 7)) { const k = iso(x.t).slice(0, 13) + ':00:00Z'; const b = byHour[k] || (byHour[k] = { t: k, total: 0, local: 0 }); b.total = Math.max(b.total, x.total); b.local = Math.max(b.local, x.local); }
    power = { current: cur, baseline, ratio, series: Object.values(byHour).sort((a, b) => a.t.localeCompare(b.t)), learning: baseline === null };
  }

  // ---------- overall status ----------
  let overall = 'info', reasons = [];
  for (const i of items) {
    let l = i.level;
    if ((i.isNews || ['world', 'space', 'cyber', 'health', 'money'].includes(i.panel)) && l === 'warning' && !i.local) l = 'watch';
    if (i.isNews && RANK[l] > RANK.warning) l = 'warning';
    if (RANK[l] >= RANK.warning) reasons.push(i.title);
    overall = maxLevel(overall, l);
  }

  // ---------- world tension level ----------
  const clamp = x => Math.max(0, Math.min(100, x));
  const factors = [];
  const heads = {}; for (const i of items.filter(i => i.panel === 'news')) { const k = i.title.toLowerCase().replace(/[^a-z0-9 ]/g, ''); if (!heads[k]) heads[k] = i; }
  let W = 0; for (const i of Object.values(heads)) W += { info: 0, watch: 0.5, warning: 2, critical: 6 }[i.level];
  const histFile = path.join(dataDir, 'tension-history.json');
  let hist = readJson(histFile, []).filter(x => x && ageHours(x.t) < 24 * 14);
  const older = hist.filter(x => ageHours(x.t) > 24).map(x => +x.w).sort((a, b) => a - b);
  let baseW = older.length >= 48 ? older[Math.floor(older.length / 2)] : (settings.tension && settings.tension.newsBaseline) || 25; if (baseW < 5) baseW = 5;
  const cNews = clamp((W / baseW - 0.8) * 60);
  factors.push({ name: 'Crisis headlines', score: Math.round(cNews), detail: `${Object.values(heads).filter(i => i.level !== 'info').length} flagged headlines, weight ${Math.round(W)} vs normal ${Math.round(baseW)}` });
  const g = items.find(i => i.tag === 'gdelt'); let cG = null;
  if (g) { cG = clamp((+g.value - 0.9) * 80); factors.push({ name: 'World conflict coverage (GDELT)', score: Math.round(cG), detail: `x${(+g.value).toFixed(2)} vs previous 6 days` }); }
  let cO = 0; const od = [];
  const thr = items.find(i => i.tag === 'threat');
  if (thr) { const tl = { LOW: 0, MODERATE: 10, SUBSTANTIAL: 25, SEVERE: 35, CRITICAL: 100 }[(thr.title.match(/: (\w+)$/) || [])[1]]; if (tl !== undefined) { cO = Math.max(cO, tl); od.push(thr.title.replace('UK threat level: ', 'Threat ')); } }
  const fc = items.filter(i => i.tag === 'travel' && i.level !== 'info').length; if (fc) { cO = Math.max(cO, Math.min(45, 15 * fc)); od.push(`${fc} 'against all travel' changes`); }
  const ga = items.filter(i => i.tag === 'alert' && i.level === 'critical').length; if (ga) { cO = Math.max(cO, 70); od.push('Emergency Alert sent'); }
  factors.push({ name: 'Official UK signals', score: Math.round(cO), detail: od.length ? od.join(', ') : 'Nothing unusual' });
  const parts = [[cNews, 0.4], [cO, 0.3]]; if (cG !== null) parts.push([cG, 0.3]);
  let score = parts.reduce((s, p) => s + p[0] * p[1], 0) / parts.reduce((s, p) => s + p[1], 0);
  const trip = [];
  for (const k of kw.critical) { const srcs = new Set(items.filter(i => i.panel === 'news' && ageHours(i.time) <= 24 && ` ${i.title} ${i.summary} `.toLowerCase().includes(k)).map(i => i.source)); if (srcs.size >= 2) trip.push(`'${k}' (${srcs.size} outlets)`); }
  const official = ga || (thr && /CRITICAL/.test(thr.title));
  if (trip.length) { score = Math.max(score, 66); factors.push({ name: 'Tripwire', score: 66, detail: trip.join(', ') }); }
  if (trip.length && official) score = Math.max(score, 90);
  if (!official) score = Math.min(score, 84);
  score = Math.round(score);
  const lv = score >= 85 ? 1 : score >= 65 ? 2 : score >= 45 ? 3 : score >= 25 ? 4 : 5;
  const NAMES = { 5: 'NORMAL', 4: 'RAISED', 3: 'ELEVATED', 2: 'SEVERE', 1: 'CRITICAL' };
  const MEAN = { 5: 'Background noise. Nothing beyond the usual world trouble.', 4: 'More conflict news than usual. Worth keeping an eye on.', 3: 'A significant crisis is building. Check supplies and fuel, keep phones charged.', 2: 'Grave events reported by several outlets. Top up water, fuel and cash; follow official advice closely.', 1: 'Confirmed national emergency. Follow official instructions; use your household plan.' };
  hist.push({ t: iso(now), s: score, w: W }); writeJson(histFile, hist);
  const byH = {}; for (const x of hist.filter(x => ageHours(x.t) <= 24 * 7)) { const k = iso(x.t).slice(0, 13); byH[k] = Math.max(byH[k] || 0, x.s); }
  const tension = { level: lv, name: NAMES[lv], score, meaning: MEAN[lv], factors, trend: Object.keys(byH).sort().map(k => byH[k]), learning: older.length < 48 };
  if (lv <= 2) {
    items.push(newItem({ id: `tension-${lv}-${iso(now).slice(0, 10)}`, name: 'World tension level', panel: 'tension' }, `World tension level ${lv} (${NAMES[lv]})`, '', iso(now), MEAN[lv], lv === 1 ? 'critical' : 'warning', false, 'tension'));
    overall = maxLevel(overall, lv === 1 ? 'critical' : 'warning'); reasons.push(`World tension level ${lv} (${NAMES[lv]})`);
  } else if (lv === 3) overall = maxLevel(overall, 'watch');

  // ---------- what's new (for notifications) ----------
  const seenFile = path.join(dataDir, 'seen.json');
  const seen = readJson(seenFile, {}); const firstRun = !Object.keys(seen).length; const fresh = [];
  for (const i of items) {
    if (!seen[i.id]) { seen[i.id] = iso(now); i.isNew = true; if (RANK[i.level] >= RANK.warning && (!i.isNews || i.local || i.level === 'critical')) fresh.push(i); }
    else i.isNew = ageHours(seen[i.id]) < 1;
    i.firstSeen = seen[i.id];
  }
  for (const k of Object.keys(seen)) if (ageHours(seen[k]) >= 24 * 14) delete seen[k];
  writeJson(seenFile, seen);

  const okN = sources.filter(s => s.ok === true).length, allN = sources.filter(s => s.ok !== null).length;
  log(`OK ${items.length} items from ${okN}/${allN} feeds, overall ${overall}, ${fresh.length} new serious`);
  return {
    data: { generated: iso(now), refreshMinutes: settings.refreshMinutes || 5, home: home.name, overall, reasons: [...new Set(reasons)].slice(0, 6), tension, power, charts, sources, items },
    fresh: firstRun ? [] : fresh
  };
}

module.exports = { collect, expandUrl };
