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
    for (const id of ["temp", "feels", "humidity", "wind", "hilo", "precip", "updated"]) $(id).textContent = "–";
    $("wxDesc").textContent = "Loading…";
    $("current").classList.remove("hidden");
  }
  loadWeather();
  loadReport();
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

async function loadWeather() {
  const { lat, lon } = state.loc;
  const url = "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation,weather_code,is_day" +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum" +
    "&hourly=temperature_2m,precipitation_probability,weather_code,is_day&forecast_days=2" +
    "&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto";
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    const c = j.current, d = j.daily;
    const [desc, dayIcon, nightIcon] = WMO[c.weather_code] || ["—", "❔"];
    $("wxIcon").textContent = (!c.is_day && nightIcon) ? nightIcon : dayIcon;
    $("temp").textContent = `${Math.round(c.temperature_2m)}°`;
    $("wxDesc").textContent = desc;
    $("feels").textContent = `${Math.round(c.apparent_temperature)}°`;
    $("humidity").textContent = `${c.relative_humidity_2m}%`;
    $("wind").textContent = `${Math.round(c.wind_speed_10m)} mph ${COMPASS[Math.round(c.wind_direction_10m / 22.5) % 16]}`;
    $("hilo").textContent = `${Math.round(d.temperature_2m_max[0])}° / ${Math.round(d.temperature_2m_min[0])}°`;
    $("precip").textContent = `${d.precipitation_sum[0] ?? 0}"`;
    $("updated").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    $("current").classList.remove("hidden");
    renderHourly(j);
    hideStatus();
  } catch (e) {
    showStatus("Couldn't load weather data. Tap ↻ to retry.");
  }
}

/* ---------- hourly (next 24h, from the same Open-Meteo response) ---------- */

function hourLabel(isoLocal) {
  const h = +isoLocal.slice(11, 13);
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function renderHourly(j) {
  const h = j.hourly;
  const list = $("hourlyList");
  list.innerHTML = "";
  // Times are location-local ISO strings, so string comparison finds "now".
  const nowKey = j.current.time.slice(0, 13) + ":00";
  let start = h.time.findIndex((t) => t >= nowKey);
  if (start < 0) start = 0;
  let prevDate = h.time[start].slice(0, 10);
  for (let i = start; i < Math.min(start + 24, h.time.length); i++) {
    const date = h.time[i].slice(0, 10);
    if (date !== prevDate) {
      const div = document.createElement("div");
      div.className = "hour-divider";
      div.textContent = "Tomorrow";
      list.appendChild(div);
      prevDate = date;
    }
    const [, dayIcon, nightIcon] = WMO[h.weather_code[i]] || ["", "❔"];
    const row = document.createElement("div");
    row.className = "hour-row";
    const cells = [
      hourLabel(h.time[i]),
      (!h.is_day[i] && nightIcon) ? nightIcon : dayIcon,
      `${Math.round(h.temperature_2m[i])}°`,
      `💧 ${h.precipitation_probability[i] ?? 0}%`,
    ];
    for (const c of cells) {
      const span = document.createElement("span");
      span.textContent = c;
      row.appendChild(span);
    }
    list.appendChild(row);
  }
}

/* ---------- NWS report & alerts (US only; sections hide elsewhere) ---------- */

const nwsForecastUrls = {}; // "lat,lon" -> gridpoint forecast URL

async function loadReport() {
  const { lat, lon } = state.loc;
  const key = `${lat},${lon}`;
  try {
    if (!nwsForecastUrls[key]) {
      const r = await fetch(`https://api.weather.gov/points/${lat},${lon}`);
      if (!r.ok) throw new Error(r.status);
      nwsForecastUrls[key] = (await r.json()).properties.forecast;
    }
    const r = await fetch(nwsForecastUrls[key]);
    if (!r.ok) throw new Error(r.status);
    const periods = (await r.json()).properties.periods;
    const list = $("forecastList");
    list.innerHTML = "";
    for (const p of periods) {
      const div = document.createElement("div");
      div.className = "period";
      const name = document.createElement("div");
      name.className = "p-name";
      name.textContent = p.name;
      const text = document.createElement("div");
      text.className = "p-text";
      text.textContent = p.detailedForecast;
      div.append(name, text);
      list.appendChild(div);
    }
    $("forecastCard").classList.toggle("hidden", periods.length === 0);
    $("forecastEmpty").classList.toggle("hidden", periods.length > 0);
  } catch {
    $("forecastCard").classList.add("hidden");
    $("forecastEmpty").classList.remove("hidden");
  }
}

async function loadAlerts() {
  const { lat, lon } = state.loc;
  const banner = $("alertBanner");
  try {
    const r = await fetch(`https://api.weather.gov/alerts/active?point=${lat},${lon}`);
    if (!r.ok) throw new Error(r.status);
    const feats = (await r.json()).features || [];
    banner.innerHTML = "";
    for (const f of feats) {
      const p = f.properties;
      const div = document.createElement("div");
      div.className = "alert " + (["Extreme", "Severe"].includes(p.severity) ? "alert-severe" : "alert-moderate");
      const head = document.createElement("div");
      head.className = "alert-head";
      head.textContent = `⚠ ${p.event}`;
      const summary = document.createElement("div");
      summary.className = "alert-summary";
      summary.textContent = p.headline || "";
      const body = document.createElement("div");
      body.className = "alert-body hidden";
      body.textContent = p.description || "";
      div.append(head, summary, body);
      div.onclick = () => body.classList.toggle("hidden");
      banner.appendChild(div);
    }
    banner.classList.toggle("hidden", feats.length === 0);
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

function refreshAll() {
  if (!state.loc) return;
  loadWeather();
  loadReport();
  loadAlerts();
  buildRadarLayers();   // re-request tiles so the radar advances
  if (state.playing) startLoop();
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
