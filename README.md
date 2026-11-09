# Early Warning

A desktop early-warning board for wherever you live in the UK or the US. It pulls free public feeds every few minutes and shows them on one screen, with a coloured tray icon and pop-up notifications when something serious happens.

**Download:** see [Releases](../../releases/latest). Install notes are in [INSTALL.txt](INSTALL.txt).

## What it watches (UK)
- **Official:** GOV.UK Emergency Alerts, UK terrorism threat level
- **Weather & air:** Met Office warnings for your region, 48-hour wind gust forecast, air quality
- **Floods & tides:** Environment Agency flood warnings, nearest tide gauge
- **Power:** live power cuts (National Grid areas) with a 7-day chart and surge detection
- **Grid & gas:** national grid frequency, grid warnings, gas supply news
- **Local & roads:** local news, watched roads (Traffic Wales), local paper
- **Flashpoints:** BBC, Guardian, Al Jazeera headlines scored by keyword, plus a 1-5 world tension level
- **Disasters, health, money, space, cyber:** GDACS, USGS, BGS, NASA, WHO, UKHSA, FSA recalls, the pound, solar storms, asteroids, NCSC, internet outages

## What it watches (US)
- **Official:** National Weather Service civil emergency, evacuation and hazmat alerts for your exact location, DHS National Terrorism Advisory System, FEMA disaster declarations for your state
- **Weather & air:** National Weather Service warnings for your location, hurricanes and tropical storms (NHC) by distance, 48-hour wind gusts, US air quality index
- **Floods, fire & coast:** NWS flood, surge and tsunami warnings, nearest NOAA river gauge against its flood stages, nearest NOAA tide station against its coastal flood levels, wildfires within 250 miles (NIFC), tsunami messages
- **Power outages:** outage news for your town, county and state (there's no free live US outage feed), with a link to PowerOutage.us
- **Grid & fuel:** US grid emergency news (energy emergency alerts, rolling blackouts, conservation calls) and fuel supply news
- **Local & roads:** local news, watched roads, local paper
- **Flashpoints:** NPR, CBS, Guardian US, BBC World, Al Jazeera headlines scored by keyword, plus the 1-5 world tension level
- **Disasters, health, money, space, cyber:** earthquakes near home and worldwide (USGS), GDACS, NASA, State Department travel advisories, WHO, CDC outbreaks, FDA food recalls, the dollar, solar storms, asteroids, CISA, US internet outages

On first run you enter a UK postcode or a US ZIP code. For the UK it works out the Met Office region, power network, nearby districts, tide gauge and local news terms; for the US, the state, county, National Weather Service office, nearest river gauge and tide station. Nothing about you is uploaded: a postcode goes to postcodes.io once, a ZIP code to zippopotam.us and the National Weather Service once, and after that the app only downloads public feeds.

## Build from source
Node.js 22+:
```
npm install
npm start            # run it
npm run dist:win     # Windows installer + portable (needs Wine on Linux/Mac)
npm run dist:linux   # AppImage
npm run dist:mac     # Mac zip
```

Release installers are built by GitHub Actions ([.github/workflows/release.yml](.github/workflows/release.yml)): pushing a `v*` tag that matches the version in `package.json` builds all five and creates a draft release.

Not an official warning system. Always follow official advice from emergency services and GOV.UK.
