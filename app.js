/* Runway — plain JavaScript app. No framework.
 *
 * Load order (see index.html): Leaflet → icons.js → zips.js → model.js → app.js
 *
 * Sections
 *   1. Config + helpers
 *   2. Location (ZIP lookup, geolocation)
 *   3. Live data (NWS weather + alerts, Runway service)
 *   4. Steps for your home
 *   5. Watson (team chatbot at POST /v1/plan, offline responder)
 *   6. Map (Leaflet: risk heatmap + live layers)
 *   7. Rendering
 *   8. Events + boot
 */
(function () {
  "use strict";

  // ===================================================================== 1. config + helpers
  const params = new URLSearchParams(location.search);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };
  const CONFIG = {
    // Runway Python service (model/service/main.py). Override with ?api=https://… if hosted elsewhere.
    // Served by server.py (or any host)? Talk to that same origin. Opened as a file? Try the local server.
    apiBase: (params.get("api") || store.get("runway.api") || (location.protocol.startsWith("http") ? location.origin : "http://localhost:8080")).replace(/\/$/, ""),
    // MapTiler browser key (domain-restrict it in the MapTiler dashboard). Empty = CARTO basemap.
    maptilerKey: "wHDzQgSf0tE2C1jZP5yT",
  };
  if (params.get("api")) store.set("runway.api", CONFIG.apiBase);

  const { buildOutlook, levelOf, zipExposure, LEVEL_TEXT, LEVEL_COLOR } = window.RunwayModel;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const H = 3600000;

  function icon(name, size = 16, cls = "") {
    const paths = (window.ICON_PATHS || {})[name] || "";
    return `<svg class="icon ${cls}" width="${size}" height="${size}" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true" focusable="false">${paths}</svg>`;
  }
  function hydrateIcons(root = document) {
    $$("i[data-icon]", root).forEach((el) => { el.outerHTML = icon(el.dataset.icon, Number(el.dataset.size || 16)); });
  }
  function logoSvg(size = 28) {
    const id = "lg" + Math.random().toString(36).slice(2, 7);
    const bars = [4, 9.5, 15, 20.5, 26].map((y, i) => `<rect x="0" y="${y}" width="32" height="${(2.2 + i * 0.35).toFixed(2)}" fill="#fff"/>`).join("");
    return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="g${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a6c8ff"/><stop offset="1" stop-color="#4589ff"/></linearGradient><mask id="m${id}"><rect width="32" height="32" fill="#000"/>${bars}<rect x="15.25" y="0" width="1.5" height="32" fill="#000"/></mask></defs><polygon points="12.5,3 19.5,3 30,29.5 2,29.5" fill="url(#g${id})" mask="url(#m${id})"/></svg>`;
  }
  const timeShort = (v) => (v == null ? "" : new Date(v).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }));

  async function getJson(url, opts = {}, timeout = 8000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  // ===================================================================== 2. location
  const DEFAULT_PLACE = { zip: "90007", lat: 34.029, lon: -118.287, city: "Los Angeles", state: "CA", county: "Los Angeles County" };
  let ZIPS = null;
  function zips() {
    if (!ZIPS) ZIPS = (window.RUNWAY_ZIPS || []).map(([zip, lat, lon, city, state, county]) => ({ zip, lat, lon, city, state, county }));
    return ZIPS;
  }
  const findZip = (zip) => zips().find((p) => p.zip === zip.trim()) || null;
  function distKm(aLat, aLon, bLat, bLon) {
    const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  }
  function nearestZip(lat, lon) {
    let best = null, bestD = Infinity;
    for (const p of zips()) { const d = distKm(lat, lon, p.lat, p.lon); if (d < bestD) { bestD = d; best = p; } }
    return best;
  }
  function zipsNear(lat, lon, count = 70, maxKm = 30) {
    return zips().map((p) => ({ p, d: distKm(lat, lon, p.lat, p.lon) })).filter((x) => x.d <= maxKm).sort((a, b) => a.d - b.d).slice(0, count).map((x) => x.p);
  }
  function detectZip() {
    return new Promise((resolve, reject) => {
      if (!("geolocation" in navigator)) return reject(new Error("This browser can't share your location. Type your ZIP instead."));
      navigator.geolocation.getCurrentPosition(
        (pos) => { const p = nearestZip(pos.coords.latitude, pos.coords.longitude); p ? resolve(p) : reject(new Error("We couldn't match your location to a ZIP. Type it instead.")); },
        (err) => reject(new Error(err.code === err.PERMISSION_DENIED ? "Location is off for this page. Type your ZIP instead. We don't store it." : "We couldn't find your location. Type your ZIP instead.")),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 },
      );
    });
  }
  const SERVED_COUNTIES = { "Los Angeles County|CA": "06037", "Orange County|CA": "06059", "Riverside County|CA": "06065", "San Bernardino County|CA": "06071", "San Diego County|CA": "06073", "Santa Clara County|CA": "06085", "New York County|NY": "36061", "Harris County|TX": "48201", "Cook County|IL": "17031", "King County|WA": "53033", "Miami-Dade County|FL": "12086", "Maricopa County|AZ": "04013" };
  const countyFips = (p) => SERVED_COUNTIES[`${p.county}|${p.state}`] || null;

  // ===================================================================== 3. live data
  const OFFICE_NAMES = { LOX: "Los Angeles/Oxnard", SGX: "San Diego", HNX: "Hanford", MTR: "San Francisco Bay Area", OKX: "New York", HGX: "Houston", LOT: "Chicago", SEW: "Seattle", MFL: "Miami", PSR: "Phoenix" };
  const NWS_HEADERS = { headers: { Accept: "application/geo+json" } };

  function expandGrid(layer, convert, spread = false) {
    const out = new Map();
    if (!layer) return out;
    for (const { validTime, value } of layer.values) {
      if (value === null) continue;
      const [start, dur] = validTime.split("/");
      const m = /P(?:(\d+)D)?(?:T(?:(\d+)H)?)?/.exec(dur || "PT1H");
      const hours = (Number(m?.[1] || 0) * 24 + Number(m?.[2] || 0)) || 1;
      const t0 = Date.parse(start);
      for (let h = 0; h < hours; h++) out.set(t0 + h * H, convert(spread ? value / hours : value));
    }
    return out;
  }

  async function fetchWeather(lat, lon) {
    const point = await getJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, NWS_HEADERS);
    const grid = await getJson(point.properties.forecastGridData, NWS_HEADERS);
    const p = grid.properties;
    const gust = expandGrid(p.windGust, (v) => (p.windGust?.uom || "km_h").includes("km_h") ? v * 0.621371 : v);
    const temp = expandGrid(p.temperature, (v) => (p.temperature?.uom || "degC").includes("degC") ? v * 9 / 5 + 32 : v);
    const rain = expandGrid(p.quantitativePrecipitation, (v) => v / 25.4, true);
    const hours = [...temp.keys()].sort((a, b) => a - b).map((t) => ({ t, gustMph: gust.get(t) ?? 0, tempF: temp.get(t) ?? 60, rainIn: rain.get(t) ?? 0 }));
    const office = point.properties.gridId;
    return { hours, office, officeName: `NWS ${OFFICE_NAMES[office] || office}`, updated: p.updateTime, url: `https://forecast.weather.gov/MapClick.php?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}` };
  }

  async function fetchAlerts(lat, lon) {
    const data = await getJson(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`, NWS_HEADERS);
    return data.features.map((f) => {
      const p = f.properties, ev = p.event.toLowerCase();
      return {
        id: p.id, kind: ev.includes("warning") ? "warning" : ev.includes("watch") ? "watch" : "advisory",
        title: p.event, summary: (p.description || p.headline || "").replace(/\s+/g, " ").split(/(?<=\.)\s/)[0].slice(0, 180),
        starts: p.onset || p.effective, ends: p.ends || p.expires, source: p.senderName,
        sourceUrl: `https://forecast.weather.gov/MapClick.php?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, issued: p.sent,
      };
    });
  }

  async function checkBackend() {
    try { await getJson(`${CONFIG.apiBase}/healthz`, {}, 2500); return true; } catch { return false; }
  }

  let loadSeq = 0;
  async function loadOutlook() {
    const seq = ++loadSeq, place = S.place;
    S.loading = true; S.outlook = buildOutlook(place, null, null); S.notices = []; S.noticesChecked = null;
    render();
    const fips = countyFips(place);
    const backend = await S.backendReady;
    const [wR, aR, cR, pR] = await Promise.allSettled([
      fetchWeather(place.lat, place.lon),
      fetchAlerts(place.lat, place.lon),
      backend && fips ? getJson(`${CONFIG.apiBase}/v1/forecasts/${fips}`) : Promise.resolve(null),
      backend && fips ? getJson(`${CONFIG.apiBase}/v1/planned-outages/${fips}`) : Promise.resolve(null),
    ]);
    if (seq !== loadSeq) return;
    const weather = wR.status === "fulfilled" ? wR.value : null;
    const county = cR.status === "fulfilled" && cR.value && !cR.value.detail ? cR.value : null;
    const notices = [];
    let checked = null;
    if (aR.status === "fulfilled") {
      notices.push(...aR.value);
      checked = { source: weather?.officeName || "National Weather Service", at: Date.now(), url: weather?.url || "https://www.weather.gov" };
    }
    if (pR.status === "fulfilled" && pR.value) {
      for (const n of pR.value.notices || []) {
        notices.push({ id: `planned-${n.start_time}-${n.utility}`, kind: "planned", title: n.notice_type === "psps" ? "Public Safety Power Shutoff" : "Planned maintenance outage", summary: n.affected_description + (n.reason ? ` (${n.reason})` : ""), starts: n.start_time, ends: n.end_time, source: `${n.utility} via ${n.source}`, sourceUrl: null, issued: n.source_last_updated });
      }
    }
    S.online = wR.status === "fulfilled" || aR.status === "fulfilled";
    if (!S.online && !backend) {
      notices.push({ id: "sample-wind", kind: "advisory", title: "Example: Wind Advisory", summary: "Northeast winds 20 to 30 mph with gusts to 45 mph through the foothills and valleys.", starts: new Date(Date.now() + 26 * H).toISOString(), ends: new Date(Date.now() + 44 * H).toISOString(), source: "Example only. Live alerts come from the National Weather Service", sourceUrl: "https://www.weather.gov/alerts", issued: null, isSample: true });
    }
    S.outlook = buildOutlook(place, weather, county);
    S.notices = notices; S.noticesChecked = checked; S.loading = false;
    // Pre-select the riskiest of the next 10 days.
    const peak = S.outlook.daily.reduce((a, b) => (b.probability > a.probability ? b : a), S.outlook.daily[0]);
    if (peak) S.selected.daily = peak.id;
    render();
  }

  // ===================================================================== 4. steps for your home
  const PROFILE_CHOICES = [
    { key: "oxygen", label: "Medical device", title: "Powered medical device" },
    { key: "insulin", label: "Fridge medicine", title: "Temperature-sensitive medicine" },
    { key: "ev", label: "Electric car", title: "Electric vehicle" },
    { key: "laundry", label: "Flexible chores", title: "Flexible laundry time" },
    { key: "food", label: "Fridge & freezer", title: "Food in fridge or freezer" },
    { key: "family", label: "Family check-ins", title: "Family check-ins" },
    { key: "costAware", label: "Lower bills", title: "Lower electricity costs" },
  ];
  const ACTION_ICON = { device: "Hospital", medicine: "Medication", ev: "Car", laundry: "Renew", food: "Restaurant", family: "UserMultiple", money: "Currency", phone: "Phone", place: "Flash" };

  function buildActions(profile, outlook) {
    const days = outlook?.daily || [];
    const risky = days.find((d) => d.probability >= 0.2);
    const peak = days.length ? days.reduce((a, b) => (b.probability > a.probability ? b : a)) : null;
    const urgent = !!risky && risky.start - Date.now() < 3 * 24 * H;
    const before = risky ? `Before ${risky.label === "Today" ? "tonight" : `${risky.label} ${risky.sublabel}`}` : "This week";
    const lvl = peak ? LEVEL_TEXT[levelOf(peak.probability)].word.toLowerCase() : "low";
    const cause = risky && risky.driver !== "calm" ? ` because of ${risky.driver === "wind" ? "strong wind" : risky.driver === "heat" ? "heat" : "storms"}` : "";
    const context = risky ? `${risky.label} looks ${LEVEL_TEXT[levelOf(risky.probability)].word.toLowerCase()} risk${cause}.` : `The next 10 days look ${lvl} risk.`;
    const a = [];
    if (profile.oxygen) a.push({ id: "device", icon: "device", urgent, when: before, title: "Fully charge your medical device's backup battery", why: `${context} Backup charge buys you time if power goes out. Check the run time on the battery label.` });
    if (profile.insulin) a.push({ id: "medicine", icon: "medicine", urgent, when: before, title: "Review your medicine's storage instructions", why: "Storage needs vary. Ask your pharmacist what to do if your fridge loses power, and plan any backup cooling with them." });
    if (profile.family) a.push({ id: "family", icon: "family", urgent, when: before, title: risky ? "Agree on a check-in time with family" : "Share your plan with a family member", why: "If phones or power go down, everyone already knows when and how to check in." });
    a.push({ id: "phone", icon: "phone", urgent, when: before, title: "Charge your phone and a power bank", why: "A charged phone keeps you connected to help, alerts and this plan." });
    if (profile.food) a.push({ id: "food", icon: "food", urgent: false, when: risky ? before : "Anytime", title: "Turn the fridge to its coldest setting the night before", why: "A full, cold fridge stays safe for about 4 hours without power; a full freezer for about 48 hours (USDA)." });
    if (profile.ev) a.push({ id: "ev", icon: "ev", urgent: false, when: profile.costAware ? "Tonight after 9 PM" : before, title: profile.costAware ? "Charge your car in the cheaper overnight window" : "Charge your car before the risky day", why: profile.costAware ? "Overnight rates are usually lower on time-of-use plans. Check your utility plan." : "A charged car can be a backup way to get around or charge a phone." });
    if (profile.laundry) a.push({ id: "laundry", icon: "laundry", urgent: false, when: profile.costAware ? "After 9 PM" : "Earlier in the week", title: profile.costAware ? "Move laundry and dishwashing to off-peak hours" : "Get laundry done before the risky day", why: profile.costAware ? "Saves money on a normal day and eases strain on the grid when it's hot." : "Gets chores out of the way before a possible outage." });
    if (profile.costAware && !profile.ev && !profile.laundry) a.push({ id: "money", icon: "money", urgent: false, when: "Weekday afternoons", title: "Pre-cool your home before 4 PM on hot days", why: "Running AC earlier avoids peak prices and helps keep the grid stable." });
    a.push({ id: "place", icon: "place", urgent: false, when: "Anytime", title: "Know your nearest cool, charging-friendly place", why: "Libraries and community centers often open as cooling or charging spots. Turn on “Help nearby” on the map." });
    a.sort((x, y) => Number(y.urgent) - Number(x.urgent));
    const ids = new Set(a.map((x) => x.id));
    return [...a, ...S.watsonActions.filter((x) => !ids.has(x.id))];
  }

  // ===================================================================== 5. Watson
  const SUGGESTIONS = ["When is my riskiest day?", "What should I do first?", "I use an oxygen machine", "Where can I go if it gets hot?"];
  const FALLBACK_NOTE = {
    missing_credentials: "add watsonx credentials to the plan service.",
    project_unavailable: "IBM couldn't find the configured project. Check its project ID and region.",
    runtime_unavailable: "connect a watsonx.ai Runtime service to this IBM project.",
    model_unavailable: "the configured watsonx model isn't available. Check its model ID.",
    access_denied: "the IBM API key doesn't have access to this project.",
    watsonx_error: "the watsonx request failed. Check the plan service log.",
  };
  const WHEN_LABEL = { two_days_before: "Two days before", night_before: "The night before", one_hour_before: "An hour before", during_outage: "During an outage" };

  function turnOn(key) { if (!S.profile[key]) { S.profile[key] = true; } }
  function addAction(a) { if (!S.watsonActions.some((x) => x.id === a.id)) S.watsonActions.push(a); }

  function toAction(item) {
    const t = `${item.title_en} ${item.reason_en}`.toLowerCase();
    const ic = /insulin|medicine|pharmac/.test(t) ? "medicine" : /oxygen|cpap|dialysis|wheelchair|device|battery/.test(t) ? "device" : /family|neighbo|check in|check-in|contact/.test(t) ? "family" : /\bev\b|car\b|vehicle/.test(t) ? "ev" : /fridge|freezer|food/.test(t) ? "food" : /phone|charge/.test(t) ? "phone" : /bill|price|cost|rate/.test(t) ? "money" : "place";
    const slug = item.title_en.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48);
    return { id: `watson-${item.when}-${slug}`, icon: ic, urgent: item.when !== "during_outage", when: WHEN_LABEL[item.when] || "Soon", title: item.title_en, why: item.reason_en, fromWatson: true };
  }

  function planPayload(message, prior) {
    const t = message.toLowerCase(), p = S.profile, devices = new Set();
    if (p.oxygen || /oxygen|concentrator/.test(t)) devices.add("oxygen_concentrator");
    if (p.insulin || /insulin/.test(t)) devices.add("insulin_fridge");
    if (/cpap/.test(t)) devices.add("cpap");
    if (/dialysis/.test(t)) devices.add("home_dialysis");
    if (/wheelchair/.test(t)) devices.add("power_wheelchair");
    const days = S.outlook?.daily.slice(0, 3) || [];
    const peak = days.length ? days.reduce((a, b) => (b.probability > a.probability ? b : a)) : null;
    const e = S.outlook?.exposure;
    return {
      message,
      history: prior.slice(-6).map((m) => ({ role: m.role, text: m.text })),
      resident: { name: "Resident", devices: [...devices], hasEV: p.ev || /\bev\b|electric car/.test(t), language: "en" },
      forecast: {
        probability: peak ? peak.probability : 0.1,
        windowStart: peak ? new Date(peak.start).toISOString() : undefined,
        windowEnd: peak ? new Date(peak.end).toISOString() : undefined,
        durationLowHours: e ? Math.round(e.medianOutageHours * 0.6) : undefined,
        durationHighHours: e ? Math.round(e.medianOutageHours * 1.6) : undefined,
        primaryCause: !peak ? undefined : peak.driver === "calm" ? "unknown" : peak.driver === "storm" ? "combined" : peak.driver,
        reasons: peak ? peak.reasons : [],
      },
    };
  }

  // Answers only from what is on screen — used when watsonx can't be reached.
  function offlineReply(text) {
    const t = text.toLowerCase(), outlook = S.outlook, actions = buildActions(S.profile, outlook);
    const days = outlook?.daily || [];
    const peak = days.length ? days.reduce((a, b) => (b.probability > a.probability ? b : a)) : null;
    const where = outlook ? `ZIP ${outlook.place.zip}` : "your area";
    if (/(scared|worried|anxious|afraid|alone|nervous|stress)/.test(t)) {
      return `That's a very understandable feeling, and you're doing the right thing by planning ahead. Let's take it one small step at a time. ${peak ? `The riskiest day I see for ${where} is ${peak.label} (${LEVEL_TEXT[levelOf(peak.probability)].word.toLowerCase()} risk).` : ""} The single most helpful step right now: ${(actions[0]?.title || "charge your phone").toLowerCase()}. If you ever feel unsafe, call 911.`;
    }
    const rules = [
      [/oxygen|cpap|concentrator|dialysis|wheelchair|medical device|ventilator/, "oxygen", "Thank you for telling me. I've added your medical device to the plan, so charging its backup battery is now at the top. Please also tell your utility; most offer a medical baseline or priority notification program. If your device can't run during an outage and you feel unwell, call 911."],
      [/insulin|medicine|medication|fridge med/, "insulin", "Got it. I've added fridge medicine to your plan. Storage needs vary by medicine, so review its storage instructions and ask your pharmacist what to do if your fridge loses power."],
      [/\bev\b|electric car|tesla|charge my car/, "ev", "Added your electric car. I'll suggest charging in the cheaper overnight window and before any risky day."],
      [/laundry|dishwasher|chores/, "laundry", "Noted. I'll suggest off-peak times for chores. It saves money on normal days and helps the grid on hot ones."],
      [/bill|cheap|save money|price|cost/, "costAware", "I've turned on money-saving tips. Shifting big appliances to after 9 PM and pre-cooling before 4 PM on hot days usually lowers bills on time-of-use plans."],
      [/family|daughter|son|mom|dad|neighbor|check in|check-in/, "family", "Added family check-ins. Pick a time and a backup way to reach each other. A text often gets through when calls don't."],
    ];
    for (const [re, key, reply] of rules) if (re.test(t)) { turnOn(key); return reply; }
    if (/riskiest|when|which day|will (the )?power|go out|outage (this|next)|forecast/.test(t)) {
      if (!peak) return "I'm still loading your forecast. Give me a second and ask again.";
      const lvl = levelOf(peak.probability);
      return `For ${where}, the riskiest day in the next 10 days is ${peak.label} ${peak.sublabel}: ${LEVEL_TEXT[lvl].word.toLowerCase()} risk, about ${Math.round(peak.probability * 100)}% chance of an outage. ${peak.reasons[0] ? `Main reason: ${peak.reasons[0].toLowerCase()}.` : ""} ${lvl === "low" ? "Nothing urgent. It's a good week for everyday prep." : "I'd do the top two steps in your list before then."}`;
    }
    if (/what should i do|first|prepare|ready|plan|help me/.test(t)) {
      return `Here's where I'd start:\n${actions.slice(0, 3).map((a, i) => `${i + 1}. ${a.title} (${a.when.toLowerCase()})`).join("\n")}\nYou can tick them off in Steps for your home.`;
    }
    if (/hot|heat|cool|where can i go|shelter|library|charging spot/.test(t)) {
      addAction({ id: "watson-cool", icon: "place", urgent: false, when: "Before a hot day", title: "Pick a cooling spot and how you'll get there", why: "Watson suggested this after you asked about heat. Libraries and community centers often serve as cooling or charging spots. Call ahead to check hours.", fromWatson: true });
      return "Libraries and community centers often open as cooling or charging spots. Turn on “Help nearby” on the map to see the closest ones, and call ahead to check hours. I've added “Pick a cooling spot” to your steps. Drink water, and check on neighbors who live alone.";
    }
    if (/power is out|lost power|no power|outage now|report/.test(t)) {
      return "I'm sorry, that's stressful. First, check your utility's outage map or app to report it and see the restore time. Keep the fridge closed, unplug sensitive electronics, and never run a generator or grill indoors. If someone's health depends on power, call 911.";
    }
    if (/month|season|winter|summer|long term|weekly/.test(t) && outlook) {
      return `Looking further ahead for ${where}: ${outlook.monthly.map((m) => `${m.label} about ${Math.round(m.probability * 100)}%`).join(", ")} chance of at least one outage. These long-range numbers are low-confidence and based on typical conditions for the season.`;
    }
    if (/^(hi|hello|hey)\b/.test(t)) return "Hi! I'm Watson. Ask me when the risk is highest, what to do first, or tell me about your home and I'll tailor your plan.";
    return "I can help with your outage outlook, getting ready, saving on energy, and finding help nearby. Try “When is my riskiest day?” or tell me about a device or routine at home.";
  }

  async function sendToWatson(text) {
    const q = text.trim();
    if (!q || S.busy) return;
    const prior = S.msgs.slice(1);
    S.msgs.push({ role: "user", text: q }); S.busy = true;
    const t = q.toLowerCase();
    if (/oxygen|cpap|concentrator|dialysis|wheelchair|ventilator/.test(t)) turnOn("oxygen");
    if (/insulin|medicine|medication/.test(t)) turnOn("insulin");
    if (/\bev\b|electric car|tesla/.test(t)) turnOn("ev");
    if (/laundry|dishwasher/.test(t)) turnOn("laundry");
    if (/bill|cheap|save money|price|cost/.test(t)) turnOn("costAware");
    if (/family|daughter|son|mom|dad|check in|check-in/.test(t)) turnOn("family");
    renderChat(); renderActions(); scrollChat();

    let reply;
    try {
      if (!(await S.backendReady)) throw new Error("offline");
      const result = await getJson(`${CONFIG.apiBase}/v1/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(planPayload(q, prior)) }, 30000);
      (result.items || []).forEach((it) => addAction(toAction(it)));
      const n = (result.items || []).length;
      const added = n ? `\n\nI added ${n === 1 ? "a step" : `${n} steps`} to your plan above.` : "";
      reply = result.source === "llm"
        ? { role: "assistant", text: `${result.reply}${added}`, source: "watsonx" }
        : { role: "assistant", text: `${offlineReply(q)}${added}`, source: "offline", note: `watsonx unavailable: ${FALLBACK_NOTE[result.fallback_reason] || FALLBACK_NOTE.watsonx_error}` };
    } catch {
      await new Promise((r) => setTimeout(r, 450));
      reply = { role: "assistant", text: offlineReply(q), source: "offline", note: S.backend ? "The plan service isn't responding. Start it with: python3 server.py" : undefined };
    }
    S.msgs.push(reply); S.busy = false;
    render(); scrollChat();
  }
  const scrollChat = () => setTimeout(() => { const f = $("#chat-feed"); f.scrollTo({ top: f.scrollHeight, behavior: "smooth" }); }, 30);
  function askWatson(prefill) {
    $("#watson").scrollIntoView({ behavior: "smooth", block: "start" });
    if (prefill) { $("#watson-input").value = prefill; $("#chat-send").disabled = false; }
    setTimeout(() => $("#watson-input").focus({ preventScroll: true }), 400);
  }

  // ===================================================================== 6. map
  const LAYERS = [
    { id: "risk", label: "Outage risk", swatch: "#ff832b", source: "Runway outlook by ZIP", url: "#how-it-works", live: false },
    { id: "outages", label: "Current outages", swatch: "#161616", source: "Cal OES statewide outages (PG&E, SCE, SDG&E, SMUD), every 15 min", url: "https://gis.data.ca.gov/maps/CalEMA::statewide-power-outages-public-view", live: true },
    { id: "radar", label: "Rain radar", swatch: "#0f62fe", source: "NOAA NEXRAD via Iowa Environmental Mesonet", url: "https://mesonet.agron.iastate.edu/ogc/", live: true },
    { id: "warnings", label: "Weather warnings", swatch: "#a56eff", source: "National Weather Service via Iowa Environmental Mesonet", url: "https://www.weather.gov/alerts", live: true },
    { id: "fires", label: "Active fires", swatch: "#da1e28", source: "NIFC WFIGS current perimeters", url: "https://data-nifc.opendata.arcgis.com/", live: true },
    { id: "grid", label: "Power lines", swatch: "#6f6f6f", source: "OpenStreetMap contributors (Overpass API)", url: "https://www.openstreetmap.org/copyright", live: true },
    { id: "help", label: "Help nearby", swatch: "#198038", source: "OpenStreetMap contributors (Overpass API)", url: "https://www.openstreetmap.org/copyright", live: true },
    { id: "ev", label: "EV chargers", swatch: "#009d9a", source: "OpenStreetMap contributors (Overpass API)", url: "https://www.openstreetmap.org/copyright", live: true },
  ];
  const RAMP = [[0, [36, 161, 72]], [0.2, [36, 161, 72]], [0.35, [241, 194, 27]], [0.55, [255, 131, 43]], [0.75, [218, 30, 40]], [1, [162, 25, 31]]];
  function rampRgb(v) {
    for (let i = 1; i < RAMP.length; i++) {
      if (v <= RAMP[i][0]) {
        const [a, ca] = RAMP[i - 1], [b, cb] = RAMP[i], t = (v - a) / (b - a || 1);
        return [0, 1, 2].map((k) => Math.round(ca[k] + (cb[k] - ca[k]) * t));
      }
    }
    return RAMP[RAMP.length - 1][1];
  }
  const exposureFactor = (e) => 0.5 + 0.4 * e.treeCoverPct / 100 + 0.3 * e.overheadLineShare;
  const HELP_KIND = { hospital: { label: "Hospital", color: "#da1e28", letter: "H" }, fire_station: { label: "Fire station", color: "#ff832b", letter: "F" }, library: { label: "Library · often a cooling or charging spot", color: "#0f62fe", letter: "L" }, community_centre: { label: "Community centre", color: "#198038", letter: "C" } };
  const dotIcon = (color, letter) => L.divIcon({ className: "map-dot-icon", html: `<span style="background:${color}">${letter}</span>`, iconSize: [22, 22], iconAnchor: [11, 11] });
  const overpassCache = new Map();
  async function overpass(q) {
    if (overpassCache.has(q)) return overpassCache.get(q);
    const j = await getJson("https://overpass-api.de/api/interpreter", { method: "POST", body: new URLSearchParams({ data: q }) }, 25000);
    overpassCache.set(q, j); return j;
  }
  const bboxStr = (b) => [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((n) => n.toFixed(3)).join(",");
  const arcEnvelope = (b) => ({ geometry: `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`, geometryType: "esriGeometryEnvelope", inSR: "4326", spatialRel: "esriSpatialRelIntersects", outSR: "4326", f: "geojson" });

  const MAP = { m: null, groups: {}, neighbours: [], offline: false, baseDots: null, vectorTimer: null, vectorSeq: 0 };

  function initMap() {
    if (!window.L) { $("#map-frame").innerHTML = '<p class="fine" style="padding:16px">The map library didn\'t load. Check your internet connection and reload.</p>'; return; }
    const m = L.map("risk-map", { zoomControl: false, scrollWheelZoom: false }).setView([S.place.lat, S.place.lon], 12);
    L.control.zoom({ position: "bottomright" }).addTo(m);
    m.attributionControl.setPrefix(false);
    m.createPane("basePane").style.zIndex = "250";
    // Basemap chain: MapTiler (with a key) → CARTO → offline ZIP-centre basemap.
    const sources = [];
    if (CONFIG.maptilerKey) sources.push(() => L.tileLayer(`https://api.maptiler.com/maps/dataviz-light/256/{z}/{x}/{y}.png?key=${CONFIG.maptilerKey}`, { attribution: '© <a href="https://www.maptiler.com/copyright/">MapTiler</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 19 }));
    sources.push(() => L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>', subdomains: "abcd", maxZoom: 19 }));
    const tryBase = (i) => {
      if (i >= sources.length) { MAP.offline = true; $("#map-frame").classList.add("is-offline"); $("#map-offline").hidden = false; drawOfflineBase(); return; }
      const tiles = sources[i]().addTo(m); tiles.bringToBack();
      let loaded = 0, failed = 0, moved = false, timer;
      const next = () => { if (moved) return; moved = true; clearTimeout(timer); tiles.remove(); tryBase(i + 1); };
      tiles.on("tileload", () => { loaded++; });
      tiles.on("tileerror", () => { failed++; if (!loaded && failed >= 4) next(); });
      timer = setTimeout(() => { if (!loaded && failed) next(); }, 1500);
    };
    tryBase(0);
    m.on("moveend", () => { if (MAP.offline) drawOfflineBase(); scheduleVectors(); });
    MAP.m = m;
    setTimeout(() => m.invalidateSize(), 200);
    window.addEventListener("resize", () => m.invalidateSize());
  }

  function drawOfflineBase() {
    const m = MAP.m; if (!m) return;
    MAP.baseDots?.remove();
    const b = m.getBounds().pad(0.4), g = L.layerGroup(), cities = new Map();
    for (const z of zips()) {
      if (!b.contains([z.lat, z.lon])) continue;
      L.circleMarker([z.lat, z.lon], { radius: 3, stroke: false, fillColor: "#8d8d8d", fillOpacity: 0.6, interactive: false, pane: "basePane" }).addTo(g);
      const c = cities.get(z.city) || { n: 0, lat: 0, lon: 0 }; c.n++; c.lat += z.lat; c.lon += z.lon; cities.set(z.city, c);
    }
    [...cities.entries()].sort((a, b2) => b2[1].n - a[1].n).slice(0, 10).forEach(([city, c]) => {
      L.marker([c.lat / c.n, c.lon / c.n], { interactive: false, pane: "basePane", icon: L.divIcon({ className: "map-city", html: `<span>${esc(city)}</span>`, iconSize: [0, 0] }) }).addTo(g);
    });
    g.addTo(m); MAP.baseDots = g;
  }

  function activeLayers() {
    return new Set([...S.layers].filter((id) => S.online || !LAYERS.find((l) => l.id === id).live));
  }

  function drawRisk(period) {
    const m = MAP.m; if (!m) return;
    MAP.groups.risk?.remove(); delete MAP.groups.risk;
    if (!activeLayers().has("risk") || !period) return;
    const place = S.place, probability = period.probability, label = `${period.label} ${period.sublabel}`;
    const home = exposureFactor(zipExposure(place.zip));
    const list = MAP.neighbours.length ? MAP.neighbours : [place];
    const pts = list.map((z) => ({ z, p: z.zip === place.zip ? probability : Math.max(0.01, Math.min(0.97, probability * exposureFactor(zipExposure(z.zip)) / home)) }));
    const g = L.layerGroup();
    const lats = pts.map((x) => x.z.lat), lons = pts.map((x) => x.z.lon), pad = 0.06;
    const south = Math.min(...lats) - pad, north = Math.max(...lats) + pad, west = Math.min(...lons) - pad, east = Math.max(...lons) + pad;
    const cosLat = Math.cos(place.lat * Math.PI / 180);
    const W = 320, Hh = Math.max(120, Math.round(W * (north - south) / ((east - west) * cosLat)));
    const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = Hh;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      // Inverse-distance blend of ZIP risk values, faded away from data, then softened.
      const img = ctx.createImageData(W, Hh), kmPerLon = 111 * cosLat, reach = 5;
      for (let y = 0; y < Hh; y++) {
        const lat = north - (y + 0.5) / Hh * (north - south);
        for (let x = 0; x < W; x++) {
          const lon = west + (x + 0.5) / W * (east - west);
          let ws = 0, vs = 0, nearest = Infinity;
          for (const { z, p } of pts) {
            const dx = (lon - z.lon) * kmPerLon, dy = (lat - z.lat) * 111, d2 = dx * dx + dy * dy + 0.15;
            if (d2 < nearest) nearest = d2;
            const w = 1 / (d2 * d2); ws += w; vs += w * p;
          }
          const v = vs / ws, fade = Math.max(0, 1 - Math.sqrt(nearest) / reach), [r, gg, bb] = rampRgb(v), i = (y * W + x) * 4;
          img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = bb;
          img.data[i + 3] = Math.round(255 * Math.pow(fade, 0.7) * (0.42 + 0.36 * Math.min(1, v / 0.7)));
        }
      }
      ctx.putImageData(img, 0, 0);
      const soft = document.createElement("canvas"); soft.width = W; soft.height = Hh;
      const sctx = soft.getContext("2d");
      if (sctx) { sctx.filter = "blur(6px)"; sctx.drawImage(canvas, 0, 0); }
      L.imageOverlay((sctx ? soft : canvas).toDataURL(), [[south, west], [north, east]], { interactive: false }).addTo(g);
    }
    for (const { z, p } of pts) {
      const lvl = levelOf(p), isHome = z.zip === place.zip;
      L.circleMarker([z.lat, z.lon], isHome ? { radius: 9, color: "#161616", weight: 3, fillColor: "#ffffff", fillOpacity: 1 } : { radius: 10, stroke: false, fillOpacity: 0 })
        .bindTooltip(`<strong>${z.zip}${isHome ? " · You" : ""}</strong><br>${esc(z.city)}<br>${LEVEL_TEXT[lvl].word} · ${Math.round(p * 100)}% · ${esc(label)}`, { direction: "top" }).addTo(g);
    }
    g.addTo(m); MAP.groups.risk = g;
  }

  function syncRasterLayers() {
    const m = MAP.m; if (!m) return;
    const act = activeLayers();
    const want = (id, make) => {
      if (act.has(id) && !MAP.groups[id]) { MAP.groups[id] = make().addTo(m); }
      if (!act.has(id) && MAP.groups[id]) { MAP.groups[id].remove(); delete MAP.groups[id]; }
    };
    want("radar", () => L.tileLayer("https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png", { opacity: 0.6, maxNativeZoom: 12, attribution: "Radar: NOAA via IEM" }));
    want("warnings", () => L.tileLayer.wms("https://mesonet.agron.iastate.edu/cgi-bin/wms/us/wwa.cgi?", { layers: "warnings_c", format: "image/png", transparent: true, opacity: 0.55, attribution: "Warnings: NWS via IEM" }));
  }

  function setNote(id, note) { if (S.layerNote[id] !== note) { S.layerNote[id] = note; renderMapMeta(); } }

  function scheduleVectors() {
    clearTimeout(MAP.vectorTimer);
    MAP.vectorTimer = setTimeout(drawVectors, 350);
  }

  async function drawVectors() {
    const m = MAP.m; if (!m) return;
    const seq = ++MAP.vectorSeq, act = activeLayers(), b = m.getBounds().pad(0.15), zoom = m.getZoom();
    const replace = (id, layer) => {
      MAP.groups[id]?.remove(); delete MAP.groups[id];
      if (layer && seq === MAP.vectorSeq) MAP.groups[id] = layer.addTo(m);
    };

    if (act.has("fires")) {
      try {
        const gj = await getJson("https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?" + new URLSearchParams({ where: "1=1", outFields: "poly_IncidentName,poly_GISAcres", ...arcEnvelope(b) }));
        replace("fires", L.geoJSON(gj, { style: { color: "#a2191f", weight: 2, fillColor: "#da1e28", fillOpacity: 0.35 }, onEachFeature: (f, l) => l.bindPopup(`<strong>${esc(f.properties?.poly_IncidentName || "Wildfire")}</strong><br>${Math.round(f.properties?.poly_GISAcres || 0).toLocaleString()} acres<br><small>Source: NIFC</small>`) }));
        setNote("fires", gj.features?.length ? null : "No active fire perimeters in view");
      } catch { replace("fires", null); setNote("fires", "Couldn't reach NIFC right now"); }
    } else replace("fires", null);

    if (act.has("outages")) {
      try {
        const gj = await getJson("https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/Power_Outages_(View)/FeatureServer/0/query?" + new URLSearchParams({ where: "1=1", outFields: "UtilityCompany,StartDate,EstimatedRestoreDate,Cause,ImpactedCustomers,OutageStatus,OutageType", ...arcEnvelope(b) }));
        const when = (v) => (typeof v === "number" ? timeShort(v) : "Not given");
        replace("outages", L.geoJSON(gj, {
          pointToLayer: (f, ll) => L.circleMarker(ll, { radius: Math.min(18, 5 + Math.sqrt(Number(f.properties?.ImpactedCustomers || 0)) / 2), color: "#ffffff", weight: 1.5, fillColor: "#161616", fillOpacity: 0.85 }),
          onEachFeature: (f, l) => { const p = f.properties || {}; l.bindPopup(`<strong>Power outage</strong><br>${esc(p.UtilityCompany || "Utility")} · ${Number(p.ImpactedCustomers || 0).toLocaleString()} customers<br>Cause: ${esc(p.Cause || "Not given")}<br>Started: ${when(p.StartDate)}<br>Estimated restore: ${when(p.EstimatedRestoreDate)}<br><small>Source: Cal OES, from utility outage maps</small>`); },
        }));
        const c = b.getCenter(), inCA = c.lat > 32.4 && c.lat < 42 && c.lng > -124.5 && c.lng < -114, n = gj.features?.length || 0;
        setNote("outages", n ? `${n} reported in view` : inCA ? "None reported in view. Covers PG&E, SCE, SDG&E and SMUD customers" : "Live outage data currently covers California utilities");
      } catch { replace("outages", null); setNote("outages", "Couldn't reach Cal OES right now"); }
    } else replace("outages", null);

    if (act.has("grid")) {
      if (zoom < 11) { replace("grid", null); setNote("grid", "Zoom in to see power lines"); }
      else try {
        const bb = bboxStr(b);
        const res = await overpass(`[out:json][timeout:20];(way["power"~"^(line|minor_line)$"](${bb});node["power"="substation"](${bb});way["power"="substation"](${bb}););out geom 600;`);
        const g = L.layerGroup();
        for (const e of res.elements) {
          if (e.tags?.power === "substation") {
            const c = e.center || (e.geometry ? e.geometry[0] : e.lat !== undefined ? { lat: e.lat, lon: e.lon } : null);
            if (c) L.marker([c.lat, c.lon], { icon: dotIcon("#393939", "S") }).bindPopup(`<strong>Substation</strong>${e.tags.name ? `<br>${esc(e.tags.name)}` : ""}${e.tags.operator ? `<br>${esc(e.tags.operator)}` : ""}<br><small>Source: OpenStreetMap</small>`).addTo(g);
          } else if (e.geometry) {
            L.polyline(e.geometry.map((p) => [p.lat, p.lon]), { color: e.tags?.power === "line" ? "#525252" : "#a8a8a8", weight: e.tags?.power === "line" ? 2.5 : 1.2, opacity: 0.8 }).addTo(g);
          }
        }
        replace("grid", g); setNote("grid", res.elements.length ? null : "No mapped lines in view");
      } catch { replace("grid", null); setNote("grid", "Couldn't reach OpenStreetMap right now"); }
    } else replace("grid", null);

    if (act.has("help") || act.has("ev")) {
      try {
        const bb = bboxStr(b);
        const parts = (act.has("help") ? `nwr["amenity"~"^(hospital|fire_station|library|community_centre)$"](${bb});` : "") + (act.has("ev") ? `nwr["amenity"="charging_station"](${bb});` : "");
        const res = await overpass(`[out:json][timeout:20];(${parts});out center 400;`);
        const help = L.layerGroup(), ev = L.layerGroup();
        for (const e of res.elements) {
          const c = e.center || (e.lat !== undefined ? { lat: e.lat, lon: e.lon } : null); if (!c) continue;
          const a = e.tags?.amenity || "", name = e.tags?.name ? esc(e.tags.name) : "";
          if (a === "charging_station") L.marker([c.lat, c.lon], { icon: dotIcon("#009d9a", "⚡") }).bindPopup(`<strong>EV charger</strong>${name ? `<br>${name}` : ""}${e.tags?.operator ? `<br>${esc(e.tags.operator)}` : ""}<br><small>Source: OpenStreetMap</small>`).addTo(ev);
          else if (HELP_KIND[a]) { const k = HELP_KIND[a]; L.marker([c.lat, c.lon], { icon: dotIcon(k.color, k.letter) }).bindPopup(`<strong>${name || k.label}</strong><br>${k.label}<br><small>Source: OpenStreetMap · call ahead to confirm hours</small>`).addTo(help); }
        }
        replace("help", act.has("help") ? help : null); replace("ev", act.has("ev") ? ev : null);
        setNote("help", null); setNote("ev", null);
      } catch { replace("help", null); replace("ev", null); setNote("help", "Couldn't reach OpenStreetMap right now"); setNote("ev", "Couldn't reach OpenStreetMap right now"); }
    } else { replace("help", null); replace("ev", null); }
  }

  function recentreMap() {
    MAP.neighbours = zipsNear(S.place.lat, S.place.lon, 70, 30);
    MAP.m?.flyTo([S.place.lat, S.place.lon], 12, { duration: 0.6 });
  }

  function showLayer(id) {
    S.layers.add(id); renderLayerChips(); syncRasterLayers(); scheduleVectors(); renderMapMeta();
    $("#map").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ===================================================================== 7. rendering
  const S = {
    place: (() => { try { const s = store.get("runway.place"); return s ? JSON.parse(s) : DEFAULT_PLACE; } catch { return DEFAULT_PLACE; } })(),
    outlook: null, notices: [], noticesChecked: null, online: true, loading: true,
    horizon: "daily", selected: { hourly: "h0", daily: "d0", weekly: "w0", monthly: "m0" },
    layers: new Set(["risk", "help"]), layerNote: {},
    profile: { oxygen: true, insulin: false, ev: false, laundry: true, food: true, family: true, costAware: true },
    done: {}, watsonActions: [],
    msgs: [{ role: "assistant", text: "Hi, I'm Watson. I can explain your outlook, help you get ready, and find help nearby. What's on your mind?" }],
    busy: false, backend: false, backendReady: null,
  };

  const DRIVER_ICON = { wind: "WindGusts", heat: "TemperatureHot", storm: "Thunderstorm", calm: "Sun" };
  const DRIVER_WORD = { wind: "Wind", heat: "Heat", storm: "Storm", calm: "Calm" };
  const DRIVER_NOUN = { wind: "strong wind", heat: "heat", storm: "storms", calm: "calm weather" };
  const CONF = { high: ["High confidence", "green"], medium: ["Medium confidence", "cyan"], low: ["Outlook · low confidence", "warm"] };

  const currentPeriod = () => {
    const list = S.outlook ? S.outlook[S.horizon] : [];
    return list.find((p) => p.id === S.selected[S.horizon]) || list[0] || null;
  };
  const peakDay = () => { const d = S.outlook?.daily || []; return d.length ? d.reduce((a, b) => (b.probability > a.probability ? b : a)) : null; };

  function renderPlace() {
    const p = S.place;
    $$("[data-zip]").forEach((el) => { el.textContent = p.zip; });
    $("#zip-chip-zip").textContent = p.zip;
    $("#location-name").textContent = `${p.city}, ${p.state}${p.county ? ` · ${p.county}` : ""}`;
    $("#hero-eyebrow").textContent = `Power outage forecast · ${p.city}, ${p.state} ${p.zip}`;
  }

  function renderHero() {
    const today = S.outlook?.daily[0], tl = today ? levelOf(today.probability) : null, peak = peakDay(), pl = peak ? levelOf(peak.probability) : null;
    const actions = buildActions(S.profile, S.outlook), done = actions.filter((a) => S.done[a.id]).length;
    const alerts = S.notices.filter((n) => n.kind !== "info");
    $("#zip-chip-level").innerHTML = tl ? `<i style="background:${LEVEL_COLOR[tl]}"></i>${LEVEL_TEXT[tl].word}` : "";
    $("#zip-chip").setAttribute("aria-label", `ZIP ${S.place.zip}${tl ? `, ${LEVEL_TEXT[tl].word} risk today` : ""}. Change location`);

    const quick = [
      ["outlook", "Check my outlook", peak ? `Riskiest: ${peak.label === "Today" ? "today" : peak.label}` : "Next 10 days", "Calendar"],
      ["ready", "Get ready", `${done} of ${actions.length} steps done`, "TaskComplete"],
      ["ask", "Ask Watson", "AI answers in plain words", "ChatBot"],
      ["outages", "Outages near me", "Live outage map", "FlashOff"],
      ["help", "Find help nearby", "Hospitals, cooling spots", "Hospital"],
      ["zip", "Change ZIP", `Now ${S.place.zip}`, "Location"],
    ];
    $("#quick-actions").innerHTML = quick.map(([k, label, hint, ic]) => `<button type="button" class="quick" data-quick="${k}">${icon(ic, 20, "quick-icon")}<span class="quick-label">${label}</span><span class="quick-hint">${esc(hint)}</span>${icon("ArrowRight", 16, "quick-arrow")}</button>`).join("");

    $("#status-card").innerHTML = `
      <div class="status-head"><span>Right now in ${esc(S.place.zip)}</span><span class="status-live">${S.loading ? "Updating" : S.online ? "Live" : "Offline preview"}</span></div>
      <div class="status-today">${tl ? `<span class="status-dot" style="background:${LEVEL_COLOR[tl]}"></span><div><strong>${LEVEL_TEXT[tl].word} risk today</strong><span class="sub">${Math.round(today.probability * 100)}% chance of an outage · ${LEVEL_TEXT[tl].advice}</span></div>` : "<div><strong>Loading your outlook</strong></div>"}</div>
      <dl class="status-rows">
        <div><dt>Riskiest day ahead</dt><dd>${peak ? `<span class="status-pill"><span style="color:${LEVEL_COLOR[pl]}">${icon(DRIVER_ICON[peak.driver], 16)}</span>${peak.label === "Today" ? "Today" : `${peak.label}, ${peak.sublabel}`}</span><span class="status-sub">${LEVEL_TEXT[pl].word} · ${Math.round(peak.probability * 100)}% · ${DRIVER_NOUN[peak.driver]}</span>` : "–"}</dd></div>
        <div><dt>Alerts</dt><dd>${alerts.length ? `<a href="#notices" class="status-link">${icon("WarningAlt", 16)}${alerts.length} active ${alerts.length === 1 ? "notice" : "notices"}</a>` : '<span class="status-sub">None for this ZIP</span>'}</dd></div>
        <div><dt>Your plan</dt><dd><a href="#actions" class="status-link">${icon("TaskComplete", 16)}${done} of ${actions.length} steps done</a></dd></div>
      </dl>`;
  }

  function renderOutlook() {
    $("#outlook-loading").hidden = !S.loading;
    $$("#horizon button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.horizon === S.horizon)));
    const o = S.outlook; if (!o) return;
    const periods = o[S.horizon], period = currentPeriod();
    const strip = $("#period-strip");
    strip.className = `period-strip period-strip--${S.horizon}`;
    strip.innerHTML = periods.map((p) => {
      const lvl = levelOf(p.probability), pct = Math.round(p.probability * 100);
      return `<button type="button" role="option" class="period" data-period="${p.id}" aria-selected="${p.id === period?.id}" aria-label="${esc(`${p.label} ${p.sublabel}: ${LEVEL_TEXT[lvl].word} risk, ${pct} percent, ${DRIVER_WORD[p.driver]}`)}">
        <span class="period-label">${esc(p.label)}</span><span class="period-sub">${esc(p.sublabel)}</span>
        <span class="period-icon">${icon(DRIVER_ICON[p.driver], 20)}</span>
        <span class="period-bar"><span style="height:${Math.max(6, pct)}%;background:${LEVEL_COLOR[lvl]}"></span></span>
        <strong class="period-pct">${pct}%</strong><span class="period-level">${LEVEL_TEXT[lvl].word}</span></button>`;
    }).join("");

    if (period) {
      const lvl = levelOf(period.probability), pct = Math.round(period.probability * 100);
      const scope = { hourly: "in these 3 hours", daily: "on this day", weekly: "during this week", monthly: "during this month" }[S.horizon];
      const [confText, confTone] = CONF[period.confidence];
      $("#period-detail").innerHTML = `
        <div class="detail-main">
          <span class="level-chip"><span class="level-dot" style="background:${LEVEL_COLOR[lvl]}"></span>${LEVEL_TEXT[lvl].word} risk</span>
          <div class="detail-number"><strong>${pct}%</strong><span>chance of a power outage in ZIP ${esc(o.place.zip)} ${scope}</span></div>
          <p class="detail-advice">${LEVEL_TEXT[lvl].advice}</p>
          <div class="detail-tags"><span class="tag tag--${confTone}">${confText}</span><span class="tag tag--outline">${icon(DRIVER_ICON[period.driver], 16)}${DRIVER_WORD[period.driver]}</span></div>
        </div>
        <div class="detail-why">
          <span class="kicker">Why</span>
          <ul>${period.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
          <dl class="detail-facts">
            ${period.gustMph !== null ? `<div><dt>${icon("WindGusts", 16)} Peak gust</dt><dd>${Math.round(period.gustMph)} mph</dd></div>` : ""}
            ${period.tempF !== null ? `<div><dt>${icon("TemperatureHot", 16)} High</dt><dd>${Math.round(period.tempF)}°F</dd></div>` : ""}
            ${S.horizon !== "hourly" ? `<div><dt>${icon("Cloudy", 16)} Typical length</dt><dd>${Math.round(o.exposure.medianOutageHours * 0.6)}–${Math.round(o.exposure.medianOutageHours * 1.6)} h</dd></div>` : ""}
          </dl>
        </div>`;
    }
    const ws = o.weatherSource, ms = o.modelSource;
    $("#outlook-cite").innerHTML = `Weather: ${ws.kind === "nws" ? `<a href="${ws.url}" target="_blank" rel="noreferrer">${esc(ws.name)}${icon("Launch", 12)}</a> · updated ${timeShort(ws.updated)}` : "sample weather (the live National Weather Service forecast needs an internet connection)"} · Risk: ${ms.kind === "model" ? `Runway model v${esc(ms.version)}, scaled to your ZIP` : "transparent heuristic, not yet validated"}${S.horizon === "weekly" || S.horizon === "monthly" ? " · Beyond 7 days this blends toward typical seasonal conditions" : ""} · <a href="#how-it-works">How this works</a>`;
  }

  function renderNotices() {
    const el = $("#notice-list"), c = S.noticesChecked;
    if (!S.notices.length) {
      el.innerHTML = `<div class="notices notices--empty"><span>No active weather alerts or planned outages for this ZIP.</span>${c ? `<cite class="src">Checked ${timeShort(c.at)} · ${c.url ? `<a href="${c.url}" target="_blank" rel="noreferrer">${esc(c.source)}${icon("Launch", 12)}</a>` : esc(c.source)}</cite>` : ""}</div>`;
      return;
    }
    el.innerHTML = `<ul class="notices" aria-label="Notices for your area">${S.notices.map((n) => `<li class="notice notice--${n.kind}">${icon("WarningAlt", 20)}<div class="notice-body">
      <div class="notice-title"><strong>${esc(n.title)}</strong>${n.starts ? `<span class="notice-time">${timeShort(n.starts)}${n.ends ? ` – ${timeShort(n.ends)}` : ""}</span>` : ""}${n.isSample ? '<span class="tag tag--warm">Sample</span>' : ""}</div>
      ${n.summary ? `<p>${esc(n.summary)}</p>` : ""}
      <cite class="src">Source: ${n.sourceUrl ? `<a href="${n.sourceUrl}" target="_blank" rel="noreferrer">${esc(n.source)}${icon("Launch", 12)}</a>` : esc(n.source)}${n.issued ? ` · issued ${timeShort(n.issued)}` : ""}</cite>
    </div></li>`).join("")}</ul>`;
  }

  function renderLayerChips() {
    $("#layer-chips").innerHTML = LAYERS.map((l) => {
      const off = !S.online && l.live;
      return `<button type="button" class="chip" data-layer="${l.id}" aria-pressed="${!off && S.layers.has(l.id)}" ${off ? 'disabled title="Needs an internet connection"' : ""}><span class="swatch" style="background:${l.swatch}"></span>${l.label}</button>`;
    }).join("");
    $("#offline-note").hidden = S.online;
  }

  function renderMapMeta() {
    const act = activeLayers(), period = currentPeriod();
    $("#map-period").textContent = period ? `Showing ${period.label}${period.sublabel && period.label !== period.sublabel ? ` · ${period.sublabel}` : ""}` : "";
    const legend = [];
    if (act.has("risk")) legend.push('<span><span>Low</span><b class="heat-ramp"></b><span>Very high</span></span>');
    if (act.has("outages")) legend.push('<span><i class="legend-outage"></i>Outage now (size = customers)</span>');
    $("#map-legend").innerHTML = legend.join("");
    $("#map-legend").hidden = !legend.length;
    $("#map-cite").innerHTML = LAYERS.filter((l) => act.has(l.id)).map((l) => `${l.label}: <a href="${l.url}" ${l.url.startsWith("#") ? "" : 'target="_blank" rel="noreferrer"'}>${esc(l.source)}</a>${S.layerNote[l.id] ? ` (${esc(S.layerNote[l.id])})` : ""}`).join(" · ");
  }

  function renderActions() {
    const actions = buildActions(S.profile, S.outlook), done = actions.filter((a) => S.done[a.id]).length;
    $("#progress").innerHTML = `<span class="progress-num">${done}<small>/${actions.length}</small></span><span class="progress-label">steps done</span><span class="progress-bar"><i style="width:${actions.length ? (done / actions.length) * 100 : 0}%"></i></span>`;
    $("#progress").setAttribute("aria-label", `${done} of ${actions.length} steps done`);
    $("#home-chips").innerHTML = PROFILE_CHOICES.map((c) => `<button type="button" class="chip" data-profile="${c.key}" aria-pressed="${!!S.profile[c.key]}">${c.label}</button>`).join("");
    $("#action-list").innerHTML = actions.map((a) => `<li class="action${S.done[a.id] ? " is-done" : ""}${a.urgent ? " is-urgent" : ""}">
      <span class="action-icon">${icon(ACTION_ICON[a.icon], 20)}</span>
      <div class="action-body">
        <label class="check"><input type="checkbox" data-done="${esc(a.id)}" ${S.done[a.id] ? "checked" : ""}><span class="check-box"></span><span class="action-title">${esc(a.title)}</span></label>
        <p class="action-why">${esc(a.why)}</p>
      </div>
      <span class="action-when">${a.fromWatson ? '<span class="tag tag--purple">From Watson</span>' : ""}${esc(a.when)}</span>
    </li>`).join("");
  }

  function renderChat() {
    $("#watson-status").textContent = S.backend ? "Connected to the Runway service and IBM watsonx.ai" : "Offline. Answers come from your on-screen outlook";
    $("#chat-feed").innerHTML = S.msgs.map((m) => `<div class="bubble bubble--${m.role}">
      ${m.role === "assistant" ? `<span class="bubble-who">Watson${m.source === "offline" ? '<span class="bubble-mode">Offline answer</span>' : m.source === "watsonx" ? '<span class="bubble-mode bubble-mode--live">watsonx.ai</span>' : ""}</span>` : ""}
      <p>${esc(m.text)}</p>${m.note ? `<span class="bubble-note">${esc(m.note)}</span>` : ""}</div>`).join("")
      + (S.busy ? '<div class="bubble bubble--assistant"><span class="loading"><span class="spinner"></span>Watson is thinking…</span></div>' : "");
    $("#chat-suggest").innerHTML = SUGGESTIONS.map((s) => `<button type="button" data-suggest="${esc(s)}" ${S.busy ? "disabled" : ""}>${esc(s)}</button>`).join("");
    $("#chat-send").disabled = S.busy || !$("#watson-input").value.trim();
  }

  function render() {
    renderPlace(); renderHero(); renderOutlook(); renderNotices(); renderLayerChips(); renderActions(); renderChat();
    syncRasterLayers(); drawRisk(currentPeriod()); renderMapMeta(); scheduleVectors();
  }

  // ===================================================================== 8. events + boot
  function setPlace(p) {
    S.place = p; store.set("runway.place", JSON.stringify(p));
    recentreMap(); loadOutlook();
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("button, [data-quick]");
    if (!t) {
      if (!e.target.closest(".ai-wrap")) { $("#ai-pop").hidden = true; $("#ai-label").setAttribute("aria-expanded", "false"); }
      return;
    }
    if (t.matches("[data-ask]")) return askWatson();
    if (t.dataset.horizon) { S.horizon = t.dataset.horizon; renderOutlook(); drawRisk(currentPeriod()); renderMapMeta(); return; }
    if (t.dataset.period) { S.selected[S.horizon] = t.dataset.period; renderOutlook(); drawRisk(currentPeriod()); renderMapMeta(); return; }
    if (t.dataset.layer) { const id = t.dataset.layer; S.layers.has(id) ? S.layers.delete(id) : S.layers.add(id); renderLayerChips(); syncRasterLayers(); drawRisk(currentPeriod()); renderMapMeta(); scheduleVectors(); return; }
    if (t.dataset.profile) { const k = t.dataset.profile; S.profile[k] = !S.profile[k]; renderActions(); renderHero(); return; }
    if (t.dataset.suggest) return sendToWatson(t.dataset.suggest);
    if (t.id === "ai-label") { const open = $("#ai-pop").hidden; $("#ai-pop").hidden = !open; t.setAttribute("aria-expanded", String(open)); return; }
    if (t.dataset.quick) {
      const k = t.dataset.quick, go = (id) => $("#" + id).scrollIntoView({ behavior: "smooth", block: "start" });
      if (k === "outlook") go("forecast");
      else if (k === "ready") go("actions");
      else if (k === "ask") askWatson();
      else if (k === "outages") showLayer("outages");
      else if (k === "help") showLayer("help");
      else if (k === "zip") { go("forecast"); setTimeout(() => $("#zip-input").focus({ preventScroll: true }), 450); }
    }
  });

  document.addEventListener("change", (e) => {
    const id = e.target.dataset?.done;
    if (id) { S.done[id] = e.target.checked; renderActions(); renderHero(); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#ai-pop").hidden) { $("#ai-pop").hidden = true; $("#ai-label").setAttribute("aria-expanded", "false"); $("#ai-label").focus(); } });

  // ZIP form
  const zipInput = $("#zip-input"), zipErr = $("#zip-error");
  const zipError = (msg) => { zipErr.textContent = msg || ""; zipErr.hidden = !msg; zipInput.setAttribute("aria-invalid", String(!!msg)); };
  zipInput.addEventListener("input", () => { zipInput.value = zipInput.value.replace(/\D/g, "").slice(0, 5); zipError(null); });
  $("#zip-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const z = zipInput.value.trim();
    if (!/^\d{5}$/.test(z)) return zipError("Enter a 5-digit ZIP code.");
    const p = findZip(z);
    if (!p) return zipError(`We don't have ZIP ${z} yet. Try a nearby one.`);
    zipInput.value = ""; zipError(null); setPlace(p);
  });
  $("#zip-detect").addEventListener("click", async (e) => {
    const btn = e.currentTarget, label = btn.innerHTML;
    btn.disabled = true; btn.textContent = "Locating…"; zipError(null);
    try { setPlace(await detectZip()); } catch (err) { zipError(err.message); } finally { btn.disabled = false; btn.innerHTML = label; }
  });

  // Chat form
  const chatInput = $("#watson-input");
  chatInput.addEventListener("input", () => { $("#chat-send").disabled = S.busy || !chatInput.value.trim(); });
  $("#chat-form").addEventListener("submit", (e) => { e.preventDefault(); const v = chatInput.value; chatInput.value = ""; sendToWatson(v); });

  // Boot
  $$("[data-logo]").forEach((el) => { el.innerHTML = `${logoSvg()}<span class="logo-word">Runway</span>`; });
  hydrateIcons();
  S.backendReady = checkBackend().then((ok) => { S.backend = ok; renderChat(); return ok; });
  MAP.neighbours = zipsNear(S.place.lat, S.place.lon, 70, 30);
  initMap();
  loadOutlook();
})();
