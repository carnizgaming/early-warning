// Turns a UK postcode or a US ZIP code into everything the feeds need.
// UK: map position, nation/region, Met Office region, whether National Grid's power-cut data covers it,
//     neighbouring postcode districts and the nearest tide gauge.
// US: map position, state and county, National Weather Service office and time zone, the nearest river gauge
//     with flood stages and the nearest NOAA tide station with flood levels.
'use strict';
const UA = { 'User-Agent': 'EarlyWarningDashboard/1.0 (personal use)' };
async function j(url) { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json(); }
const first = v => Array.isArray(v) ? v[0] : v;
const distKm = (a1, o1, a2, o2) => { const r = Math.PI / 180; const a = Math.sin((a2 - a1) * r / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin((o2 - o1) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(a)); };
const isZip = s => /^\d{5}(-?\d{4})?$/.test(String(s || '').trim());

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

async function locateUK(postcode) {
  const pc = String(postcode || '').trim().toUpperCase().replace(/\s+/g, ' ');
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
      const dist = s => distKm(lat, lon, s.lat, s.long);
      const tidal = st.filter(s => /tidal/i.test(JSON.stringify(s.measures || '') + ' ' + (s.qualifier || '') + ' ' + (s.riverName || '')) && s.lat && (!s.status || !/closed/i.test(String(s.status))));
      tidal.sort((a, b) => dist(a) - dist(b));
      if (tidal[0]) tideStation = { id: tidal[0].stationReference || tidal[0].notation, label: String(tidal[0].label || tidal[0].town || 'tide gauge').replace(/\s+/g, ' '), km: Math.round(dist(tidal[0])) };
    } catch {}
  }
  return {
    nation: 'GB', postcode: pc, name: place || outcode, lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000,
    country, region, district, postcodes: [outcode], nearPostcodes: near,
    metRegion: metRegionFor(country, region, lat, lon), dno: dnoFor(country, region, lat), tideStation,
    localWords: [...new Set([place, ...parishes, ...districts].filter(Boolean).map(s => s.toLowerCase()))],
    localNews: [...new Set([place, ...parishes.slice(0, 5), ...districts].filter(Boolean))].slice(0, 8), roads: []
  };
}

const COUNTY_WORD = { LA: 'Parish', AK: 'Borough' };
async function locateUS(input) {
  const zip = String(input).trim().slice(0, 5);
  let r;
  try { r = await j('https://api.zippopotam.us/us/' + zip); } catch (e) { throw new Error(/404/.test(e.message) ? 'ZIP code not found' : e.message); }
  const p = (r.places || [])[0]; if (!p) throw new Error('ZIP code not found');
  const lat = +p.latitude, lon = +p.longitude, place = p['place name'], state = p.state, st = p['state abbreviation'];
  // National Weather Service: forecast office, time zone and county for this point
  let nws = {}, county = '';
  try { nws = (await j(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`)).properties || {}; } catch {}
  try { if (nws.county) county = (await j(nws.county)).properties.name || ''; } catch {}
  const alias = (county.match(/\(([^)]+)\)/) || [])[1] || '';            // "New York (Manhattan)" -> also watch for "Manhattan"
  county = county.replace(/\s*\([^)]*\)/g, '').trim();
  const countyName = county ? `${county} ${COUNTY_WORD[st] || 'County'}` : '';
  // nearest river gauge (within 40 km) that has official flood stages
  let riverGauge = null;
  try {
    const g = ((await j(`https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=${lon - 0.5}&bbox.ymin=${lat - 0.4}&bbox.xmax=${lon + 0.5}&bbox.ymax=${lat + 0.4}&srid=EPSG_4326`)).gauges || [])
      .filter(x => x.status && x.status.observed && !/not_defined|obs_not_current/.test(x.status.observed.floodCategory || 'not_defined'))
      .filter(x => !/tide|\bNOS\b|MLLW|harbor at/i.test(x.name || ''))   // coastal tide gauges are covered by the tide station

      .map(x => ({ id: x.lid, label: String(x.name || x.lid).replace(/\s+/g, ' '), km: distKm(lat, lon, x.latitude, x.longitude) }))
      .filter(x => x.km <= 40).sort((a, b) => a.km - b.km);
    if (g[0]) riverGauge = { ...g[0], km: Math.round(g[0].km) };
  } catch {}
  // nearest NOAA tide station (within 40 km) that has official flood levels
  let tideStation = null;
  try {
    const all = ((await j('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels')).stations || [])
      .map(x => ({ id: x.id, label: x.name, km: distKm(lat, lon, +x.lat, +x.lng) })).filter(x => x.km <= 40).sort((a, b) => a.km - b.km);
    for (const s of all.slice(0, 3)) {
      const fl = await j(`https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/${s.id}/floodlevels.json`).catch(() => ({}));
      if (fl.nos_minor || fl.nws_minor) { tideStation = { ...s, km: Math.round(s.km) }; break; }
    }
  } catch {}
  return {
    nation: 'US', postcode: zip, name: place, lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000,
    country: 'United States', region: state, state, stateAbbr: st, district: countyName,
    nwsOffice: nws.cwa || '', timeZone: nws.timeZone || '', riverGauge, tideStation,
    localWords: [...new Set([place, countyName, alias].filter(Boolean).map(s => s.toLowerCase()))],
    localNews: [...new Set([place, alias, countyName].filter(Boolean))], roads: []
  };
}

async function locate(code) {
  const s = String(code || '').trim();
  if (!s) throw new Error('Enter a postcode or ZIP code');
  return isZip(s) ? locateUS(s) : locateUK(s);
}

module.exports = { locate, metRegionFor, dnoFor, isZip };
