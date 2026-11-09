// Turns a UK postcode into everything the feeds need: map position, nation/region, Met Office region,
// whether National Grid's power-cut data covers it, neighbouring postcode districts and the nearest tide gauge.
'use strict';
const UA = { 'User-Agent': 'EarlyWarningDashboard/1.0 (personal use)' };
async function j(url) { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json(); }
const first = v => Array.isArray(v) ? v[0] : v;

const ENGLAND_MET = { 'North East': 'ne', 'North West': 'nw', 'Yorkshire and The Humber': 'yh', 'West Midlands': 'wm', 'East Midlands': 'em', 'East of England': 'ee', London: 'se', 'South East': 'se', 'South West': 'sw' };
function metRegionFor(country, region, lat, lon) {
  if (country === 'Wales') return 'wl';
  if (country === 'Northern Ireland') return 'ni';
  if (country === 'Scotland') {
    if (lat > 59) return 'os';
    if (lat > 57.3 && lon < -3.9) return 'he';
    if (lat > 56.7 && lon >= -3.9) return 'gr';
    if (lat < 55.9 && lon < -3.6) return 'dg';
    if (lon > -3.9) return 'ta';
    return 'st';
  }
  return ENGLAND_MET[region] || 'se';
}
// National Grid Electricity Distribution: South Wales, West Midlands, East Midlands, South West England
function dnoFor(country, region, lat) {
  if (country === 'Wales') return lat < 52.35 ? 'NGED' : 'SPEN';
  if (['West Midlands', 'East Midlands', 'South West'].includes(region)) return 'NGED';
  return 'other';
}

async function locate(postcode) {
  const pc = String(postcode || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!pc) throw new Error('Enter a postcode');
  let r, outcode;
  if (/\d[A-Z]{2}$/.test(pc.replace(/\s/g, ''))) {   // full postcode
    r = (await j('https://api.postcodes.io/postcodes/' + encodeURIComponent(pc))).result;
    outcode = r.outcode;
  } else {                                             // district only, e.g. SW1A
    r = (await j('https://api.postcodes.io/outcodes/' + encodeURIComponent(pc))).result;
    outcode = r.outcode;
  }
  const lat = +r.latitude, lon = +r.longitude;
  const country = first(r.country), region = first(r.region) || '';
  const districts = [].concat(r.admin_district || []).filter(Boolean), district = districts[0] || '';
  const parishes = [].concat(r.parish || []).map(p => String(p).replace(/,.*$/, '').trim()).filter(p => p && !/unparished/i.test(p));
  // a full postcode gives one parish (the town or village); a district gives a list, so use the council name
  const place = (!Array.isArray(r.parish) && parishes[0]) || district || outcode;
  let near = [];
  try { near = ((await j(`https://api.postcodes.io/outcodes/${encodeURIComponent(outcode)}/nearest?radius=20000&limit=15`)).result || []).map(x => x.outcode).filter(o => o !== outcode); } catch {}
  let tideStation = null;
  if (country === 'England' || country === 'Wales') {
    try {
      const st = (await j(`https://environment.data.gov.uk/flood-monitoring/id/stations?parameter=level&lat=${lat}&long=${lon}&dist=40`)).items || [];
      const R = Math.PI / 180, dist = s => { const a = Math.sin((s.lat - lat) * R / 2) ** 2 + Math.cos(lat * R) * Math.cos(s.lat * R) * Math.sin((s.long - lon) * R / 2) ** 2; return 12742 * Math.asin(Math.sqrt(a)); };
      const tidal = st.filter(s => /tidal/i.test(JSON.stringify(s.measures || '') + ' ' + (s.qualifier || '') + ' ' + (s.riverName || '')) && s.lat && (!s.status || !/closed/i.test(String(s.status))));
      tidal.sort((a, b) => dist(a) - dist(b));
      if (tidal[0]) tideStation = { id: tidal[0].stationReference || tidal[0].notation, label: String(tidal[0].label || tidal[0].town || 'tide gauge').replace(/\s+/g, ' '), km: Math.round(dist(tidal[0])) };
    } catch {}
  }
  return {
    postcode: pc, name: place || outcode, lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000,
    country, region, district, postcodes: [outcode], nearPostcodes: near,
    metRegion: metRegionFor(country, region, lat, lon), dno: dnoFor(country, region, lat), tideStation,
    localWords: [...new Set([place, ...parishes, ...districts].filter(Boolean).map(s => s.toLowerCase()))],
    localNews: [...new Set([place, ...parishes.slice(0, 5), ...districts].filter(Boolean))].slice(0, 8), roads: []
  };
}

module.exports = { locate, metRegionFor, dnoFor };
