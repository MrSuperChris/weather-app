# Weather — notes for Claude

Minimal weather PWA, plain HTML/CSS/JS, no build. Live at
https://mrsuperchris.github.io/weather-app/; a push to `main` redeploys in about a minute. Tier2 in
`automation/tiers.json`. Checked against the code on 2026-11-18; last code change 2026-07-08.

**The README is out of date.** Its data-source table and "three tabs" describe the app before
2026-06-25. Since then forecasts are NWS-first, there is a fourth tab (Trips), and home follows
GPS. Trust `app.js` and this file.

## Decisions not to undo

- **NWS first for US locations, Open-Meteo as fallback** (`loadWeather()`; `getNwsMeta` 404s
  outside the US and drops to `loadWeatherOpenMeteo()`). Open-Meteo ran 2–4 °F hot for US points
  and reported a thunderstorm while the station observed clear skies. Chris reported both. Don't
  move US current, hourly or daily back to Open-Meteo.
- **Open-Meteo's free tier is capped per IP (10k/day).** Refresh on visibility only when >5 min
  stale, and never retry a 4xx (429). Keep both.
- **RainViewer was rejected** for radar: its free API mostly shut down in January 2026. Radar is
  Iowa State Mesonet NEXRAD n0q tiles.
- **Location model:** `?lat=&lon=&name=` test override → pinned city (`wx-pin`, set only by
  search) → cached GPS fix (`wx-geo`) or `DEFAULT_LOC`, shown at once while `locate()` runs in
  the background. Geolocation must never block the first render. ☉ un-pins and follows GPS.
- **Trips peek, never switch.** Saved destinations (`wx-trips`) show a packing digest over the
  NWS 7-day. Home location is never touched; that separation is the point.

## Chris's layout preferences

No page scrolling on a phone: four tabs (Now, Hourly, 7-Day, Trips). Only Now is locked to the
viewport, and the others scroll inside their tab. The icon is a cool-shades sun with no orange or
red (he lives somewhere hot).

## Run and verify

The `weather` entry in `C:/Users/Chris/claude/.claude/launch.json` (port 3004). Use the URL
override above to test other places.
