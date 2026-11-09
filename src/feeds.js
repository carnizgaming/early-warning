// Builds the feed list for wherever the user lives. Everything location-specific comes from settings.home.
'use strict';
const gn = q => 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-GB&gl=GB&ceid=GB:en';
const orq = list => list.filter(Boolean).map(w => (/\s/.test(w) ? `"${w}"` : w)).join(' OR ');

// Met Office warning RSS regions
const MET_REGIONS = {
  os: 'Orkney & Shetland', he: 'Highlands & Eilean Siar', gr: 'Grampian', st: 'Strathclyde', ta: 'Central, Tayside & Fife',
  dg: 'SW Scotland, Lothian Borders', ni: 'Northern Ireland', wl: 'Wales', nw: 'North West England', ne: 'North East England',
  yh: 'Yorkshire & Humber', wm: 'West Midlands', em: 'East Midlands', ee: 'East of England', sw: 'South West England', se: 'London & South East England'
};

function buildFeeds(s) {
  const h = s.home, lat = h.lat, lon = h.lon;
  const town = h.name || 'home';
  const localTerms = [...new Set([town, ...(h.localNews || [])])];
  const F = [];
  const add = f => F.push(f);

  // ---- official
  add({ id: 'govalerts', panel: 'official', name: 'GOV.UK Emergency Alerts', kind: 'govalerts', url: 'https://www.gov.uk/alerts/feed.atom', link: 'https://www.gov.uk/alerts' });
  add({ id: 'threat', panel: 'official', name: 'UK terrorism threat level (MI5)', kind: 'threat', url: 'https://www.mi5.gov.uk/UKThreatLevel/UKThreatLevel.xml', link: 'https://www.mi5.gov.uk/threat-levels' });
  // ---- weather
  const mr = h.metRegion || 'se';
  add({ id: 'metoffice', panel: 'weather', name: `Met Office warnings: ${MET_REGIONS[mr] || mr}`, kind: 'metoffice', url: `https://www.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/${mr}`, link: 'https://weather.metoffice.gov.uk/warnings-and-advice/uk-warnings' });
  add({ id: 'wind', panel: 'weather', name: 'Wind forecast for home (Open-Meteo)', kind: 'wind', everyMinutes: 30, url: `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=wind_gusts_10m,wind_speed_10m&wind_speed_unit=mph&forecast_days=3&timezone=GMT`, link: 'https://weather.metoffice.gov.uk/' });
  add({ id: 'aqi', panel: 'weather', name: 'Air quality forecast (Open-Meteo)', kind: 'aqi', everyMinutes: 60, url: `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=european_aqi,pm2_5&forecast_days=3&timezone=GMT`, link: 'https://uk-air.defra.gov.uk/' });
  // ---- floods
  if (h.country === 'Wales' || h.country === 'England') add({ id: 'eafloods', panel: 'floods', name: 'Flood warnings within 40 km (Environment Agency)', kind: 'eafloods', url: `https://environment.data.gov.uk/flood-monitoring/id/floods?lat=${lat}&long=${lon}&dist=40`, link: 'https://check-for-flooding.service.gov.uk/' });
  if (h.country === 'Wales') add({ id: 'nrwfloods', panel: 'floods', name: 'Flood warnings: Wales (NRW)', kind: 'link', link: 'https://naturalresources.wales/flooding/check-flood-warnings/' });
  if (h.country === 'Scotland') add({ id: 'sepa', panel: 'floods', name: 'Flood warnings: Scotland (SEPA)', kind: 'link', link: 'https://floodline.sepa.org.uk/floodupdates/' });
  if (h.country === 'Northern Ireland') add({ id: 'dfi', panel: 'floods', name: 'Flood information: Northern Ireland', kind: 'link', link: 'https://www.nidirect.gov.uk/articles/check-flood-warnings' });
  if (h.tideStation) add({ id: 'tide', panel: 'floods', name: `Tide gauge: ${h.tideStation.label} (Environment Agency)`, kind: 'tide', everyMinutes: 15, url: `https://environment.data.gov.uk/flood-monitoring/id/stations/${h.tideStation.id}`, link: `https://check-for-flooding.service.gov.uk/station/${h.tideStation.id}` });
  // ---- power
  if (h.dno === 'NGED') add({ id: 'powercuts', panel: 'power', name: 'Power cuts (National Grid Electricity Distribution)', kind: 'powercuts', url: 'https://connecteddata.nationalgrid.co.uk/dataset/d6672e1e-c684-4cea-bb78-c7e5248b62a2/resource/292f788f-4339-455b-8cc0-153e14509d4d/download/power_outage_ext.csv', link: 'https://powercuts.nationalgrid.co.uk/' });
  else add({ id: 'powercut105', panel: 'power', name: 'Power cuts: call 105 or check your network operator', kind: 'link', link: 'https://www.powercut105.com/', note: 'Live power-cut data is only built in for National Grid areas (South Wales, Midlands, South West). Open the link for your area.' });
  // ---- grid & gas
  add({ id: 'freq', panel: 'energy', name: 'Grid frequency (Elexon)', kind: 'freq', url: 'https://data.elexon.co.uk/bmrs/api/v1/datasets/FREQ?measurementDateTimeFrom={minus60m}&measurementDateTimeTo={now}&format=json', link: 'https://bmrs.elexon.co.uk/system-frequency' });
  add({ id: 'syswarn', panel: 'energy', name: 'Grid warnings (Elexon)', kind: 'syswarn', everyMinutes: 10, url: 'https://data.elexon.co.uk/bmrs/api/v1/system/warnings?publishDateTimeFrom={minus3d}&publishDateTimeTo={now}&format=json', link: 'https://bmrs.elexon.co.uk/system-warnings' });
  add({ id: 'gas-news', panel: 'energy', name: 'Gas supply news', kind: 'news', everyMinutes: 30, url: gn('("gas margins notice" OR "gas supply" OR "gas shortage" OR "National Gas" OR "energy rationing") UK when:7d'), link: 'https://www.nationalgas.com/balancing/margins-notices-and-gas-deficit-warnings' });
  // ---- local & roads
  if (h.country === 'Wales' && (h.roads || []).length) add({ id: 'traffic', panel: 'local', name: 'Traffic Wales live alerts', kind: 'traffic', everyMinutes: 10, url: 'https://traffic.wales/road-traffic-alerts', link: 'https://traffic.wales/road-traffic-alerts' });
  else if ((h.roads || []).length) add({ id: 'traffic-link', panel: 'local', name: 'Road incidents (National Highways / Traffic Scotland)', kind: 'link', link: h.country === 'Scotland' ? 'https://trafficscotland.org/currentincidents/' : 'https://nationalhighways.co.uk/travel-updates/' });
  if ((h.roads || []).length) add({ id: 'roads-news', panel: 'local', name: 'Roads news: ' + h.roads.slice(0, 3).join(', '), kind: 'news', everyMinutes: 20, url: gn(`(${orq(h.roads)}) (closed OR crash OR closure OR delays) when:2d`), link: 'https://nationalhighways.co.uk/travel-updates/' });
  if (h.paperRss) add({ id: 'paper', panel: 'local', name: h.paperName || 'Local paper', kind: 'news', url: h.paperRss, link: h.paperRss });
  add({ id: 'local-news', panel: 'local', name: `Local news (${localTerms.slice(0, 3).join(', ')})`, kind: 'news', everyMinutes: 20, url: gn(`(${orq(localTerms)}) when:3d`), link: 'https://news.google.com/' });
  // ---- news flashpoints
  add({ id: 'bbc-uk', panel: 'news', name: 'BBC UK', kind: 'news', url: 'https://feeds.bbci.co.uk/news/uk/rss.xml', link: 'https://www.bbc.co.uk/news/uk' });
  add({ id: 'bbc-world', panel: 'news', name: 'BBC World', kind: 'news', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', link: 'https://www.bbc.co.uk/news/world' });
  const nation = { Wales: 'wales', Scotland: 'scotland', 'Northern Ireland': 'northern_ireland' }[h.country];
  if (nation) add({ id: 'bbc-nation', panel: 'news', name: `BBC ${h.country}`, kind: 'news', url: `https://feeds.bbci.co.uk/news/${nation}/rss.xml`, link: `https://www.bbc.co.uk/news/${nation}` });
  add({ id: 'guardian-world', panel: 'news', name: 'Guardian World', kind: 'news', url: 'https://www.theguardian.com/world/rss', link: 'https://www.theguardian.com/world' });
  add({ id: 'aljazeera', panel: 'news', name: 'Al Jazeera', kind: 'news', url: 'https://www.aljazeera.com/xml/rss/all.xml', link: 'https://www.aljazeera.com/' });
  add({ id: 'gdelt', panel: 'tension', name: 'GDELT world conflict coverage', kind: 'gdelt', everyMinutes: 360, backoffMinutes: 360, url: 'https://api.gdeltproject.org/api/v2/doc/doc?query=(war%20OR%20missile%20OR%20airstrike%20OR%20invasion%20OR%20mobilization%20OR%20%22nuclear%20threat%22)%20sourcelang:english&mode=timelinevol&timespan=7d&format=json', link: 'https://www.gdeltproject.org/' });
  // ---- world
  add({ id: 'gdacs', panel: 'world', name: 'Global disasters (GDACS)', kind: 'gdacs', url: 'https://www.gdacs.org/xml/rss.xml', link: 'https://www.gdacs.org/' });
  add({ id: 'usgs', panel: 'world', name: 'Earthquakes M4.5+ (USGS)', kind: 'usgs', url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson', link: 'https://earthquake.usgs.gov/earthquakes/map/' });
  add({ id: 'bgs', panel: 'world', name: 'UK earthquakes (BGS)', kind: 'bgs', url: 'https://www.earthquakes.bgs.ac.uk/feeds/MhSeismology.xml', link: 'https://www.earthquakes.bgs.ac.uk/' });
  add({ id: 'nasa-eonet', panel: 'world', name: 'NASA natural events (EONET)', kind: 'eonet', everyMinutes: 30, url: 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=10', link: 'https://eonet.gsfc.nasa.gov/' });
  add({ id: 'fcdo', panel: 'world', name: 'FCDO travel advice changes', kind: 'fcdo', url: 'https://www.gov.uk/foreign-travel-advice.atom', link: 'https://www.gov.uk/foreign-travel-advice' });
  // ---- health & food
  add({ id: 'who', panel: 'health', name: 'WHO disease outbreak news', kind: 'who', everyMinutes: 60, url: 'https://www.who.int/api/news/diseaseoutbreaknews?$orderby=PublicationDate%20desc&$top=12', link: 'https://www.who.int/emergencies/disease-outbreak-news' });
  add({ id: 'ukhsa', panel: 'health', name: 'UK Health Security Agency news', kind: 'ukhsa', everyMinutes: 60, url: 'https://www.gov.uk/search/news-and-communications.atom?organisations%5B%5D=uk-health-security-agency', link: 'https://www.gov.uk/government/organisations/uk-health-security-agency' });
  add({ id: 'fsa', panel: 'health', name: 'Food Standards Agency alerts', kind: 'fsa', everyMinutes: 60, url: 'https://data.food.gov.uk/food-alerts/id?_limit=15&_sort=-created', link: 'https://www.food.gov.uk/news-alerts/search/alerts' });
  // ---- money & shipping
  add({ id: 'fx', panel: 'money', name: 'Pound exchange rates (Frankfurter / ECB)', kind: 'fx', everyMinutes: 120, url: 'https://api.frankfurter.dev/v1/{date40}..{today}?from=GBP&to=USD,EUR', link: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html' });
  add({ id: 'shipping-news', panel: 'money', name: 'Gulf and Red Sea shipping news (UKMTO)', kind: 'news', everyMinutes: 20, url: gn('(UKMTO OR "Strait of Hormuz" OR "Red Sea") (tanker OR vessel OR shipping) when:3d'), link: 'https://www.ukmto.org/' });
  // ---- space
  add({ id: 'kp', panel: 'space', name: 'Geomagnetic storm level (NOAA Kp)', kind: 'kp', url: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', link: 'https://www.swpc.noaa.gov/' });
  add({ id: 'swpc', panel: 'space', name: 'Solar flare and storm alerts (NOAA)', kind: 'swpc', url: 'https://services.swpc.noaa.gov/products/alerts.json', link: 'https://www.swpc.noaa.gov/products/alerts-watches-and-warnings' });
  add({ id: 'nasa-neo', panel: 'space', name: 'NASA asteroid close approaches', kind: 'neo', everyMinutes: 180, url: 'https://ssd-api.jpl.nasa.gov/cad.api?dist-max=0.02&date-min=now&date-max=%2B30&diameter=true&sort=dist', link: 'https://cneos.jpl.nasa.gov/ca/' });
  add({ id: 'nasa-sentry', panel: 'space', name: 'NASA Sentry impact risk', kind: 'sentry', everyMinutes: 360, url: 'https://ssd-api.jpl.nasa.gov/sentry.api', link: 'https://cneos.jpl.nasa.gov/sentry/' });
  add({ id: 'nasa-donki', panel: 'space', name: 'NASA space weather (DONKI)', kind: 'donki', everyMinutes: 30, backoffMinutes: 30, url: `https://api.nasa.gov/DONKI/notifications?type=all&api_key=${s.nasaKey || 'DEMO_KEY'}`, link: 'https://kauai.ccmc.gsfc.nasa.gov/DONKI/' });
  // ---- cyber
  add({ id: 'ncsc', panel: 'cyber', name: 'NCSC (UK cyber security)', kind: 'ncsc', url: 'https://www.ncsc.gov.uk/api/1/services/v1/all-rss-feed.xml', link: 'https://www.ncsc.gov.uk/' });
  add({ id: 'cloudflare', panel: 'cyber', name: 'Cloudflare status (internet backbone)', kind: 'status', url: 'https://www.cloudflarestatus.com/history.rss', link: 'https://www.cloudflarestatus.com/' });
  add({ id: 'ioda', panel: 'cyber', name: 'UK internet outages (IODA)', kind: 'ioda', everyMinutes: 15, url: 'https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts?entityType=country&entityCode=GB&from={unixMinus1d}&until={unixNow}', link: 'https://ioda.inetintel.cc.gatech.edu/country/GB' });

  const off = new Set(s.disabledFeeds || []);
  for (const f of F) if (off.has(f.id)) f.enabled = false;
  // test hook: point every feed at a local mock server
  if (s._mockBase) for (const f of F) if (f.url) f.url = s._mockBase + '/' + f.id + (f.url.includes('{') ? '?t={now}' : '');
  return F;
}

module.exports = { buildFeeds, MET_REGIONS };
