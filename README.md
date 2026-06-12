# Weather

Minimal local-weather PWA: current conditions + animated NEXRAD radar loop.
No build step, no API keys, no accounts — plain HTML/CSS/JS.

## Data sources (all free)

| What | Source | Terms |
|---|---|---|
| Current conditions, hi/lo | [Open-Meteo](https://open-meteo.com/) | Free non-commercial, no key, CC BY 4.0 attribution (in footer) |
| 7-day text forecast + active alerts | [NWS API](https://www.weather.gov/documentation/services-web-api) (api.weather.gov) | Free for any use, no key, US only |
| Radar tiles (now + 10 past frames, 5-min steps) | [Iowa State Mesonet](https://mesonet.agron.iastate.edu/ogc/) NEXRAD n0q composite | Free, US coverage only |
| Base map | OpenStreetMap | Attribution shown on map |
| City search | Open-Meteo geocoding API | Same as Open-Meteo |
| Reverse geocoding (name for "my location") | [BigDataCloud free client API](https://www.bigdatacloud.com/free-api/free-reverse-geocode-to-city-api) | Free, no key |

## Run locally (desktop)

Any static file server works, e.g.:

```
npx http-server . -p 3004 -c-1
```

then open http://localhost:3004. (There is also a `weather` entry in the
workspace `.claude/launch.json`.)

## Get it on your Android phone

A PWA needs HTTPS for "Add to Home Screen" + offline shell to work, so host
the folder somewhere free:

1. **GitHub Pages** (recommended): push this folder to a repo, enable Pages
   on the main branch. Visit the `https://<you>.github.io/<repo>/` URL in
   Chrome on the phone → menu → **Add to Home screen**. It installs like an
   app with the cloud icon.
2. Netlify / Cloudflare Pages drag-and-drop also work.

## Notes

- First run defaults to home (Jefferson Ave & Magazine St, New Orleans —
  `DEFAULT_LOC` in app.js). The ☉ button geolocates on demand; a searched
  city is remembered (localStorage) and overrides the default.
- Three tabs, no page scrolling: "Now" (conditions + radar, map flexes to
  fill the screen), "Hourly" (next 24 hours from Open-Meteo, same API call),
  and "7-Day" (NWS prose). Hourly and 7-Day scroll within their tabs.
  Watch/warning banners appear at the top of either tab only when an alert
  is active for the location (tap to expand).
- `?lat=&lon=&name=` URL params override the saved location (handy for testing).
- Auto-refreshes conditions + radar every 10 minutes; ↻ button forces it.
- Radar is US-only (NEXRAD). Outside the US the map shows but stays empty;
  current conditions still work worldwide.
