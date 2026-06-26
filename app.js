"use strict";

const $ = (id) => document.getElementById(id);

const WMO = {
  0: ["Clear sky", "☀️", "🌙"], 1: ["Mostly clear", "🌤️", "🌙"],
  2: ["Partly cloudy", "⛅", "☁️"], 3: ["Overcast", "☁️", "☁️"],
  45: ["Fog", "🌫️"], 48: ["Freezing fog", "🌫️"],
  51: ["Light drizzle", "🌦️"], 53: ["Drizzle", "🌦️"], 55: ["Heavy drizzle", "🌧️"],
  56: ["Freezing drizzle", "🌧️"], 57: ["Freezing drizzle", "🌧️"],
  61: ["Light rain", "🌧️"], 63: ["Rain", "🌧️"], 65: ["Heavy rain", "🌧️"],
  66: ["Freezing rain", "🌧️"], 67: ["Freezing rain", "🌧️"],
  71: ["Light snow", "🌨️"], 73: ["Snow", "🌨️"], 75: ["Heavy snow", "❄️"],
  77: ["Snow grains", "🌨️"],
  80: ["Light showers", "🌦️"], 81: ["Showers", "🌧️"], 82: ["Violent showers", "⛈️"],
  85: ["Snow showers", "🌨️"], 86: ["Heavy snow showers", "❄️"],
  95: ["Thunderstorm", "⛈️"], 96: ["Thunderstorm, hail", "⛈️"], 99: ["Thunderstorm, hail", "⛈️"],
};

const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];

// Oldest-to-newest IEM NEXRAD composite layers; "" suffix = current image.
const RADAR_SUFFIXES = ["-m50m","-m45m","-m40m","-m35m","-m30m","-m25m","-m20m","-m15m","-m10m","-m05m",""];
const RADAR_OPACITY = 0.62;

// Default on first run: Jefferson Ave & Magazine St, New Orleans.
const DEFAULT_LOC = { name: "Home — Jefferson & Magazine", lat: 29.9209, lon: -90.1151 };

const state = {
  loc: null,            // { name, lat, lon }
  map: null,
  radarLayers: [],
  frame: RADAR_SUFFIXES.length - 1,
  playing: true,
  playTimer: null,
};

/* ---------- location ---------- */

function savedLoc() {
  try { return JSON.parse(localStorage.getItem("wx-location")); } catch { return null; }
}

function setLocation(loc, { save = true } = {}) {
  state.loc = loc;
  if (save) localStorage.setItem("wx-location", JSON.stringify(loc));
  document.title = loc.name ? `${loc.name} — Weather` : "Weather";
  $("searchBox").classList.add("hidden");
  // Render the conditions card immediately with placeholders so the layout
  // doesn't jump when the data arrives a moment later.
  if ($("current").classList.contains("hidden")) {
    for (const id of ["temp", "humidity", "wind", "hilo"]) $(id).textContent = "–";
    $("wxDesc").textContent = "Loading…";
    $("current").classList.remove("hidden");
  }
  loadWeather();
  loadAlerts();
  initRadar();
}

function useGeolocation() {
  if (!navigator.geolocation) { showStatus("Geolocation unavailable — search for your city instead."); return; }
  showStatus("Locating…");
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = +pos.coords.latitude.toFixed(4);
      const lon = +pos.coords.longitude.toFixed(4);
      let name = "My location";
      try {
        const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}`);
        const j = await r.json();
        name = [j.city || j.locality, j.principalSubdivisionCode?.replace(/^US-/, "")].filter(Boolean).join(", ") || name;
      } catch { /* keep generic name */ }
      hideStatus();
      setLocation({ name, lat, lon });
    },
    () => showStatus("Couldn't get your location — search for your city instead."),
    { timeout: 8000, maximumAge: 600000 }
  );
}

async function geocode(q) {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`);
  return (await r.json()).results || [];
}

async function searchCity(q) {
  const list = $("searchResults");
  list.innerHTML = "<li>Searching…</li>";
  try {
    // The geocoder only matches place names, so "Columbus Ohio" or
    // "Columbus, OH" finds nothing — retry with trailing words stripped.
    const candidates = [...new Set([
      q,
      q.split(",")[0].trim(),
      q.split(",")[0].trim().split(/\s+/).slice(0, -1).join(" "),
    ].filter(Boolean))];
    let results = [];
    for (const c of candidates) {
      results = await geocode(c);
      if (results.length) break;
    }
    list.innerHTML = "";
    if (!results.length) { list.innerHTML = "<li>No matches.</li>"; return; }
    for (const c of results) {
      const li = document.createElement("li");
      const region = [c.admin1, c.country_code].filter(Boolean).join(", ");
      li.textContent = `${c.name}${region ? " — " + region : ""}`;
      li.onclick = () => setLocation({ name: c.admin1 ? `${c.name}, ${c.admin1}` : c.name, lat: c.latitude, lon: c.longitude });
      list.appendChild(li);
    }
  } catch {
    list.innerHTML = "<li>Search failed — check your connection.</li>";
  }
}

/* ---------- current conditions ---------- */

// Fill the conditions card from a normalized object, whatever the source.
function renderCurrent(o) {
  $("wxIcon").textContent = o.icon;
  $("temp").textContent = o.temp;
  $("wxDesc").textContent = o.desc;
  $("humidity").textContent = o.humidity;
  $("wind").textContent = o.wind;
  $("hilo").textContent = o.hilo;
  $("current").classList.remove("hidden");
}

// US locations use the National Weather Service (observed conditions + local
// forecaster output — far more accurate than a global model). Everywhere else
// falls back to Open-Meteo.
const nwsMeta = {}; // "lat,lon" -> { forecast, forecastHourly, obs }

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function getNwsMeta(lat, lon) {
  const key = `${lat},${lon}`;
  if (nwsMeta[key]) return nwsMeta[key];
  const pts = (await fetchJson(`https://api.weather.gov/points/${lat},${lon}`)).properties;
  let obs = null;
  try {
    const stations = await fetchJson(pts.observationStations);
    const id = stations.features[0]?.properties?.stationIdentifier;
    if (id) obs = `https://api.weather.gov/stations/${id}/observations/latest`;
  } catch { /* no nearby station — current temp falls back to the forecast */ }
  nwsMeta[key] = { forecast: pts.forecast, forecastHourly: pts.forecastHourly, obs };
  return nwsMeta[key];
}

async function loadWeather() {
  const { lat, lon } = state.loc;
  try {
    const meta = await getNwsMeta(lat, lon); // throws (404) outside the US
    const [obs, fc, hourly] = await Promise.all([
      meta.obs ? fetchJson(meta.obs).catch(() => null) : Promise.resolve(null),
      fetchJson(meta.forecast),
      fetchJson(meta.forecastHourly),
    ]);
    renderCurrentNWS(obs, fc);
    renderDaily(nwsDailyData(fc));
    renderHourly(nwsHourlyData(hourly));
    renderPeriods(fc);
    lastWeatherLoad = Date.now();
    hideStatus();
  } catch (e) {
    await loadWeatherOpenMeteo();
  }
}

async function loadWeatherOpenMeteo() {
  const { lat, lon } = state.loc;
  const url = "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code,is_day" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&hourly=temperature_2m,precipitation_probability,is_day&forecast_days=7" +
    "&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto";
  try {
    // Retry on network errors / 5xx, but never a 4xx (e.g. 429) — that just
    // burns more of the daily quota.
    let r = null, lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch(url);
        if (resp.ok) { r = resp; break; }
        lastErr = new Error("HTTP " + resp.status);
        if (resp.status >= 400 && resp.status < 500) break;
      } catch (e) { lastErr = e; }
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
    if (!r) throw lastErr || new Error("fetch failed");
    const j = await r.json();
    const c = j.current, d = j.daily;
    const [desc, dayIcon, nightIcon] = WMO[c.weather_code] || ["—", "❔"];
    renderCurrent({
      icon: (!c.is_day && nightIcon) ? nightIcon : dayIcon,
      temp: `${Math.round(c.temperature_2m)}°`,
      desc,
      humidity: `${c.relative_humidity_2m}%`,
      wind: `${Math.round(c.wind_speed_10m)} mph ${COMPASS[Math.round(c.wind_direction_10m / 22.5) % 16]}`,
      hilo: `${Math.round(d.temperature_2m_max[0])}° / ${Math.round(d.temperature_2m_min[0])}°`,
    });
    renderDaily(omDailyData(j));
    renderHourly(omHourlyData(j));
    // The detailed NWS periods don't exist outside the US.
    $("forecastCard").classList.add("hidden");
    $("forecastEmpty").classList.remove("hidden");
    lastWeatherLoad = Date.now();
    hideStatus();
  } catch (e) {
    showStatus(String(e).includes("429")
      ? "Weather service hit its daily request limit — it'll recover shortly."
      : "Couldn't load weather data. Tap ↻ to retry.");
  }
}

function omDailyData(j) {
  const d = j.daily, today = j.current.time.slice(0, 10);
  return d.time.map((date, i) => {
    const [desc, icon] = WMO[d.weather_code[i]] || ["—", "❔"];
    return {
      label: date === today ? "Today" : weekdayShort(date),
      icon, desc,
      pop: d.precipitation_probability_max[i] ?? 0,
      hi: Math.round(d.temperature_2m_max[i]),
      lo: Math.round(d.temperature_2m_min[i]),
    };
  });
}

function omHourlyData(j) {
  const h = j.hourly;
  const nowKey = j.current.time.slice(0, 13) + ":00";
  let start = h.time.findIndex((t) => t >= nowKey);
  if (start < 0) start = 0;
  const rows = [];
  for (let i = start; i < Math.min(start + 24, h.time.length); i++) {
    rows.push({ time: h.time[i], temp: Math.round(h.temperature_2m[i]), pop: h.precipitation_probability[i] ?? 0 });
  }
  return rows;
}

/* ---------- hourly (next 24h, vertical chart from the Open-Meteo response) ---------- */

// Temperature → color, a cool-to-hot ramp that reads year-round, any climate.
function tempColor(t) {
  return t >= 95 ? "#ef5a2a" : t >= 86 ? "#f2843a" : t >= 78 ? "#f0b22e"
    : t >= 68 ? "#7cc36a" : t >= 55 ? "#46c39a" : t >= 40 ? "#4aa3ff" : "#6f8fe0";
}

// Rain chance → how many of the 4 pips light up.
function pipCount(p) {
  return p >= 70 ? 4 : p >= 45 ? 3 : p >= 25 ? 2 : p >= 10 ? 1 : 0;
}

function hourLabel(iso) {
  let h = +iso.slice(11, 13);
  const ap = h < 12 ? "a" : "p";
  h = h % 12 || 12;
  return h + ap;
}

// rows: [{ time (location-local ISO), temp, pop }], starting at the current
// hour, up to 24 entries.
function renderHourly(rows) {
  if (!rows || !rows.length) return;

  const W = 340, top = 34, rowH = 30, divH = 28;
  const temps = rows.map((r) => r.temp);
  let tMin = Math.min(...temps), tMax = Math.max(...temps);
  if (tMax - tMin < 8) { const m = (tMin + tMax) / 2; tMin = m - 4; tMax = m + 4; } else { tMin -= 2; tMax += 2; }
  const xc = (t) => 64 + ((t - tMin) / (tMax - tMin)) * 84;

  // Lay out rows, inserting a gap where the date rolls over to tomorrow.
  const startDate = rows[0].time.slice(0, 10);
  const divIdx = rows.findIndex((r) => r.time.slice(0, 10) !== startDate);
  const ys = [];
  let y = top, dividerY = null;
  rows.forEach((r, i) => { if (i === divIdx) { dividerY = y + 9; y += divH; } ys[i] = y; y += rowH; });
  const Htot = y + 12;

  const muted = "#93a4bf", ink = "#e8eef7", blue = "#4aa3ff", track = "#1c2945";
  const seg = (a, b) => rows.slice(a, b).map((r, k) => `${xc(r.temp)},${ys[a + k]}`).join(" ");

  let s = `<svg viewBox="0 0 ${W} ${Htot}" width="100%" role="img" aria-label="Hourly forecast: temperature line and rain-chance meter for the next 24 hours">`;
  s += `<text x="106" y="20" font-size="12" fill="${muted}" text-anchor="middle" letter-spacing="1">TEMP</text>`;
  s += `<text x="270" y="20" font-size="12" fill="${muted}" text-anchor="middle" letter-spacing="1">RAIN</text>`;
  // Temperature line, split at the day boundary so it doesn't jump the gap.
  if (divIdx > 0) {
    s += `<polyline points="${seg(0, divIdx)}" fill="none" stroke="#3b4a6a" stroke-width="2"/>`;
    s += `<polyline points="${seg(divIdx, rows.length)}" fill="none" stroke="#3b4a6a" stroke-width="2"/>`;
  } else {
    s += `<polyline points="${seg(0, rows.length)}" fill="none" stroke="#3b4a6a" stroke-width="2"/>`;
  }
  if (dividerY !== null) {
    s += `<line x1="20" y1="${dividerY}" x2="${W - 16}" y2="${dividerY}" stroke="#22335a" stroke-width="1"/>`;
    s += `<text x="20" y="${dividerY - 6}" font-size="11" fill="${muted}" letter-spacing="1">TOMORROW</text>`;
  }
  rows.forEach((r, i) => {
    const yy = ys[i];
    s += `<text x="34" y="${yy + 4}" font-size="12" fill="${muted}" text-anchor="end">${hourLabel(r.time)}</text>`;
    s += `<circle cx="${xc(r.temp)}" cy="${yy}" r="5" fill="${tempColor(r.temp)}"/>`;
    s += `<text x="158" y="${yy + 4}" font-size="13" fill="${ink}">${r.temp}°</text>`;
    const f = pipCount(r.pop);
    for (let k = 0; k < 4; k++) {
      s += `<rect x="${246 + k * 12}" y="${yy - 5}" width="8" height="10" rx="2" fill="${k < f ? blue : track}"/>`;
    }
  });
  s += `</svg>`;
  $("hourlyList").innerHTML = s;
}

/* ---------- 7-day summary (one row per day; days come pre-normalized) ---------- */

function weekdayShort(isoDate) {
  // Parse as a local date (no timezone shift) and name the weekday.
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "short" });
}

// days: [{ label, icon, desc, pop, hi, lo }]
function renderDaily(days) {
  const list = $("dailyList");
  list.innerHTML = "";
  for (const d of days) {
    const row = document.createElement("div");
    row.className = "day-row";
    row.innerHTML =
      `<span class="d-name">${d.label}</span>` +
      `<span class="d-icon">${d.icon}</span>` +
      `<span class="d-desc">${d.desc}</span>` +
      `<span class="d-pop">${d.pop > 0 ? "💧 " + d.pop + "%" : ""}</span>` +
      `<span class="d-temp"><b>${d.hi}°</b> ${d.lo}°</span>`;
    list.appendChild(row);
  }
  $("dailyCard").classList.remove("hidden");
}

/* ---------- NWS data shaping (US only; sections hide elsewhere) ---------- */

// NWS periods carry only a text shortForecast, so map keywords to an emoji.
function nwsEmoji(text, isDay) {
  const t = (text || "").toLowerCase();
  if (t.includes("thunder")) return "⛈️";
  if (t.includes("snow") || t.includes("flurr")) return "🌨️";
  if (t.includes("rain") || t.includes("shower") || t.includes("drizzle")) return "🌧️";
  if (t.includes("fog") || t.includes("haze")) return "🌫️";
  if (t.includes("overcast") || t.includes("mostly cloudy")) return "☁️";
  if (t.includes("partly") || t.includes("cloud")) return isDay ? "⛅" : "☁️";
  if (t.includes("clear") || t.includes("sunny") || t.includes("fair")) return isDay ? "☀️" : "🌙";
  return isDay ? "☀️" : "🌙";
}

// Trim NWS shortForecast wording so it fits a daily row.
function shortenSky(s) {
  return (s || "")
    .replace("Showers And Thunderstorms", "T-storms")
    .replace("Thunderstorms", "T-storms")
    .replace("Slight Chance ", "")
    .replace("Chance ", "")
    .replace("Areas Of ", "")
    .replace("Patchy ", "");
}

function todayHiLo(periods) {
  let hi = null, lo = null;
  for (const p of periods.slice(0, 3)) {
    if (p.isDaytime && hi === null) hi = p.temperature;
    if (!p.isDaytime && lo === null) lo = p.temperature;
  }
  if (hi === null) hi = periods[0].temperature;
  if (lo === null) lo = periods[0].temperature;
  return { hi, lo };
}

// Current conditions from the nearest station's observation (real, observed),
// falling back to the first forecast period for any missing field.
function renderCurrentNWS(obs, fc) {
  const periods = fc.properties.periods;
  const cur = periods[0];
  const { hi, lo } = todayHiLo(periods);
  let tempF = null, humidity = null, windMph = null, windDir = null, desc = null;
  const op = obs && obs.properties;
  if (op) {
    if (op.temperature?.value != null) tempF = op.temperature.value * 9 / 5 + 32;
    if (op.relativeHumidity?.value != null) humidity = op.relativeHumidity.value;
    if (op.windSpeed?.value != null) windMph = op.windSpeed.value * 0.621371; // km/h → mph
    if (op.windDirection?.value != null) windDir = op.windDirection.value;
    if (op.textDescription) desc = op.textDescription;
  }
  if (tempF === null) tempF = cur.temperature;
  if (!desc) desc = cur.shortForecast;
  const wind = windMph != null
    ? `${Math.round(windMph)} mph${windDir != null ? " " + COMPASS[Math.round(windDir / 22.5) % 16] : ""}`
    : `${cur.windDirection} ${cur.windSpeed}`;
  renderCurrent({
    icon: nwsEmoji(desc, cur.isDaytime),
    temp: `${Math.round(tempF)}°`,
    desc,
    humidity: humidity != null ? `${Math.round(humidity)}%` : "—",
    wind,
    hilo: `${hi}° / ${lo}°`,
  });
}

// One row per calendar day: daytime period gives the high + condition, the
// matching night period gives the low.
function nwsDailyData(fc) {
  const today = fc.properties.periods[0].startTime.slice(0, 10);
  const order = [], byDate = {};
  for (const p of fc.properties.periods) {
    const date = p.startTime.slice(0, 10);
    if (!byDate[date]) { byDate[date] = { date, hi: null, lo: null, day: null }; order.push(date); }
    const g = byDate[date];
    if (p.isDaytime) { g.hi = p.temperature; g.day = p; }
    else { g.lo = p.temperature; if (!g.day) g.day = p; }
  }
  let groups = order.map((date) => byDate[date]);
  // Late in the day there's no daytime period left for "today" — drop it so the
  // strip starts on a full day rather than showing a lone evening low.
  if (groups.length && groups[0].hi === null) groups = groups.slice(1);
  return groups.slice(0, 7).map((g) => {
    const sf = g.day ? g.day.shortForecast : "";
    const pop = g.day?.probabilityOfPrecipitation?.value || 0;
    return {
      label: g.date === today ? "Today" : weekdayShort(g.date),
      icon: nwsEmoji(sf, true),
      desc: shortenSky(sf),
      pop,
      hi: g.hi != null ? g.hi : g.lo,
      lo: g.lo != null ? g.lo : g.hi,
    };
  });
}

function nwsHourlyData(hourly) {
  return hourly.properties.periods.slice(0, 24).map((p) => ({
    time: p.startTime,
    temp: Math.round(p.temperature),
    pop: p.probabilityOfPrecipitation?.value || 0,
  }));
}

// The detailed text cards for the current + next 2 periods.
function renderPeriods(fc) {
  const periods = fc.properties.periods.slice(0, 3);
  const list = $("forecastList");
  list.innerHTML = "";
  for (const p of periods) {
    const pop = p.probabilityOfPrecipitation?.value || 0;
    const card = document.createElement("div");
    card.className = "period-card" + (p.isDaytime ? " day" : " night");
    card.innerHTML =
      `<div class="pc-head"><span class="pc-name">${p.name}</span><span class="pc-temp">${p.temperature}°</span></div>` +
      `<div class="pc-short">${nwsEmoji(p.shortForecast, p.isDaytime)} ${p.shortForecast}</div>` +
      `<div class="pc-meta">${pop > 0 ? `<span>💧 ${pop}%</span>` : ""}<span>🍃 ${p.windDirection} ${p.windSpeed}</span></div>` +
      `<div class="pc-text">${p.detailedForecast}</div>`;
    list.appendChild(card);
  }
  $("forecastCard").classList.remove("hidden");
  $("forecastEmpty").classList.add("hidden");
}

const SEVERITY = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

// Collapse a list of alerts into one headline. Distinct events join with " / "
// (e.g. "Flood Watch / Heat Advisory"); repeats of one type fold into "(N)";
// too many to read falls back to a plain count.
function alertTitle(feats) {
  const groups = [];
  for (const f of feats) {
    const ev = f.properties.event;
    let g = groups.find((x) => x.name === ev);
    if (!g) { g = { name: ev, count: 0, sev: 0 }; groups.push(g); }
    g.count++;
    g.sev = Math.max(g.sev, SEVERITY[f.properties.severity] ?? 0);
  }
  groups.sort((a, b) => b.sev - a.sev);
  const labels = groups.map((g) => (g.count > 1 ? `${g.name} (${g.count})` : g.name));
  const title = labels.join(" / ");
  return (labels.length > 3 || title.length > 44) ? `${feats.length} weather alerts` : title;
}

async function loadAlerts() {
  const { lat, lon } = state.loc;
  const banner = $("alertBanner");
  try {
    const r = await fetch(`https://api.weather.gov/alerts/active?point=${lat},${lon}`);
    if (!r.ok) throw new Error(r.status);
    const feats = (await r.json()).features || [];
    banner.innerHTML = "";
    if (!feats.length) { banner.classList.add("hidden"); return; }

    // Worst alert sets the banner color; sort details worst-first too.
    feats.sort((a, b) => (SEVERITY[b.properties.severity] ?? 0) - (SEVERITY[a.properties.severity] ?? 0));
    const worst = SEVERITY[feats[0].properties.severity] ?? 0;

    const wrap = document.createElement("div");
    wrap.className = "alert " + (worst >= 3 ? "alert-severe" : "alert-moderate");

    const bar = document.createElement("button");
    bar.className = "alert-bar";
    bar.setAttribute("aria-expanded", "false");
    bar.innerHTML = `<span class="ab-icon">⚠</span><span class="ab-title"></span><span class="ab-chev">▾</span>`;
    bar.querySelector(".ab-title").textContent = alertTitle(feats);

    const details = document.createElement("div");
    details.className = "alert-details hidden";
    for (const f of feats) {
      const p = f.properties;
      const item = document.createElement("div");
      item.className = "alert-item";
      const ev = document.createElement("div");
      ev.className = "ai-event";
      ev.textContent = `⚠ ${p.event}`;
      const hl = document.createElement("div");
      hl.className = "ai-headline";
      hl.textContent = p.headline || "";
      const desc = document.createElement("div");
      desc.className = "ai-desc";
      desc.textContent = p.description || "";
      item.append(ev, hl, desc);
      details.appendChild(item);
    }

    bar.onclick = () => {
      const open = wrap.classList.toggle("open");
      details.classList.toggle("hidden", !open);
      bar.setAttribute("aria-expanded", String(open));
    };

    wrap.append(bar, details);
    banner.appendChild(wrap);
    banner.classList.remove("hidden");
  } catch {
    banner.classList.add("hidden");
  }
}

/* ---------- radar ---------- */

function initRadar() {
  const { lat, lon } = state.loc;
  $("radarCard").classList.remove("hidden");

  if (!state.map) {
    state.map = L.map("map", { zoomControl: true, attributionControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 12,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(state.map);
    L.control.scale({ imperial: true, metric: false }).addTo(state.map);
    // Radar tiles get their own pane so CSS can blur the blocky ~1km NEXRAD
    // pixels without touching the base map. Sits above tiles, below markers.
    state.map.createPane("radar");
    const pane = state.map.getPane("radar");
    pane.style.zIndex = 250;
    pane.classList.add("radar-pane");
    // The container resizes after init (conditions card appears, tab switches,
    // rotation) and Leaflet renders with the stale size unless told.
    new ResizeObserver(() => state.map.invalidateSize()).observe($("map"));
  }
  state.map.setView([lat, lon], 8);
  if (!state.map._wxMarker) {
    state.map._wxMarker = L.circleMarker([lat, lon], { radius: 6, color: "#5aa9ff", fillOpacity: 0.9 }).addTo(state.map);
  } else {
    state.map._wxMarker.setLatLng([lat, lon]);
  }
  buildRadarLayers();
  if (state.playing) startLoop();
}

function buildRadarLayers() {
  for (const l of state.radarLayers) state.map.removeLayer(l);
  state.radarLayers = RADAR_SUFFIXES.map((sfx) =>
    L.tileLayer(`https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913${sfx}/{z}/{x}/{y}.png`, {
      opacity: 0,
      maxZoom: 12,
      pane: "radar",
    }).addTo(state.map)
  );
  showFrame(RADAR_SUFFIXES.length - 1);
}

function showFrame(i) {
  state.frame = i;
  state.radarLayers.forEach((l, k) => l.setOpacity(k === i ? RADAR_OPACITY : 0));
  $("frameSlider").value = i;
  const ago = (RADAR_SUFFIXES.length - 1 - i) * 5;
  $("frameLabel").textContent = ago === 0 ? "now" : `−${ago} min`;
}

function startLoop() {
  stopLoop();
  state.playing = true;
  $("playBtn").innerHTML = "&#10074;&#10074;";
  state.playTimer = setInterval(() => {
    const next = (state.frame + 1) % RADAR_SUFFIXES.length;
    showFrame(next);
  }, state.frame === RADAR_SUFFIXES.length - 1 ? 1400 : 600);
}

function stopLoop() {
  if (state.playTimer) clearInterval(state.playTimer);
  state.playTimer = null;
}

function togglePlay() {
  if (state.playing) {
    state.playing = false;
    stopLoop();
    $("playBtn").innerHTML = "&#9654;";
  } else {
    startLoop();
  }
}

/* ---------- status helpers ---------- */

function showStatus(msg) { const s = $("status"); s.textContent = msg; s.classList.remove("hidden"); }
function hideStatus() { $("status").classList.add("hidden"); }

/* ---------- refresh ---------- */

let lastWeatherLoad = 0;

function refreshAll() {
  if (!state.loc) return;
  loadWeather();        // current + 7-day + hourly + the detailed periods
  loadAlerts();
  buildRadarLayers();   // re-request tiles so the radar advances
  if (state.playing) startLoop();
}

// Used by the "app became visible" / "back online" triggers: only refetch when
// the data is actually stale, so glancing at the app repeatedly doesn't spam
// the APIs (and burn Open-Meteo's daily quota).
function refreshIfStale() {
  if (Date.now() - lastWeatherLoad > 5 * 60 * 1000) refreshAll();
}

/* ---------- tabs ---------- */

const VIEWS = {
  now: ["viewNow", "tabNow"],
  today: ["viewToday", "tabToday"],
  week: ["viewForecast", "tabForecast"],
};

function showView(which) {
  for (const [key, [viewId, tabId]] of Object.entries(VIEWS)) {
    $(viewId).classList.toggle("hidden", key !== which);
    $(tabId).classList.toggle("active", key === which);
  }
  // The map can't measure itself while its view is hidden.
  if (which === "now" && state.map) state.map.invalidateSize();
}

$("tabNow").onclick = () => showView("now");
$("tabToday").onclick = () => showView("today");
$("tabForecast").onclick = () => showView("week");

/* ---------- wiring ---------- */

$("searchToggle").onclick = () => $("searchBox").classList.toggle("hidden");
$("searchBtn").onclick = () => { const q = $("searchInput").value.trim(); if (q) searchCity(q); };
$("searchInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("searchBtn").click(); });
$("geoBtn").onclick = useGeolocation;
$("refreshBtn").onclick = refreshAll;
$("playBtn").onclick = togglePlay;
$("frameSlider").oninput = (e) => { state.playing = false; stopLoop(); $("playBtn").innerHTML = "&#9654;"; showFrame(+e.target.value); };

setInterval(refreshAll, 10 * 60 * 1000);

// Self-heal: reload data when the connection returns, and when the app is
// brought back to the foreground — but only if the data is actually stale, so
// repeatedly opening the app doesn't hammer the APIs.
window.addEventListener("online", refreshIfStale);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshIfStale();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// Boot: ?lat=&lon=&name= override → saved location → geolocation prompt.
const qp = new URLSearchParams(location.search);
if (qp.has("lat") && qp.has("lon")) {
  setLocation({ name: qp.get("name") || "Custom location", lat: +qp.get("lat"), lon: +qp.get("lon") }, { save: false });
} else if (savedLoc()) {
  setLocation(savedLoc());
} else {
  // First run: load the default location rather than auto-triggering the
  // geolocation permission prompt (browsers may block it without a user
  // gesture, and embedded previews hang on it). Not saved, so a location
  // the user picks later wins.
  setLocation(DEFAULT_LOC, { save: false });
}
