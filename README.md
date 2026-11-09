# Early Warning

A desktop early-warning board for wherever you live in the UK. It pulls free public feeds every few minutes and shows them on one screen, with a coloured tray icon and pop-up notifications when something serious happens.

**Download:** see [Releases](../../releases/latest). Install notes are in [INSTALL.txt](INSTALL.txt).

## What it watches
- **Official:** GOV.UK Emergency Alerts, UK terrorism threat level
- **Weather & air:** Met Office warnings for your region, 48-hour wind gust forecast, air quality
- **Floods & tides:** Environment Agency flood warnings, nearest tide gauge
- **Power:** live power cuts (National Grid areas) with a 7-day chart and surge detection
- **Grid & gas:** national grid frequency, grid warnings, gas supply news
- **Local & roads:** local news, watched roads (Traffic Wales), local paper
- **Flashpoints:** BBC, Guardian, Al Jazeera headlines scored by keyword, plus a 1-5 world tension level
- **Disasters, health, money, space, cyber:** GDACS, USGS, BGS, NASA, WHO, UKHSA, FSA recalls, the pound, solar storms, asteroids, NCSC, internet outages

On first run you enter a postcode; it works out the Met Office region, power network, nearby districts, tide gauge and local news terms. Nothing about you is uploaded: the postcode goes to postcodes.io once, and after that the app only downloads public feeds.

## Build from source
Node.js 22+:
```
npm install
npm start            # run it
npm run dist:win     # Windows installer + portable (needs Wine on Linux/Mac)
npm run dist:linux   # AppImage
npm run dist:mac     # Mac zip
```

Not an official warning system. Always follow official advice from emergency services and GOV.UK.
