/* Runway forecast model (outlook, risk levels, sample weather). Plain JavaScript, exposed as window.RunwayModel. */
"use strict";
var RunwayModel = (() => {
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function rng(seed) {
    let a = seed || 1;
    return () => {
      a ^= a << 13;
      a ^= a >>> 17;
      a ^= a << 5;
      return (a >>> 0) % 1e5 / 1e5;
    };
  }
  var clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function zipExposure(zip) {
    const r = rng(hash(`exp-${zip}`));
    return {
      treeCoverPct: Math.round(6 + r() * 36),
      overheadLineShare: Math.round((0.3 + r() * 0.45) * 100) / 100,
      pastOutages3yr: Math.round(1 + r() * 7),
      medianOutageHours: Math.round((3 + r() * 5) * 2) / 2
    };
  }
  function hazardProb(gust, temp, rainIn, e) {
    const wet = rainIn > 0.25 ? 1 : 0;
    const wind = clamp(clamp((gust - 25) / 35, 0, 1) * (1 + 0.3 * wet), 0, 1);
    const heat = clamp((temp - 90) / 20, 0, 1);
    const storm = clamp(rainIn / 1.5, 0, 1) * 0.6;
    const exposure = 0.4 * (e.treeCoverPct / 100) + 0.3 * e.overheadLineShare;
    const history = clamp(e.pastOutages3yr / 6, 0, 1);
    const hazard = Math.max(wind, 0.8 * heat, storm);
    const base = 0.015 + 0.03 * history;
    const p = 1 - (1 - base) * Math.exp(-2.2 * hazard * (0.5 + exposure) * (0.6 + 0.8 * history));
    return clamp(p, 0.01, 0.97);
  }
  function driverOf(gust, temp, rainIn) {
    if (rainIn > 0.4 && gust > 25) return "storm";
    if (gust >= 28) return "wind";
    if (temp >= 90) return "heat";
    if (rainIn > 0.4) return "storm";
    return "calm";
  }
  function reasonsFor(gust, temp, rainIn, e) {
    const r = [];
    if (gust >= 25) r.push(`Gusts up to ${Math.round(gust)} mph can push branches into lines`);
    if (temp >= 90) r.push(`Heat near ${Math.round(temp)}\xB0F raises demand on the grid`);
    if (rainIn > 0.4) r.push(`Heavy rain (${rainIn.toFixed(1)} in) can bring trees down`);
    if (r.length && e.treeCoverPct >= 25) r.push(`${e.treeCoverPct}% tree cover near lines in this ZIP`);
    if (r.length && e.overheadLineShare >= 0.55) r.push("Most lines here are overhead");
    if (!r.length) r.push("Calm weather expected \u2014 normal background risk");
    return r.slice(0, 3);
  }
  function seasonal(place, month) {
    const coastWest = place.lon < -114;
    const southwest = place.lat < 37 && place.lon < -104;
    const santaAna = place.state === "CA" && place.lat < 35.5 && [9, 10, 11, 0].includes(month);
    const summer = [5, 6, 7, 8].includes(month);
    const winter = [11, 0, 1].includes(month);
    const baseTemp = 88 - 1.05 * (place.lat - 25) - (winter ? 24 : summer ? -2 : 14) + (southwest && summer ? 10 : 0) - (coastWest && summer ? 6 : 0);
    const baseGust = 11 + (santaAna ? 4 : 0) + (winter && !coastWest ? 5 : 0);
    const stormy = place.lon > -100 && [5, 6, 7, 8, 9].includes(month) && place.lat < 32 || winter && place.lat > 40;
    return { baseTemp, baseGust, santaAna, stormy };
  }
  function sampleHours(place, from, count) {
    const dayKey = new Date(from).toISOString().slice(0, 10);
    const r = rng(hash(`wx-${place.zip}-${dayKey}`));
    const s = seasonal(place, new Date(from).getMonth());
    const events = [30 + r() * 30, 120 + r() * 60, 190 + r() * 40].map((at, i) => ({ at, peak: i === 0 ? (s.santaAna ? 20 : 12) + r() * 14 : 5 + r() * 10, width: 8 + r() * 10, heat: r() < 0.25 }));
    const out = [];
    for (let i = 0; i < count; i++) {
      const t = from + i * 36e5;
      const hourOfDay = new Date(t).getHours();
      const diurnal = Math.sin((hourOfDay - 9) / 24 * 2 * Math.PI);
      let gust = s.baseGust + 4 * Math.max(0, diurnal) + (r() - 0.5) * 3;
      let temp = s.baseTemp + 7 * diurnal + (r() - 0.5) * 2;
      let rain = 0;
      for (const e of events) {
        const k = Math.exp(-((i - e.at) ** 2) / (2 * e.width ** 2));
        gust += e.peak * k;
        if (e.heat) temp += 8 * k;
        if (s.stormy) rain += 0.12 * k;
      }
      out.push({ t, gustMph: Math.max(0, gust), tempF: temp, rainIn: rain });
    }
    return out;
  }
  var H = 36e5;
  var fmtHour = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric" });
  var fmtDay = (t) => new Date(t).toLocaleDateString([], { weekday: "short" });
  var fmtDate = (t) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
  var fmtMonth = (t) => new Date(t).toLocaleDateString([], { month: "long" });
  function summarize(hours, e, lengthFactor) {
    const gust = Math.max(...hours.map((h) => h.gustMph));
    const temp = Math.max(...hours.map((h) => h.tempF));
    const rain = hours.reduce((s, h) => s + h.rainIn, 0);
    const daily = hazardProb(gust, temp, rain, e);
    const p = 1 - Math.pow(1 - daily, lengthFactor);
    return { gust, temp, rain, p, driver: driverOf(gust, temp, rain), reasons: reasonsFor(gust, temp, rain, e) };
  }
  function modelDriver(primary, fallback) {
    if (primary === "wind" || primary === "heat") return primary;
    if (primary === "combined") return "storm";
    return fallback;
  }
  function buildOutlook(place, weather, county, now = Date.now()) {
    var _a, _b, _c, _d, _e;
    const e = zipExposure(place.zip);
    const start = Math.floor(now / H) * H;
    const horizonHours = 10 * 24;
    const nws = ((_a = weather == null ? void 0 : weather.hours) != null ? _a : []).filter((h) => h.t >= start);
    const lastNws = nws.length ? nws[nws.length - 1].t : start - H;
    const hours = [...nws, ...sampleHours(place, lastNws + H, Math.max(0, Math.round((start + horizonHours * H - lastNws) / H)))].filter((h) => h.t < start + horizonHours * H);
    const confidenceAt = (t) => t - start < 3 * 24 * H ? "high" : t - start < 7 * 24 * H ? "medium" : "low";
    const zipFactor = (0.5 + 0.4 * e.treeCoverPct / 100 + 0.3 * e.overheadLineShare) / (0.5 + 0.4 * 0.2 + 0.3 * 0.5);
    const hourly = [];
    for (let b = 0; b < 24; b++) {
      const t0 = start + b * 3 * H;
      const slice = hours.filter((h) => h.t >= t0 && h.t < t0 + 3 * H);
      if (!slice.length) continue;
      const s = summarize(slice, e, 0.3);
      hourly.push({ id: `h${b}`, label: fmtHour(t0), sublabel: b === 0 ? "Now" : fmtDay(t0), start: t0, end: t0 + 3 * H, probability: s.p, confidence: confidenceAt(t0), driver: s.driver, gustMph: s.gust, tempF: s.temp, reasons: s.reasons });
    }
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const daily = [];
    for (let d = 0; d < 10; d++) {
      const t0 = today.getTime() + d * 24 * H;
      const slice = hours.filter((h) => h.t >= t0 && h.t < t0 + 24 * H);
      if (!slice.length) continue;
      const s = summarize(slice, e, 1);
      let p = s.p;
      const modelWindow = county ? [county.next_24h, county.next_24_48h, county.next_48_72h][d] : void 0;
      if ((modelWindow == null ? void 0 : modelWindow.probability) != null) p = clamp(modelWindow.probability * zipFactor, 0.01, 0.97);
      const reasons = ((_b = modelWindow == null ? void 0 : modelWindow.reasons) == null ? void 0 : _b.length) ? [...modelWindow.reasons.slice(0, 2), ...e.treeCoverPct >= 25 ? [`${e.treeCoverPct}% tree cover near lines in this ZIP`] : []] : s.reasons;
      daily.push({ id: `d${d}`, label: d === 0 ? "Today" : fmtDay(t0), sublabel: fmtDate(t0), start: t0, end: t0 + 24 * H, probability: p, confidence: confidenceAt(t0), driver: modelDriver((modelWindow == null ? void 0 : modelWindow.primary_driver), s.driver), gustMph: s.gust, tempF: s.temp, reasons });
    }
    const weekly = [];
    const climWeek = (t) => {
      const s = seasonal(place, new Date(t).getMonth());
      const hist = clamp(e.pastOutages3yr / 6, 0, 1);
      return clamp(0.05 + 0.08 * hist + (s.santaAna ? 0.1 : 0) + (s.stormy ? 0.07 : 0) + 0.06 * (zipFactor - 1), 0.03, 0.6);
    };
    for (let w = 0; w < 6; w++) {
      const t0 = today.getTime() + w * 7 * 24 * H;
      const days = daily.filter((d) => d.start >= t0 && d.start < t0 + 7 * 24 * H);
      const fromDays = days.length ? 1 - days.reduce((acc, d) => acc * (1 - d.probability * 0.55), 1) : null;
      const clim = climWeek(t0);
      const blend = days.length / 7;
      const p = fromDays === null ? clim : blend * fromDays + (1 - blend) * clim;
      const peak = days.length ? days.reduce((a, b) => a.probability > b.probability ? a : b) : null;
      const s = seasonal(place, new Date(t0).getMonth());
      const reasons = peak && peak.driver !== "calm" ? [`Riskiest day: ${peak.label} ${peak.sublabel}`, ...peak.reasons.slice(0, 1)] : [s.santaAna ? "Santa Ana wind season \u2014 typical for this time of year" : s.stormy ? "Storm season \u2014 typical for this time of year" : "Based on typical conditions for this time of year"];
      weekly.push({ id: `w${w}`, label: w === 0 ? "This week" : `Week of ${fmtDate(t0)}`, sublabel: `${fmtDate(t0)} \u2013 ${fmtDate(t0 + 6 * 24 * H)}`, start: t0, end: t0 + 7 * 24 * H, probability: clamp(p, 0.02, 0.95), confidence: w === 0 ? "medium" : "low", driver: (_c = peak == null ? void 0 : peak.driver) != null ? _c : s.santaAna ? "wind" : s.stormy ? "storm" : "calm", gustMph: (_d = peak == null ? void 0 : peak.gustMph) != null ? _d : null, tempF: (_e = peak == null ? void 0 : peak.tempF) != null ? _e : null, reasons });
    }
    const monthly = [];
    for (let m = 0; m < 3; m++) {
      const d0 = new Date(today.getFullYear(), today.getMonth() + m, 1);
      const d1 = new Date(today.getFullYear(), today.getMonth() + m + 1, 1);
      const wk = climWeek(d0.getTime());
      const weeks = (d1.getTime() - d0.getTime()) / (7 * 24 * H);
      const p = 1 - Math.pow(1 - wk, weeks);
      const s = seasonal(place, d0.getMonth());
      monthly.push({ id: `m${m}`, label: fmtMonth(d0.getTime()), sublabel: m === 0 ? "Rest of month" : "Seasonal outlook", start: d0.getTime(), end: d1.getTime(), probability: clamp(p, 0.03, 0.95), confidence: "low", driver: s.santaAna ? "wind" : s.stormy ? "storm" : "calm", gustMph: null, tempF: null, reasons: [s.santaAna ? "Santa Ana wind season" : s.stormy ? "Storm season" : "Quieter season for outages", `${e.pastOutages3yr} unplanned outages in this ZIP over 3 years (sample)`] });
    }
    return {
      place,
      exposure: e,
      hourly,
      daily,
      weekly,
      monthly,
      weatherSource: weather ? { kind: "nws", name: weather.officeName, updated: weather.updated, url: weather.url } : { kind: "sample" },
      modelSource: county ? { kind: "model", version: county.model_version, issued: county.issued_at } : { kind: "heuristic" },
      issuedAt: now
    };
  }
  function levelOf(p) {
    return p < 0.2 ? "low" : p < 0.45 ? "elevated" : p < 0.7 ? "high" : "very-high";
  }
  var LEVEL_TEXT = {
    low: { word: "Low", advice: "No action needed. A good time for everyday prep." },
    elevated: { word: "Elevated", advice: "Worth a few small steps, just in case." },
    high: { word: "High", advice: "Get ready today \u2014 charge up and check in." },
    "very-high": { word: "Very high", advice: "Prepare now. Outages are likely in your area." }
  };
  var LEVEL_COLOR = { low: "#24a148", elevated: "#f1c21b", high: "#ff832b", "very-high": "#da1e28" };
  return { LEVEL_COLOR, LEVEL_TEXT, buildOutlook, levelOf, zipExposure };
})();
