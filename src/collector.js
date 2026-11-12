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
function fmtWhen(t, loc = 'en-GB', tz = 'Europe/London') { try { return new Date(t).toLocaleString(loc, { weekday: 'short', hour: loc === 'en-US' ? 'numeric' : '2-digit', minute: '2-digit', timeZone: tz }).replace(',', ''); } catch { return ''; } }
function titleCase(s) { return String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); }
function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } }
function writeJson(p, o) { const tmp = p + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(o)); fs.renameSync(tmp, p); }

function expandUrl(u) {
  const n = new Date(), d = x => iso(x), day = x => iso(x).slice(0, 10);
  return u.replace('{now}', d(n)).replace('{minus60m}', d(new Date(n - 3600e3))).replace('{minus1d}', d(new Date(n - 864e5)))
    .replace('{minus3d}', d(new Date(n - 3 * 864e5))).replace('{unixNow}', String(Math.floor(n / 1000)))
    .replace('{unixMinus1d}', String(Math.floor(n / 1000) - 86400)).replace('{date40}', day(new Date(n - 40 * 864e5))).replace('{today}', day(n))
    .replace('{date14}', day(new Date(n - 14 * 864e5))).replace('{date60}', day(new Date(n - 60 * 864e5)));
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
  const US = home.nation === 'US';
  const LOC = US ? 'en-US' : 'en-GB', TZ = home.timeZone || (US ? 'America/New_York' : 'Europe/London');
  const when = t => fmtWhen(t, LOC, TZ);
  const localWords = (home.localWords || []).map(w => w.toLowerCase()).filter(Boolean);
  const kw = settings.keywords || (US ? KW.US : KW);

  const isLocal = text => { const t = String(text).toLowerCase(); return localWords.some(w => t.includes(w)); };
  const keywordLevel = KW.matcher(kw);   // (title, summary) => [level, keyword]; the rules are in keywords.js
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
    const it = newItem(f, word ? `UK threat level: ${word}` : e.title, e.link, e.time, e.summary, lvl, false, 'threat');
    // for the world tension score: how much this adds, and whether it counts as official confirmation
    return [Object.assign(it, { value: { LOW: 0, MODERATE: 10, SUBSTANTIAL: 25, SEVERE: 35, CRITICAL: 100 }[word], short: word ? `Threat ${word}` : '', official: word === 'CRITICAL' })];
  };
  // DHS National Terrorism Advisory System: usually empty; a Bulletin, Elevated Alert or Imminent Alert when one is in force
  H.ntas = async f => {
    const doc = xml.parse(await getText(f.url)); const out = [];
    for (const a of arr(doc.alerts && doc.alerts.alert).filter(a => a && typeof a === 'object')) {   // an empty <alerts/> parses as ''
      const type = String(a['@type'] || txt(a.type) || 'Bulletin'), sum = stripHtml(deepText(a.summary) || deepText(a.details) || deepText(a));
      const end = a['@end'] || txt(a.end), start = a['@start'] || txt(a.start);
      if (end && toIso(end) && new Date(toIso(end)) < now) continue;
      const imminent = /imminent/i.test(type), elevated = /elevated/i.test(type);
      const it = newItem(f, `NTAS ${titleCase(type)}${end ? ' until ' + new Date(toIso(end) || end).toLocaleDateString(LOC, { day: 'numeric', month: 'short', year: 'numeric' }) : ''}`, a['@href'] || txt(a.link) || f.link, toIso(start) || iso(now), sum, imminent ? 'warning' : 'watch', false, 'threat');
      out.push(Object.assign(it, { value: imminent ? 70 : elevated ? 35 : 20, short: `NTAS ${titleCase(type)}`, official: imminent }));
    }
    if (!out.length) out.push(Object.assign(newItem(f, 'No National Terrorism Advisory System alert in force', f.link, iso(now), 'DHS issues a Bulletin, an Elevated Alert or an Imminent Alert when there is a specific terrorism threat to the US.', 'info', false, 'threat'), { value: 0, short: '' }));
    return out;
  };
  // National Weather Service alerts for the home point. One call, split three ways by mode so each lands in the right panel.
  const NWS_CIVIL = /civil (danger|emergency)|evacuation|shelter in place|nuclear power plant|radiological|hazardous materials|law enforcement|child abduction|911 telephone|local area emergency|blue alert|earthquake warning|volcano warning|fire warning/i;
  const NWS_FLOOD = /flood|hydrologic|storm surge|tsunami|coastal hazard|lakeshore/i;
  H.nws = async f => {
    const feats = arr((await getJson(f.url)).features).map(x => x.properties || {}).filter(p => p.status !== 'Test' && p.messageType !== 'Cancel');
    const pick = p => NWS_CIVIL.test(p.event) ? 'civil' : NWS_FLOOD.test(p.event) ? 'flood' : 'weather';
    const latest = {};
    for (const p of feats.filter(p => pick(p) === f.mode)) { const k = p.event; if (!latest[k] || String(p.sent) > String(latest[k].sent)) latest[k] = p; }
    return Object.values(latest).map(p => {
      let lvl = { Extreme: 'critical', Severe: 'warning', Moderate: 'watch' }[p.severity] || 'info';
      if (/warning|emergency/i.test(p.event) && lvl === 'watch') lvl = 'warning';
      if (f.mode === 'civil' && /evacuation immediate|shelter in place|civil danger/i.test(p.event)) lvl = 'critical';
      const until = p.ends || p.expires;
      return newItem(f, `${p.event}${until ? ' until ' + when(until) : ''}`, f.link, toIso(p.sent || p.effective), stripHtml(p.headline || p.description), lvl, true, f.mode === 'civil' ? 'alert' : f.mode);
    });
  };
  // FEMA disaster declarations for the home state (last 60 days), one line per disaster
  H.fema = async f => {
    const rows = arr((await getJson(f.url)).DisasterDeclarationsSummaries); const by = {};
    for (const r of rows) { const d = by[r.disasterNumber] || (by[r.disasterNumber] = { ...r, areas: [] }); d.areas.push(String(r.designatedArea || '')); }
    const myCounty = String(home.district || '').replace(/\s+(County|Parish|Borough)$/i, '').toLowerCase();
    const TYPE = { DR: 'Major disaster', EM: 'Emergency', FM: 'Fire management' };
    return Object.values(by).sort((a, b) => String(b.declarationDate).localeCompare(a.declarationDate)).slice(0, 8).map(d => {
      const local = d.areas.some(a => /statewide/i.test(a) || (myCounty && a.replace(/\s*\(.*\)/, '').trim().toLowerCase() === myCounty));
      const age = ageHours(d.declarationDate);
      const lvl = age <= 24 * 14 ? (local ? 'warning' : 'watch') : 'info';
      return newItem(f, `${TYPE[d.declarationType] || 'Declaration'}: ${titleCase(d.declarationTitle || d.incidentType)}`, `https://www.fema.gov/disaster/${d.disasterNumber}`, toIso(d.declarationDate), `${d.incidentType}. ${d.areas.length} area${d.areas.length === 1 ? '' : 's'} covered${local ? ', including yours' : ''}.`, lvl, local, 'fema');
    });
  };
  // National Hurricane Center: every active tropical system, rated by strength and distance from home
  H.nhc = async f => {
    const CLS = { TD: 'Tropical Depression', TS: 'Tropical Storm', HU: 'Hurricane', STD: 'Subtropical Depression', STS: 'Subtropical Storm', PTC: 'Post-Tropical Cyclone', PC: 'Potential Tropical Cyclone', TY: 'Typhoon' };
    return arr((await getJson(f.url)).activeStorms).map(x => {
      const mi = distKm(home.lat, home.lon, +x.latitudeNumeric, +x.longitudeNumeric) * 0.621371, mph = Math.round(+x.intensity * 1.15078), kt = +x.intensity;
      const cat = x.classification === 'HU' ? (kt >= 137 ? 5 : kt >= 113 ? 4 : kt >= 96 ? 3 : kt >= 83 ? 2 : 1) : 0;
      let lvl = 'info';
      if (x.classification === 'HU' && mi <= 350) lvl = cat >= 3 ? 'critical' : 'warning';
      else if (/HU|TS|STS/.test(x.classification) && mi <= 700) lvl = 'watch';
      return newItem(f, `${CLS[x.classification] || x.classification} ${x.name}${cat ? ` (Category ${cat})` : ''}: ${mph} mph winds, ${Math.round(mi).toLocaleString(LOC)} miles away`, (x.publicAdvisory && x.publicAdvisory.url) || f.link, toIso(x.lastUpdate), `Pressure ${x.pressure} mb.${mi <= 700 ? ' Close enough to watch: check the forecast cone at nhc.noaa.gov.' : ''}`, lvl, mi <= 350, 'tropical');
    });
  };
  // NOAA river gauge: latest stage against the official action/flood stages, last 48 h plus any forecast
  H.river = async f => {
    const g = await getJson(f.url); const cats = ((g.flood || {}).categories) || {};
    const stg = k => (cats[k] && +cats[k].stage > -999) ? +cats[k].stage : null;
    const S = { action: stg('action'), minor: stg('minor'), moderate: stg('moderate'), major: stg('major') };
    const obs = arr((await getJson(f.url + '/stageflow/observed').catch(() => ({}))).data).filter(d => +d.primary > -999 && ageHours(d.validTime) <= 48);
    const fc = arr((await getJson(f.url + '/stageflow/forecast').catch(() => ({}))).data).filter(d => +d.primary > -999 && ageHours(d.validTime) < 0);
    const so = (g.status || {}).observed || {}, sf = (g.status || {}).forecast || {};
    const v = obs.length ? +obs[obs.length - 1].primary : +so.primary;
    if (!(v > -999)) throw new Error('No recent river readings');
    const prev = obs.filter(d => ageHours(d.validTime) >= 3).slice(-1)[0];
    const trend = prev && v > +prev.primary + 0.2 ? 'rising' : prev && v < +prev.primary - 0.2 ? 'falling' : 'steady';
    const CAT = { action: 'near flood stage', minor: 'minor flooding', moderate: 'moderate flooding', major: 'major flooding' };
    const LV = { action: 'watch', minor: 'warning', moderate: 'warning', major: 'critical' };
    const oc = so.floodCategory, fcat = sf.floodCategory;
    let lvl = LV[oc] || 'info';
    if (LV[fcat]) lvl = maxLevel(lvl, { action: 'watch', minor: 'watch', moderate: 'warning', major: 'warning' }[fcat]);
    const peakF = fc.length ? fc.reduce((m, d) => +d.primary > +m.primary ? d : m) : null;
    const label = (home.riverGauge && home.riverGauge.label) || g.name;
    const it = newItem(f, `River at ${label}: ${v.toFixed(1)} ft, ${trend}${CAT[oc] ? ` (${CAT[oc]})` : ''}`, f.link, toIso((obs[obs.length - 1] || {}).validTime || so.validTime),
      `${S.minor !== null ? `Flooding starts at ${S.minor} ft` : 'No official flood stage'}${S.action !== null ? `; action stage ${S.action} ft` : ''}.${peakF ? ` Forecast peak ${(+peakF.primary).toFixed(1)} ft ${when(peakF.validTime)}${CAT[fcat] ? ` (${CAT[fcat]})` : ''}.` : ''}`, lvl, true, 'river');
    const all = obs.concat(fc); const step = Math.max(1, Math.floor(all.length / 150)); const pts = [];
    for (let k = 0; k < all.length; k += step) pts.push([toIso(all[k].validTime), Math.round(+all[k].primary * 100) / 100]);
    const peak = Math.max(...all.map(d => +d.primary));
    const refs = [['action', 'action'], ['minor', 'flood'], ['moderate', 'moderate'], ['major', 'major']].filter(([k], i) => S[k] !== null && (i < 2 || peak >= (S.action || S.minor || 0))).map(([k, l]) => ({ v: S[k], label: l }));
    it.chart = chart(`River level${fc.length ? ', last 48 h and forecast' : ', last 48 hours'}`, 'ft', pts, refs, fc.length > 0); return [it];
  };
  // NOAA tide station: water level as feet above normal high tide (MHHW), against the official coastal flood thresholds
  H.coops = async f => {
    const id = (f.url.match(/station=(\w+)/) || [])[1];
    const md = `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/${id}`;
    const [wl, fl, dat] = await Promise.all([getJson(f.url), getJson(md + '/floodlevels.json'), getJson(md + '/datums.json')]);
    const mhhw = +((arr(dat.datums).find(d => d.name === 'MHHW') || {}).value);
    if (isNaN(mhhw)) throw new Error('No MHHW datum for this station');
    const rd = arr(wl.data).filter(r => r.v !== '' && r.v !== null).map(r => ({ t: toIso(r.t.replace(' ', 'T') + 'Z'), v: +r.v - mhhw })).filter(r => r.t);
    if (!rd.length) throw new Error('No recent water levels');
    const th = k => { const x = fl['nws_' + k] || fl['nos_' + k]; return x ? x - mhhw : null; };
    const T = { minor: th('minor'), moderate: th('moderate'), major: th('major') };
    const last = rd[rd.length - 1], prev = rd.filter(r => ageHours(r.t) >= 0.5).slice(-1)[0];
    const trend = prev && last.v > prev.v + 0.05 ? 'rising' : prev && last.v < prev.v - 0.05 ? 'falling' : 'steady';
    const peak24 = Math.max(...rd.filter(r => ageHours(r.t) <= 24).map(r => r.v));
    let lvl = 'info', note = '';
    if (T.major !== null && peak24 >= T.major) { lvl = 'critical'; note = ' Reached MAJOR coastal flood level.'; }
    else if (T.moderate !== null && peak24 >= T.moderate) { lvl = 'warning'; note = ' Reached moderate coastal flood level.'; }
    // NWS levels: minor coastal flooding gets an Advisory (beaches, low roads), moderate and above a Warning
    else if (T.minor !== null && peak24 >= T.minor) { lvl = 'watch'; note = ' Reached minor (nuisance) coastal flood level: low-lying roads and beaches.'; }
    else if (T.minor !== null && peak24 >= T.minor - 0.5) { note = ' Within 6 inches of minor flooding.'; }
    const ft = x => (x >= 0 ? '+' : '') + x.toFixed(1) + ' ft';
    const label = (home.tideStation && home.tideStation.label) || id;
    const it = newItem(f, `Tide at ${label}: ${ft(last.v)} vs normal high tide, ${trend}`, f.link, last.t, `Highest in the last 24 h: ${ft(peak24)}.${note}${T.minor !== null ? ` Minor flooding starts at ${ft(T.minor)}.` : ''} A storm surge shows here hours before the water reaches streets.`, lvl, true, 'tide');
    const refs = [{ v: 0, label: 'normal high tide' }]; if (T.minor !== null) refs.push({ v: Math.round(T.minor * 100) / 100, label: 'minor flood' }); if (T.moderate !== null && peak24 >= T.minor) refs.push({ v: Math.round(T.moderate * 100) / 100, label: 'moderate flood' });
    const step = Math.max(1, Math.floor(rd.length / 150)); const pts = []; for (let k = 0; k < rd.length; k += step) pts.push([rd[k].t, Math.round(rd[k].v * 100) / 100]);
    it.chart = Object.assign(chart('Water level vs normal high tide, last 48 hours', 'ft', pts, refs), { allowNeg: true }); return [it];
  };
  // Wildfires (NIFC national incident feed) within 250 miles, nearest first
  H.fires = async f => {
    const j = await getJson(f.url); if (j.error) throw new Error(j.error.message || 'Fire service error');
    return arr(j.features).map(x => {
      const a = x.attributes || {}, g = x.geometry || {}; const mi = distKm(home.lat, home.lon, +g.y, +g.x) * 0.621371, ac = +a.IncidentSize || 0, pc = a.PercentContained;
      return { a, mi, ac, pc };
    }).sort((p, q) => p.mi - q.mi).slice(0, 10).map(({ a, mi, ac, pc }) => {
      let lvl = 'info';
      if (mi <= 15 && ac >= 100) lvl = 'warning'; else if (mi <= 15 || (mi <= 50 && ac >= 1000) || (mi <= 150 && ac >= 100000)) lvl = 'watch';
      if (lvl !== 'info' && pc !== null && +pc >= 90) lvl = 'info';
      const nm = titleCase(a.IncidentName || 'Unnamed'); const name = /fire|complex/i.test(nm) ? nm : nm + ' Fire';
      return newItem(f, `${name}: ${Math.round(ac).toLocaleString(LOC)} acres${pc !== null && pc !== undefined ? `, ${Math.round(pc)}% contained` : ''}, ${Math.round(mi)} mi away`, f.link, toIso(a.FireDiscoveryDateTime), `${String(a.POOState || '').replace(/^US-/, '')} wildfire. Smoke from big fires shows up in the air quality forecast.`, lvl, mi <= 25, 'fire');
    });
  };
  // Tsunami Warning Centers: only serious for you if the message names your state
  H.tsunami = async f => (await readFeed(f.url)).filter(e => ageHours(e.time) <= 72).slice(0, 6).map(e => {
    const t = `${e.title} ${e.summary}`; const mine = (home.state && new RegExp(`\\b${home.state}\\b`, 'i').test(t)) || isLocal(t);
    let lvl = 'info';
    if (/tsunami warning/i.test(t)) lvl = mine ? 'critical' : 'watch';
    else if (/tsunami advisory/i.test(t)) lvl = mine ? 'warning' : 'watch';
    else if (/tsunami watch/i.test(t)) lvl = mine ? 'warning' : 'info';
    return newItem(f, e.title.replace(/\s+/g, ' ').trim(), e.link || f.link, e.time, e.summary, lvl, mine, 'tsunami');
  });
  // Earthquakes near home (USGS)
  H.usgsnear = async f => arr((await getJson(f.url)).features).map(q => {
    const p = q.properties, c = q.geometry.coordinates, m = +p.mag, mi = distKm(home.lat, home.lon, +c[1], +c[0]) * 0.621371;
    const lvl = (m >= 5.5 && mi <= 100) ? 'warning' : (m >= 4.5 || (m >= 3.5 && mi <= 30)) ? 'watch' : 'info';
    return newItem(f, `M${m.toFixed(1)} earthquake, ${p.place}`, p.url, iso(p.time), `${Math.round(mi)} miles from ${home.name}.${p.tsunami === 1 ? ' Tsunami possible: check tsunami.gov.' : ''}`, lvl, mi <= 60, 'quake');
  });
  // FDA food recalls
  H.recall = async f => (await readFeed(f.url)).filter(e => ageHours(e.time) <= 24 * 21).slice(0, 15).map(e =>
    newItem(f, e.title, e.link, e.time, e.summary, /botulism|e\.? ?coli o157|outbreak|illnesses|death/i.test(`${e.title} ${e.summary}`) ? 'watch' : 'info', false, 'food'));
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
      // a news search repeats the headline as its summary and adds the outlet's name ("... Iran International"),
      // which must not count as a keyword
      const title = e.title.replace(/\s+-\s+[^-]{2,40}$/, ''), sum = e.summary.toLowerCase().startsWith(title.toLowerCase().slice(0, 40)) ? '' : e.summary;
      const text = `${e.title} ${sum}`; let k = keywordLevel(title, sum);
      // a topic search (shipping lanes) names its flashpoint countries in most headlines: there a watch needs an incident word too
      if (f.incident && k[0] === 'watch' && !f.incident.test(title)) k = ['info', ''];
      if ((f.must && !f.must.test(text)) || (f.skip && f.skip.test(text))) continue;   // news searches match loosely
      if (f.nearOnly && !isLocal(text) && !(home.state && text.includes(home.state))) continue;
      const it = newItem(f, title, e.link, e.time, sum, k[0], isLocal(text), k[1]);
      const outlet = txt(e.raw && e.raw.source).trim().replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''); if (outlet) it.outlet = outlet;   // news searches name the outlet of each result
      it.isNews = true; out.push(it);
    }
    return out;
  };
  H.gdacs = async f => (await readFeed(f.url)).filter(e => ageHours(e.time) <= 24 * 7).map(e => {
    const al = txt(e.raw.alertlevel); let lvl = /red/i.test(al) ? 'warning' : /orange/i.test(al) ? 'watch' : 'info';
    const local = (US ? /united states|\bUSA\b|\bU\.S\./i : /united kingdom|\bUK\b/i).test(e.title); if (local) lvl = maxLevel(lvl, 'warning');
    return lvl === 'info' ? null : newItem(f, e.title, e.link, e.time, e.summary, lvl, local, 'disaster');
  }).filter(Boolean);
  // A few dozen M4.5+ quakes happen every day. List the ones that matter (M6+, a USGS damage alert, a tsunami flag) and count the rest.
  H.usgs = async f => {
    const out = [], small = [];
    for (const q of arr((await getJson(f.url)).features)) {
      const p = q.properties, m = +p.mag, tsu = p.tsunami === 1, al = String(p.alert || 'none');
      let lvl = m >= 7.5 ? 'warning' : m >= 6.5 ? 'watch' : 'info'; if (tsu) lvl = maxLevel(lvl, 'watch');
      if (al === 'red') lvl = maxLevel(lvl, 'warning'); else if (al === 'orange') lvl = maxLevel(lvl, 'watch');
      if (lvl === 'info' && m < 6 && al !== 'yellow') { small.push({ m, place: p.place, t: p.time }); continue; }
      out.push(newItem(f, 'M' + m.toFixed(1) + ' earthquake, ' + p.place, p.url, iso(p.time), 'Alert: ' + al + '.' + (tsu ? ' Tsunami possible.' : ''), lvl, false, 'quake'));
    }
    if (small.length) {
      const big = small.reduce((a, b) => (b.m > a.m ? b : a));
      out.push(newItem(f, small.length + ' smaller earthquake' + (small.length === 1 ? '' : 's') + ' worldwide in the last 24 hours (largest M' + big.m.toFixed(1) + ', ' + big.place + ')', f.link,
        iso(Math.max(...small.map(s => s.t))), 'Magnitude 4.5 to 5.9 with no damage alert or tsunami flag. The full list is on the USGS map.', 'info', false, 'quake-summary'));
    }
    return out;
  };
  // UK quakes (BGS): tremors under magnitude 3 away from home are rarely even felt, so they share one row
  H.bgs = async f => {
    const out = [], small = [];
    for (const e of (await readFeed(f.url)).filter(e => ageHours(e.time) <= 24 * 14)) {
      const text = e.title + ' ' + e.summary, m = +((text.match(/M(?:L)?\s*(\d+(?:\.\d)?)/i) || [])[1] || 0), local = isLocal(text);
      if (m < 3 && !local) { small.push({ m, t: e.time, place: titleCase((e.title.match(/:\s*([^:]+?),\s*\w{3},\s*\d/) || [])[1] || '').replace(/,\s*/g, ', ') }); continue; }
      out.push(newItem(f, 'UK quake: ' + e.title.replace(/^UK Earthquake alert\s*:\s*/i, ''), e.link, e.time, e.summary, m >= 4 ? 'warning' : m >= 3 ? 'watch' : 'info', local, 'quake'));
    }
    if (small.length) {
      const big = small.reduce((a, b) => (b.m > a.m ? b : a));
      out.push(newItem(f, small.length + ' small UK tremor' + (small.length === 1 ? '' : 's') + ' in the last 14 days (largest M' + big.m.toFixed(1) + (big.place ? ', ' + big.place : '') + ')', f.link,
        small.map(s => s.t).sort().pop(), 'Under magnitude 3 and not near you. The full list is on the BGS site.', 'info', false, 'quake-summary'));
    }
    return out;
  };
  // Travel advice changes: the serious ones (against all travel, leave now) get a row each; routine edits share one
  H.fcdo = async f => {
    const out = [], routine = [];
    for (const e of (await readFeed(f.url)).filter(e => ageHours(e.time) <= 72).slice(0, 15)) {
      if (/against all travel|leave .* now|leave immediately|airspace|level 4|do not travel|ordered departure/i.test(e.title + ' ' + e.summary)) out.push(newItem(f, 'Travel advice: ' + e.title, e.link, e.time, e.summary, 'watch', false, 'travel'));
      else routine.push(e);
    }
    if (routine.length) {
      const names = routine.map(e => e.title.replace(/\s+-\s+.*$/, '').replace(/ travel advi[cs].*$/i, '').trim());
      out.push(newItem(f, routine.length + ' routine travel advice update' + (routine.length === 1 ? '' : 's') + ' in the last 3 days', f.link, routine.map(e => e.time).sort().pop(),
        names.slice(0, 10).join(', ') + (names.length > 10 ? ' and ' + (names.length - 10) + ' more' : '') + '.', 'info', false, 'travel-summary'));
    }
    return out;
  };
  H.kp = async f => {
    const j = await getJson(f.url); const last = j[j.length - 1];
    const kp = Array.isArray(last) ? +last[1] : +last.Kp, tt = Array.isArray(last) ? last[0] : last.time_tag;
    const g = kp >= 9 ? 'G5 extreme' : kp >= 8 ? 'G4 severe' : kp >= 7 ? 'G3 strong' : kp >= 6 ? 'G2 moderate' : kp >= 5 ? 'G1 minor' : 'no storm';
    const it = newItem(f, `Geomagnetic Kp ${kp.toFixed(1)}: ${g}`, f.link, toIso(String(tt).replace(' ', 'T') + (String(tt).endsWith('Z') ? '' : 'Z')), 'Kp 0-4 normal. G3+ storms can disrupt GPS, radio and, at G4-G5, power grids.', kp >= 9 ? 'critical' : kp >= 7 ? 'warning' : kp >= 5 ? 'watch' : 'info', false, 'kp');
    it.value = kp; return [it];
  };
  H.swpc = async f => { const had = new Set(); return (await getJson(f.url)).slice(0, 25).map(a => {
    const tm = toIso(String(a.issue_datetime).replace(' ', 'T') + 'Z'); if (ageHours(tm) > 72) return null;
    const msg = String(a.message || ''); const first = (msg.split(/\r?\n/).find(l => /^(ALERT|WARNING|WATCH|SUMMARY|EXTENDED WARNING|CANCEL)/.test(l)) || '').trim(); if (!first) return null;
    const lvl = /\bG[45]\b|K-index of [89]|X-?ray flux.*X\d|R[45]\b|S[45]\b/i.test(msg) ? 'warning' : /\bG3\b|K-index of 7|X-class|\bX\d/i.test(msg) ? 'watch' : 'info';
    if (had.has(first)) return null; had.add(first);   // the feed is newest first and reissues the same line: keep the newest
    return newItem(f, first, f.link, tm, '', lvl, false, 'space');
  }).filter(Boolean); };
  H.advisory = H.ncsc = async f => (await readFeed(f.url)).filter(e => ageHours(e.time) <= 24 * 14 && !(f.skip && f.skip.test(e.title))).slice(0, 12).map(e =>
    newItem(f, e.title, e.link, e.time, e.summary, /\balerts?\b|critical (vulnerabilit|flaw|bug|patch|update|security)|zero.day|actively exploited|under (active )?attack|urgent|ongoing (attack|campaign|incident|exploitation|threat)/i.test(e.title) ? 'watch' : 'info', false, 'cyber'));
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
    const it = newItem(f, `Gusts up to ${Math.round(max)} mph at ${home.name}, ${when(maxT)}`, f.link, iso(now), `Strongest steady wind ${Math.round(maxS)} mph in the next 48 hours. 50 mph+ brings down branches and fences; 60 mph+ means damage and bridge closures.`, max >= 60 ? 'warning' : max >= 50 ? 'watch' : 'info', true, 'wind');
    it.chart = chart('Wind gusts, next 48 hours', 'mph', pts, [{ v: 50, label: 'strong' }, { v: 60, label: 'damaging' }], true); return [it];
  };
  H.aqi = async f => {
    const j = await getJson(f.url); const pts = []; let max = 0, maxT = '';
    const series = f.scale === 'us' ? j.hourly.us_aqi : j.hourly.european_aqi;
    j.hourly.time.forEach((t, k) => { const tm = t + ':00Z', a = ageHours(tm); const v = series[k]; if (a > 1 || a < -48 || v === null) return; pts.push([tm, Math.round(+v)]); if (+v > max) { max = +v; maxT = tm; } });
    if (!pts.length) throw new Error('No air quality hours returned');
    if (f.scale === 'us') {   // US EPA AQI bands
      const band = max >= 301 ? 'hazardous' : max >= 201 ? 'very unhealthy' : max >= 151 ? 'unhealthy' : max >= 101 ? 'unhealthy for sensitive groups' : max >= 51 ? 'moderate' : 'good';
      const it = newItem(f, `Air quality: ${band} (AQI ${Math.round(max)}) at worst, ${when(maxT)}`, f.link, iso(now), 'US EPA air quality index for the next 48 hours. Wildfire smoke shows up here first.', max >= 201 ? 'warning' : max >= 151 ? 'watch' : 'info', true, 'aqi');
      it.chart = chart('Air quality index (US AQI), next 48 hours', 'AQI', pts, [{ v: 101, label: 'sensitive groups' }, { v: 151, label: 'unhealthy' }], true); return [it];
    }
    const band = max >= 100 ? 'extremely poor' : max >= 80 ? 'very poor' : max >= 60 ? 'poor' : max >= 40 ? 'moderate' : max >= 20 ? 'fair' : 'good';
    const it = newItem(f, `Air quality: ${band} (index ${Math.round(max)}) at worst, ${when(maxT)}`, f.link, iso(now), 'European air quality index for the next 48 hours. Smoke from big fires shows up here first.', max >= 100 ? 'warning' : max >= 80 ? 'watch' : 'info', true, 'aqi');
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
    const it = newItem(f, `Grid frequency ${last.toFixed(2)} Hz (last hour ${min.toFixed(2)} to ${max.toFixed(2)})`, f.link, toIso(d[d.length - 1].measurementTime), 'The whole GB grid runs at 50 Hz. Dips below 49.8 Hz mean power stations have tripped; 49.5 Hz is the legal lower limit; at 48.8 Hz automatic blackouts start, cutting off areas to save the rest of the grid.', lvl, false, 'freq');
    const step = Math.max(1, Math.floor(d.length / 120)); const pts = []; for (let k = 0; k < d.length; k += step) pts.push([toIso(d[k].measurementTime), Math.round(+d[k].frequency * 1000) / 1000]);
    it.chart = Object.assign(chart('Grid frequency, last hour', 'Hz', pts, [{ v: 49.8, label: 'low limit' }, { v: 50.2, label: 'high limit' }]), { min: 49.6, max: 50.4 }); return [it];
  };
  H.syswarn = async f => {
    // The operator reissues a notice several times and then cancels it, all under the same type. Newest first, keep one
    // row per notice (type + the period it covers), so the row shows the latest state and a cancellation says so.
    const out = [], done = new Set();
    for (const w of arr((await getJson(f.url)).data).sort((a, b) => String(b.publishTime).localeCompare(a.publishTime))) {
      // the text has literal "\n" in it; "full" is all of it (the period is often past the 300 characters the summary keeps)
      const type = String(w.warningType || '').trim(), full = String(w.warningText || '').replace(/<[^>]+>/g, ' ').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
      const t = stripHtml(full.replace(/^From\s*:.*?Control Centre\s*/i, '')), all = `${type} ${t}`;
      if (/SO-SO|TRADES/i.test(type)) continue;
      const pm = full.match(/period:?\s*from (\d\d):(\d\d) hrs to (\d\d):(\d\d) hrs on\s+\w+ (\d\d)\/(\d\d)\/(\d{4})/i);
      const key = type + '|' + (pm ? pm[0].toLowerCase().replace(/period:?\s*/, '') : full.split(/Notification Issued at|Issued by/i)[0].slice(0, 400));
      if (done.has(key)) continue; done.add(key);
      let period = '', ended = false;
      if (pm) {   // times are UK local; read as UTC, which in summer only keeps a notice "live" an hour longer
        const day = Date.UTC(+pm[7], +pm[6] - 1, +pm[5]), from = +pm[1] * 60 + +pm[2], to = +pm[3] * 60 + +pm[4];
        period = `${new Date(day).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} ${pm[1]}:${pm[2]} to ${pm[3]}:${pm[4]}`;
        ended = now.getTime() > day + (to + (to <= from ? 1440 : 0)) * 60000;
      }
      const cancelled = /cancel|withdraw/i.test(`${type} ${full}`);
      let lvl = 'info';
      if (!/IT systems? outage|systems? maintenance|planned outage of|BMRS|data publication/i.test(all)) {
        if (/demand control|demand reduction|load shedding|rota/i.test(all)) lvl = 'warning';
        else if (/margin|capacity market|system warning|nism|inadequate/i.test(all)) lvl = 'watch';
        if (cancelled || ended) lvl = 'info';
      }
      const it = newItem(f, 'Grid notice: ' + titleCase(type).replace(/\bIt\b/, 'IT') + (cancelled ? ' cancelled' : '') + (period ? (cancelled ? ` (was ${period})` : `, ${period}${ended ? ' (ended)' : ''}`) : ''), f.link, toIso(w.publishTime), t, lvl, false, 'syswarn');
      it.id = crypto.createHash('sha1').update(`${f.id}|${key}|${cancelled}`).digest('hex').slice(0, 16);   // titles can repeat; the notice itself can't
      out.push(it);
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
    const who = f.country || 'UK';
    return [newItem(f, al.length ? `${who} internet: ${al.length} outage signals in 24 h (${src})` : `${who} internet: no national outage signals in 24 h`, f.link, iso(now), 'IODA watches routing, probing and traffic for country-wide internet disruption.', crit >= 3 ? 'warning' : crit >= 1 ? 'watch' : 'info', false, 'ioda')];
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
      const ransom = /^known$/i.test(String(x.knownRansomwareCampaignUse || '').trim());   // the other value is "Unknown"
      out.push(newItem(f, `${x.cveID}: ${x.vulnerabilityName}${ransom ? ' (used by ransomware)' : ''}`, 'https://nvd.nist.gov/vuln/detail/' + x.cveID, x.dateAdded + 'T12:00:00Z', x.shortDescription || '', ransom ? 'watch' : 'info', false, 'kev'));
    }
    return out;
  };
  H.who = async f => arr((await getJson(f.url)).value).slice(0, 12).map(o => {
    const tm = toIso(o.PublicationDate); if (ageHours(tm) > 24 * 45) return null;
    const t = String(o.Title), sum = stripHtml(o.Summary);
    let lvl = /novel|unknown|undetermined|avian influenza|H5N1|H7N9|pandemic|ebola|marburg|MERS|SARS|nipah|plague/i.test(`${t} ${sum}`) ? 'watch' : 'info';   // fades after three days, like other notices
    const mine = US ? /United States of America|United States|\bUSA\b/i : /United Kingdom|\bUK\b|England|Wales|Scotland/i;
    if (mine.test(t)) lvl = 'warning';
    return newItem(f, t, 'https://www.who.int/emergencies/disease-outbreak-news/item/' + o.UrlName, tm, sum, lvl, mine.test(t), 'outbreak');
  }).filter(Boolean);
  // a health agency's news feed (UKHSA, CDC): amber for outbreak/alert items (a routine weekly publication never is)
  H.agency = H.ukhsa = async f => (await readFeed(f.url)).filter(e => ageHours(e.time) <= 24 * (f.days || 14) && (!f.match || String(e.title).toLowerCase().includes(f.match))).slice(0, 10).map(e =>
    newItem(f, stripHtml(e.title), e.link, e.time, e.summary, !f.routine && /outbreak|rise in cases|increase in cases|alert|pandemic|avian|measles|warning/i.test(`${e.title} ${e.summary}`) ? 'watch' : 'info', false, 'ukhsa'));
  H.fsa = async f => arr((await getJson(f.url)).items).slice(0, 15).map(a => {
    const tm = toIso(a.created); if (ageHours(tm) > 24 * 21) return null;
    const types = arr(a.type).join(' '); const kind = /FAFA/.test(types) ? 'Food alert for action' : /\/AA\b/.test(types) ? 'Allergy alert' : 'Recall';
    let risk = ''; try { risk = stripHtml(arr(a.problem)[0].riskStatement); } catch {}
    return newItem(f, `${kind}: ${a.title}`, a.alertURL, tm, risk, /FAFA/.test(types) ? 'watch' : 'info', false, 'food');
  }).filter(Boolean);
  H.fx = async f => {
    const j = await getJson(f.url); const days = Object.keys(j.rates || {}).sort();
    if (days.length < 5) throw new Error('Too few exchange rate days');
    // main = the rate charted (pound->dollar, or dollar->euro), other = the second currency shown
    const usdBase = f.base === 'USD';
    const usd = days.map(d => ({ d, v: +j.rates[d][usdBase ? 'EUR' : 'USD'], e: +j.rates[d][usdBase ? 'GBP' : 'EUR'] }));
    const n1 = usd[usd.length - 1], wk = usd[Math.max(0, usd.length - 6)], mo = usd[0];
    const c7 = (n1.v / wk.v - 1) * 100, c30 = (n1.v / mo.v - 1) * 100; const sg = x => (x >= 0 ? '+' : '') + x.toFixed(1);
    const title = usdBase ? `$1 = €${n1.v.toFixed(3)} / £${n1.e.toFixed(3)} (${sg(c7)}% this week, ${sg(c30)}% this month)` : `£1 = $${n1.v.toFixed(3)} / €${n1.e.toFixed(3)} (${sg(c7)}% this week, ${sg(c30)}% this month)`;
    const why = usdBase ? 'A sharp fall in the dollar makes imported goods dearer a few weeks later.' : 'A sharp fall in the pound pushes fuel and food prices up a few weeks later.';
    const it = newItem(f, title, f.link, n1.d + 'T16:00:00Z', why + ' Rates are the European Central Bank reference, once a working day.', c7 <= -6 ? 'warning' : c7 <= -3 ? 'watch' : 'info', false, 'fx');
    it.chart = chart(usdBase ? 'US dollar to euro, last 40 days' : 'Pound to US dollar, last 40 days', usdBase ? '€' : '$', usd.map(u => [u.d + 'T16:00:00Z', Math.round(u.v * 10000) / 10000]), []); return [it];
  };

  // ---------- run every feed (cache, back-off, last-good fallback) ----------
  let items = [], sources = [];
  await Promise.all(feeds.filter(f => f.enabled !== false).map(async f => {
    if (f.kind === 'link') { sources.push({ id: f.id, name: f.name, panel: f.panel, link: f.link, ok: null, count: 0, error: f.note || 'Open the link to check (no free feed)' }); return; }
    const h = H[f.kind]; if (!h) return;
    // US caches are kept apart: some handlers (GDACS, WHO) mark items local by nation, so a country switch mustn't reuse them
    const cacheFile = path.join(dataDir, `cache-${f.id}${US ? '-us' : ''}.json`), failFile = path.join(dataDir, `fail-${f.id}.txt`);
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

  // A flag is for something new: headlines, advisories and outbreak notices lose theirs after three days (the row stays, in grey)
  const FADE = new Set(['cyber', 'ukhsa', 'outbreak', 'kev', 'space', 'travel', 'status']);
  for (const i of items) if (i.level === 'watch' && (i.isNews || FADE.has(i.tag)) && ageHours(i.time) > 72) i.level = 'info';

  // ---------- same story from several outlets ----------
  // Outlets word the same story differently, so match on shared key words, not exact titles.
  // The most serious copy (then the first by feed order) leads; the rest become "also" on it.
  const newsRaw = items.filter(i => i.panel === 'news');
  const STOP = new Set('the and for with from after over says said amid into about than that this what when where which while will would could has have had not but are was were been its their they them his her him how why who new more most just still into onto out off top up down day week year years live latest update updates news report reports watch inside analysis explainer opinion'.split(' '));
  const keyWords = t => new Set(t.toLowerCase().replace(/['’]s\b/g, '').replace(/(\w)-(\w)/g, '$1$2').replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(w => w.length >= 3 && !STOP.has(w)).map(w => w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  // names (capitalised words) stop "39 die as boat sinks off Senegal" matching "13 die as boat sinks off Crete":
  // if both titles name things, they must share at least one
  const names = t => new Set((t.match(/\b[A-Z][a-zA-Z]+/g) || []).map(w => w.toLowerCase()).filter(w => w.length >= 3 && !STOP.has(w)));
  const share = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n; };
  const sameStory = (a, b, min, part) => { const n = share(a.w, b.w); return n >= min && n / Math.min(a.w.size, b.w.size) >= part && (!a.n.size || !b.n.size || share(a.n, b.n) > 0); };
  const mergeStories = (list, min, part) => {
    const stories = [];
    for (const i of [...list].sort((a, b) => RANK[b.level] - RANK[a.level])) {   // stable sort keeps feed order within a level
      const w = { w: keyWords(i.title), n: names(i.title) }; const s = stories.find(s => sameStory(s.w, w, min, part));
      if (s) { s.lead.also = s.lead.also || []; s.lead.also.push({ source: i.outlet || i.source, title: i.title, link: i.link }); s.lead.sameStory.push(i.id); i.merged = true; }
      else { i.sameStory = []; stories.push({ lead: i, w }); }
    }
  };
  mergeStories(newsRaw, 3, 0.5);
  // The other panels' news comes from topic searches (shipping, gas supply, local), where every headline shares the search
  // words. Ask for more in common there, so two different tanker incidents in the same strait stay apart.
  const topical = {}; for (const i of items) if (i.isNews && i.panel !== 'news') (topical[i.panel] = topical[i.panel] || []).push(i);
  for (const list of Object.values(topical)) mergeStories(list, 4, 0.6);
  for (let k = items.length - 1; k >= 0; k--) if (items[k].merged) items.splice(k, 1);
  for (const i of newsRaw) delete i.merged;
  for (const list of Object.values(topical)) for (const i of list) delete i.merged;

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
  // The terrorism threat level sits at the same value for months or years. It is flagged for a week after it changes and
  // is then shown in grey, so a long-standing level doesn't hold the status at WATCH for ever.
  const stFile = path.join(dataDir, 'standing.json'), st = readJson(stFile, {});
  const threatFeeds = [...new Set(items.filter(i => i.tag === 'threat').map(i => i.feed))];
  for (const id of threatFeeds) {
    const mine = items.filter(i => i.tag === 'threat' && i.feed === id), sig = mine.map(i => i.title).sort().join(' | ');
    if (!st[id]) st[id] = { sig, since: null };                       // first run: no way to tell when it last changed
    else if (st[id].sig !== sig) st[id] = { sig, since: iso(now) };
    for (const i of mine) {
      const since = st[id].since || i.time;
      if (since && ageHours(since) <= 24 * 7) i.changed = since;
      else if (i.level === 'watch') { i.level = 'info'; i.standing = true; }
    }
  }
  if (threatFeeds.length) writeJson(stFile, st);

  // The status is for things that need attention here and now. A watch counts when it is near you, or comes from an official
  // or measured source for your area. Flagged world news, shipping, cyber, health and space items stay in their panels (and
  // feed the tension level) without holding the status at WATCH. Anything rated warning or above still counts, wherever it is.
  let overall = 'info'; const why = [];
  const HERE = ['official', 'weather', 'floods', 'power'];
  for (const i of items) {
    let l = i.level;
    if ((i.isNews || ['world', 'space', 'cyber', 'health', 'money'].includes(i.panel)) && l === 'warning' && !i.local) l = 'watch';
    if (i.isNews && RANK[l] > RANK.warning) l = 'warning';
    if (i.level === 'watch' && !(i.local || HERE.includes(i.panel) || (!i.isNews && ['energy', 'local'].includes(i.panel)))) l = 'info';
    if (l !== 'info') why.push([l, i.title]);
    overall = maxLevel(overall, l);
  }

  // ---------- world tension level ----------
  const clamp = x => Math.max(0, Math.min(100, x));
  const factors = [];
  const heads = {}; for (const i of items.filter(i => i.panel === 'news')) { const k = i.title.toLowerCase().replace(/[^a-z0-9 ]/g, ''); if (!heads[k]) heads[k] = i; }
  // each story counts once, plus a quarter for each extra outlet covering it (up to two): wide coverage matters, but not threefold
  let W = 0; for (const i of Object.values(heads)) W += { info: 0, watch: 0.5, warning: 2, critical: 6 }[i.level] * (1 + 0.25 * Math.min(2, new Set((i.also || []).map(a => a.source).filter(s => s !== (i.outlet || i.source))).size));
  const histFile = path.join(dataDir, 'tension-history.json');
  let hist = readJson(histFile, []).filter(x => x && ageHours(x.t) < 24 * 14);
  // Scoring got stricter in 1.0.3 (same story counted once, fewer keyword false alarms), so older history reads too high.
  // Rescale it once by how the newest old reading compares with now, so "normal" doesn't sit too high for two weeks.
  const HV = 2, lastOld = [...hist].reverse().find(x => x.v !== HV);
  if (lastOld) { const k = lastOld.w > 0 ? Math.max(0.3, Math.min(1, W / lastOld.w)) : 1; for (const x of hist) if (x.v !== HV) { x.w = Math.round(x.w * k * 100) / 100; x.v = HV; } }
  const older = hist.filter(x => ageHours(x.t) > 24).map(x => +x.w).sort((a, b) => a - b);
  let baseW = older.length >= 48 ? older[Math.floor(older.length / 2)] : (settings.tension && settings.tension.newsBaseline) || 14;   // typical weight of a quiet day, used until there's a day of history if (baseW < 5) baseW = 5;
  const cNews = clamp((W / baseW - 0.8) * 60);
  factors.push({ name: 'Crisis headlines', score: Math.round(cNews), detail: `${Object.values(heads).filter(i => i.level !== 'info').length} flagged stories, weight ${Math.round(W)} vs normal ${Math.round(baseW)}` });
  const g = items.find(i => i.tag === 'gdelt'); let cG = null;
  if (g) { cG = clamp((+g.value - 0.9) * 80); factors.push({ name: 'World conflict coverage (GDELT)', score: Math.round(cG), detail: `x${(+g.value).toFixed(2)} vs previous 6 days` }); }
  let cO = 0; const od = [];
  const thr = items.filter(i => i.tag === 'threat' && i.value !== undefined).sort((a, b) => b.value - a.value)[0];
  if (thr) { cO = Math.max(cO, thr.value); if (thr.short) od.push(thr.short); }
  const fc = items.filter(i => i.tag === 'travel' && i.level !== 'info').length; if (fc) { cO = Math.max(cO, Math.min(45, 15 * fc)); od.push(US ? `${fc} 'Level 4: Do Not Travel' changes` : `${fc} 'against all travel' changes`); }
  const ga = items.filter(i => i.tag === 'alert' && i.level === 'critical').length; if (ga) { cO = Math.max(cO, 70); od.push(US ? 'Civil emergency alert for your area' : 'Emergency Alert sent'); }
  factors.push({ name: US ? 'Official US signals' : 'Official UK signals', score: Math.round(cO), detail: od.length ? od.join(', ') : 'Nothing unusual' });
  const parts = [[cNews, 0.4], [cO, 0.3]]; if (cG !== null) parts.push([cG, 0.3]);
  let score = parts.reduce((s, p) => s + p[0] * p[1], 0) / parts.reduce((s, p) => s + p[1], 0);
  const trip = [];
  for (const k of kw.critical) { const srcs = new Set(newsRaw.filter(i => ageHours(i.time) <= 24 && ` ${i.title} ${i.summary} `.toLowerCase().includes(k)).map(i => i.source)); if (srcs.size >= 2) trip.push(`'${k}' (${srcs.size} outlets)`); }
  const official = ga || (thr && thr.official);
  if (trip.length) { score = Math.max(score, 66); factors.push({ name: 'Tripwire', score: 66, detail: trip.join(', ') }); }
  if (trip.length && official) score = Math.max(score, 90);
  if (!official) score = Math.min(score, 84);
  score = Math.round(score);
  const lv = score >= 85 ? 1 : score >= 65 ? 2 : score >= 45 ? 3 : score >= 25 ? 4 : 5;
  const NAMES = { 5: 'NORMAL', 4: 'RAISED', 3: 'ELEVATED', 2: 'SEVERE', 1: 'CRITICAL' };
  const MEAN = { 5: 'Background noise. Nothing beyond the usual world trouble.', 4: 'More conflict news than usual. Worth keeping an eye on.', 3: 'A significant crisis is building. Check supplies and fuel, keep phones charged.', 2: 'Grave events reported by several outlets. Top up water, fuel and cash; follow official advice closely.', 1: 'Confirmed national emergency. Follow official instructions; use your household plan.' };
  hist.push({ t: iso(now), s: score, w: W, v: HV }); writeJson(histFile, hist);
  const byH = {}; for (const x of hist.filter(x => ageHours(x.t) <= 24 * 7)) { const k = iso(x.t).slice(0, 13); byH[k] = Math.max(byH[k] || 0, x.s); }
  const tension = { level: lv, name: NAMES[lv], score, meaning: MEAN[lv], factors, trend: Object.keys(byH).sort().map(k => byH[k]), learning: older.length < 48 };
  if (lv <= 2) {
    items.push(newItem({ id: `tension-${lv}-${iso(now).slice(0, 10)}`, name: 'World tension level', panel: 'tension' }, `World tension level ${lv} (${NAMES[lv]})`, '', iso(now), MEAN[lv], lv === 1 ? 'critical' : 'warning', false, 'tension'));
    overall = maxLevel(overall, lv === 1 ? 'critical' : 'warning'); why.push([lv === 1 ? 'critical' : 'warning', `World tension level ${lv} (${NAMES[lv]})`]);
  } else if (lv === 3) { overall = maxLevel(overall, 'watch'); why.push(['watch', `World tension level 3 (${NAMES[3]})`]); }
  // the most serious reasons first
  const reasons = [...new Set(why.sort((a, b) => RANK[b[0]] - RANK[a[0]]).map(x => x[1]))].slice(0, 6);

  // ---------- what's new (for notifications) ----------
  const seenFile = path.join(dataDir, 'seen.json');
  const seen = readJson(seenFile, {}); const firstRun = !Object.keys(seen).length; const fresh = [], live = new Set();
  for (const i of items) {
    // a merged story counts as seen if any outlet's copy was seen, so a change of lead outlet doesn't notify again
    const ids = [i.id, ...(i.sameStory || [])], prev = ids.map(x => seen[x]).filter(Boolean).sort()[0];
    if (!prev) { i.isNew = true; if (RANK[i.level] >= RANK.warning && (!i.isNews || i.local || i.level === 'critical')) fresh.push(i); }
    else i.isNew = ageHours(prev) < 1;
    for (const x of ids) { live.add(x); if (!seen[x]) seen[x] = prev || iso(now); }
    i.firstSeen = prev || iso(now); delete i.sameStory;
  }
  // forget items that have gone; one still showing keeps its first-seen time, or it would turn NEW again every two weeks
  for (const k of Object.keys(seen)) if (!live.has(k) && ageHours(seen[k]) >= 24 * 14) delete seen[k];
  writeJson(seenFile, seen);

  const okN = sources.filter(s => s.ok === true).length, allN = sources.filter(s => s.ok !== null).length;
  log(`OK ${items.length} items from ${okN}/${allN} feeds, overall ${overall}, ${fresh.length} new serious`);
  return {
    data: { generated: iso(now), refreshMinutes: settings.refreshMinutes || 5, home: home.name, nation: US ? 'US' : 'GB', region: home.region || '', country: home.country || '', overall, reasons, tension, power, charts, sources, items },
    fresh: firstRun ? [] : fresh
  };
}

module.exports = { collect, expandUrl };
