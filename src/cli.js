// Run one collection from the command line (no Electron): node src/cli.js [settings.json] [dataDir]
'use strict';
const fs = require('fs'), path = require('path');
const { collect } = require('./collector');
const { buildFeeds } = require('./feeds');
const settings = JSON.parse(fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'test-settings.json'), 'utf8'));
const dataDir = process.argv[3] || path.join(__dirname, '..', 'test-data');
collect(settings, buildFeeds(settings), dataDir, m => console.log(m)).then(r => {
  fs.writeFileSync(path.join(dataDir, 'data.json'), JSON.stringify(r.data));
  console.log('fresh', r.fresh.length);
}).catch(e => { console.error('FATAL', e); process.exit(1); });
