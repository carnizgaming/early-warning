// Headline keywords: critical > warning > watch. notWords knock a match down one level (e.g. 'trade war').
// A keyword must start a word ('nato' doesn't match 'senator'); see matcher() at the bottom for the other rules.
'use strict';
module.exports = {
 "critical": [
  "declares war",
  "declared war",
  "nuclear attack",
  "nuclear strike",
  "nuclear detonation",
  "article 5",
  "martial law",
  "national emergency",
  "attack on britain",
  "attack on the uk",
  "missile strike on uk",
  "general mobilisation",
  "general mobilization"
 ],
 "warning": [
  "invasion",
  "invade",
  "missile",
  "airstrike",
  "air strike",
  "mobilis",
  "mobiliz",
  "cyber attack",
  "cyber-attack",
  "cyberattack",
  "terror",
  "evacuat",
  "explosion",
  "state of emergency",
  "sabotage",
  "undersea cable",
  "pipeline",
  "chemical",
  "radiation",
  "pandemic",
  "outbreak",
  "riot",
  "curfew",
  "cobra",
  " at war",
  " war with",
  " war on ",
  "war in ",
  "power blackout",
  "nationwide blackout",
  "grid failure",
  "nuclear plant",
  "nuclear alert",
  "nuclear threat",
  "attacked",
  "seized",
  "hijack",
  "boarded",
  "struck by",
  "sea mine"
 ],
 "watch": [
  "russia",
  "iran",
  "china",
  "taiwan",
  "nato",
  "military",
  "troops",
  "drone",
  "warship",
  "sanctions",
  "escalat",
  "ministry of defence",
  "army",
  "strike action",
  "shortage",
  "power cut",
  "flood",
  "flooded",
  "storm",
  "nuclear",
  "blackout",
  "bridge closed",
  "road closed",
  "closed both ways",
  "motorway closed",
  "carriageway closed",
  "closed after",
  "closed due to",
  "burst main",
  "boil water",
  "no water",
  "gas leak"
 ],
 "notWords": [ "explained", "explainer", "podcast", "quiz", "obituary", "years ago", "revisiting", "nostalgia", "on this day", "memory lane", "from the archive", "looking back", "remember when",
  "trade war",
  "price war",
  "culture war",
  "war of words",
  "tariff war",
  "fake",
  "hoax",
  "false alarm",
  "drill ",
  "exercise",
  "anniversary",
  "film",
  "movie",
  "series",
  "game",
  "match",
  "football",
  "la liga",
  "premier league",
  "hacked alert",
  "hacked warning",
  "no, just"
 ],
 // A place or bloc on its own ('China', 'Iran') flags nothing: the headline also needs one of the eventWords, or another watch word.
 "places": [ "russia", "iran", "china", "taiwan", "nato" ],
 "eventWords": [ "attack", "strike", "struck", "missile", "drone", "troops", "military", "army", "navy", "naval", "warship", "war", "invasion", "invade",
  "sanction", "nuclear", "threat", "warn", "warned", "escalat", "clash", "shell", "shelled", "bomb", "bombed", "explosion", "explode", "kill", "killed",
  "dead", "death", "seize", "seized", "blockade", "mobilis", "mobiliz", "border", "incursion", "airspace", "intercept", "shot down", "shoots down",
  "sabotage", "cyber", "hack", "hacked", "spy", "spies", "espionage", "expel", "expelled", "ultimatum", "deploy", "annex", "reunification", "fighter jet",
  "incident", "tension", "conflict", "crisis", "coup", "detain", "arrest", "hostage", "ceasefire", "evacuat", "emergency", "retaliat", "fired",
  "blackout", "assault", "offensive", "raid" ],
 // Court and crime stories use the same words as crises ('seized', 'terror', 'attacked'). In the headline, these knock a match down one level.
 "courtWords": [ "court", "trial", "jailed", "sentenced", "guilty", "convicted", "charged with", "pleads", "pleaded", "inquest", "inquiry",
  "fraud", "stole", "stolen", "theft", "lawsuit", "sued", "tribunal" ],
 // Words with everyday meanings only count in full when one of these is also in the story; otherwise one level down.
 "needs": {
  "pipeline": [ "attack", "blast", "explosion", "explode", "exploded", "sabotage", "strike", "struck", "bomb", "drone", "missile", "rupture", "damage", "leak", "shut", "fire", "blown", "targeted", "hit by" ],
  "seized": [ "tanker", "vessel", "ship", "cargo", "navy", "naval", "strait", "hormuz", "troops", "forces", "army", "militar", "territory", "town", "city", "village", "embassy", "airport", "port", "border", "rebels", "militia", "coup", "parliament", "capital" ],
  "boarded": [ "tanker", "vessel", "ship", "navy", "naval", "coastguard", "coast guard", "strait", "hormuz", "armed", "troops", "forces", "pirates" ],
  "attacked": [ "troops", "forces", "army", "militar", "base", "embassy", "convoy", "tanker", "vessel", "ship", "drone", "missile", "rocket", "airstrike", "air strike", "border", "militants", "rebels", "houthi", "hezbollah", "hamas", "islamic state", "power station", "substation", "grid", "infrastructure", "pipeline", "nuclear", "airport" ],
  "explosion": [ "attack", "bomb", "missile", "drone", "strike", "terror", "sabotage", "militar", "embassy", "pipeline", "nuclear", "power station", "substation", "refinery", "depot", "airport", "city centre", "downtown", "parliament" ],
  "chemical": [ "attack", "weapon", "leak", "spill", "plant", "fire", "explosion", "release", "cloud", "evacuat", "incident", "agent" ],
  "radiation": [ "leak", "level", "alert", "nuclear", "plant", "reactor", "release", "cloud", "contamin", "exposure", "spike", "detected" ],
  "hijack": [ "plane", "aircraft", "airliner", "flight", "jet", "ship", "vessel", "tanker", "ferry", "bus", "train", "truck", "lorry", "convoy" ],
  "struck by": [ "missile", "drone", "rocket", "shell", "torpedo", "mine", "airstrike", "air strike", "bomb" ]
 }
};

// United States: same idea, with US places, agencies and road words instead of UK ones.
const GB = module.exports;
const swap = (list, out, add) => list.filter(k => !out.includes(k)).concat(add);
module.exports.US = {
 critical: swap(GB.critical, ['attack on britain', 'attack on the uk', 'missile strike on uk'], ['attack on america', 'attack on the united states', 'attack on the u.s.', 'attack on us soil', 'missile strike on us', 'defcon 1', 'defcon 2']),
 warning: swap(GB.warning, ['cobra'], ['national guard deployed', 'shelter in place', 'active shooter', 'grid emergency', 'rolling blackouts', 'energy emergency alert']),
 watch: swap(GB.watch, ['ministry of defence', 'motorway closed', 'carriageway closed', 'power cut'], ['pentagon', 'power outage', 'interstate closed', 'freeway closed', 'highway closed', 'boil water advisory', 'hurricane', 'tornado', 'wildfire', 'evacuation order']),
 notWords: swap(GB.notWords, ['la liga', 'premier league'], ['nfl', 'nba', 'mlb', 'super bowl', 'world series', 'playoff']),
 courtWords: GB.courtWords, needs: GB.needs, places: GB.places, eventWords: GB.eventWords
};

// matcher(lists) returns (title, summary) => [level, keyword]. The rules, each of which drops a match one level:
//   - a critical or warning keyword is only in the summary, not the headline (the story mentions it but isn't about it)
//   - the keyword is in "needs" and none of its companion words appear
//   - a notWord appears anywhere
//   - a courtWord appears in the headline (this one never drops a story below watch)
// And one that removes a flag: the only match is a place name and the headline has no event word or other watch word.
// Keywords match from the start of a word. Long ones (6+ letters in the last word) also match longer words
// ('evacuat' matches 'evacuated'); short ones only match the word itself plus a plain ending ('riot', 'riots', 'rioting').
const wordRe = k => {
  const last = k.trim().split(' ').pop();
  return new RegExp((/^[a-z0-9]/.test(k) ? '(?<![a-z0-9])' : '') + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    (/[a-z0-9]$/.test(k) && last.length < 6 ? '(?:s|es|ing|ers|ian|ians)?(?![a-z0-9])' : ''));
};
const DOWN = { critical: 'warning', warning: 'watch', watch: 'info', info: 'info' }, ORDER = ['critical', 'warning', 'watch'];
module.exports.matcher = kw => {
  const lists = ORDER.map(l => [l, (kw[l] || []).filter(Boolean).map(k => [k, wordRe(k)])]);
  const not = (kw.notWords || []).filter(Boolean).map(wordRe), court = (kw.courtWords || []).filter(Boolean).map(wordRe);
  const needs = Object.fromEntries(Object.entries(kw.needs || {}).map(([k, ws]) => [k, ws.map(wordRe)]));
  const places = new Set(kw.places || []), events = (kw.eventWords || []).filter(Boolean).map(wordRe);
  const otherWatch = (lists.find(([l]) => l === 'watch') || [0, []])[1].filter(([k]) => !places.has(k));
  const best = t => { for (const [l, ks] of lists) { const hit = ks.find(([, r]) => r.test(t)); if (hit) return [l, hit[0]]; } return ['info', '']; };
  return (title, summary = '') => {
    // "pre-pandemic levels" and "post-war Britain" are about a time, not an event
    const low = s => String(s).toLowerCase().replace(/(?<![a-z])(pre|post)-(pandemic|war|invasion)\b/g, ' ');
    const t = ' ' + low(title) + ' ', all = t + low(summary) + ' ';
    const inTitle = best(t), anywhere = best(all);
    let r = inTitle;
    if (anywhere[0] !== inTitle[0]) { const s = anywhere[0] === 'watch' ? anywhere : [DOWN[anywhere[0]], anywhere[1]]; if (r[0] === 'info' || ORDER.indexOf(s[0]) < ORDER.indexOf(r[0])) r = s; }
    if (r[0] === 'watch' && places.has(r[1]) && !events.some(x => x.test(t))) { const o = otherWatch.find(([, x]) => x.test(t)); r = o ? ['watch', o[0]] : ['info', '']; }
    if (needs[r[1]] && !needs[r[1]].some(x => x.test(all))) r = [DOWN[r[0]], r[1]];
    if (not.some(x => x.test(all))) r = [DOWN[r[0]], r[1]];
    if (r[0] !== 'watch' && court.some(x => x.test(t))) r = [DOWN[r[0]], r[1]];
    return r[0] === 'info' ? ['info', ''] : r;
  };
};
