/**
 * EnvironmentIngestion.js
 * ==============================================
 * Corresponds to the "Data Acquisition Layer" in the paper.
 * Integrates multi-source APIs to drive real-time environmental responses.
 * 
 * 1. OpenWeatherMap API -> Controls lighting, rain particles, wind drift.
 * 2. Amap API Simulation -> Traffic flow data driving dynamic road material coloring.
 */

export const RAIN_PARTICLES_PER_MM = 80; // Explicit metric from the paper: emission rate = intensity * 80

export function solarPosition(date, lat, lon) {
  const rad = Math.PI / 180;
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start) / 86400000);
  const decl = 23.45 * rad * Math.sin(2 * Math.PI * (284 + dayOfYear) / 365);
  const B = 2 * Math.PI * (dayOfYear - 81) / 364;
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const solarTime = utcHours + (4 * lon + eot) / 60;
  const hourAngle = (solarTime - 12) * 15 * rad;

  const latR = lat * rad;
  const sinAlt = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(hourAngle);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const azimuth = Math.atan2(-Math.sin(hourAngle), Math.tan(decl) * Math.cos(latR) - Math.sin(latR) * Math.cos(hourAngle));
  return { altitude, azimuth };
}

export function sunColor(altitude) {
  const deg = altitude * 180 / Math.PI;
  const t = Math.max(0, Math.min(1, (deg - 0) / 45));
  const kelvin = deg < 0 ? 1800 : 1800 + t * (6500 - 1800);
  const intensity = deg <= -6 ? 0 : Math.max(0, Math.min(1.35, Math.sin(Math.max(0, altitude)) * 1.5 + 0.12));
  return { kelvin, rgb: kelvinToRGB(kelvin), intensity, altitudeDeg: deg };
}

export function kelvinToRGB(k) {
  const t = k / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.47 * Math.log(t) - 161.12;
    b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  } else {
    r = 329.7 * Math.pow(t - 60, -0.1332);
    g = 288.12 * Math.pow(t - 60, -0.0755);
    b = 255;
  }
  const c = (v) => Math.max(0, Math.min(255, v)) / 255;
  return [c(r), c(g), c(b)];
}

export class WeatherService {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || "";
    this.lat = opts.lat ?? 51.516;
    this.lon = opts.lon ?? -0.0915;
    this.state = {
      source:      "Simulated",
      description: "Clear",
      tempC:       14,
      rainMmH:     0,
      snowMmH:     0,
      windSpeed:   3.0,
      windDeg:     220,
      clouds:      20,
      humidity:    70,
      visibility:  10000,
    };
  }

  get rainParticles() {
    return Math.round((this.state.rainMmH + this.state.snowMmH) * RAIN_PARTICLES_PER_MM);
  }

  get fogDensity() {
    const vis = Math.max(200, this.state.visibility);
    const base = 3.0 / vis;
    const humidityBoost = Math.max(0, this.state.humidity - 70) / 30 * 0.0006;
    return base + humidityBoost;
  }

  async fetchLive() {
    if (!this.apiKey) return false;
    try {
      const url = `https://api.openweathermap.org/data/2.5/weather?lat=${this.lat}&lon=${this.lon}&units=metric&appid=${this.apiKey}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      this.state = {
        source:      "OpenWeatherMap (Live)",
        description: j.weather?.[0]?.description ?? "-",
        tempC:       j.main?.temp ?? 14,
        rainMmH:     j.rain?.["1h"] ?? 0,
        snowMmH:     j.snow?.["1h"] ?? 0,
        windSpeed:   j.wind?.speed ?? 0,
        windDeg:     j.wind?.deg ?? 0,
        clouds:      j.clouds?.all ?? 0,
        humidity:    j.main?.humidity ?? 70,
        visibility:  j.visibility ?? 10000,
      };
      return true;
    } catch (e) {
      return false;
    }
  }

  setManual({ rainMmH, windSpeed, clouds, visibility, humidity }) {
    const s = this.state;
    s.source     = "Manual";
    s.rainMmH    = rainMmH    ?? s.rainMmH;
    s.windSpeed  = windSpeed  ?? s.windSpeed;
    s.clouds     = clouds     ?? s.clouds;
    s.visibility = visibility ?? s.visibility;
    s.humidity   = humidity   ?? s.humidity;
  }
}

/**
 * TrafficService
 * Simulates the Amap API spatial index mapping and data payload retrieval.
 */
export class TrafficService {
  static LEVELS = [
    { level: 1, name: "Clear",       color: 0x3f8f63 },
    { level: 2, name: "Moderate",    color: 0x9b8f3a },
    { level: 3, name: "Congested",   color: 0xb06a2e },
    { level: 4, name: "Severe",      color: 0xb03c33 },
  ];

  constructor(roads) {
    this.roads = roads;
    this.data = new Map();
    this.time = 0;
    this.phase = new Map();
    for (const r of roads) this.phase.set(r.id, Math.random() * Math.PI * 2);
    this.update(0);
  }

  update(dt, demand = 1.0) {
    this.time += dt;
    for (const r of this.roads) {
      const ph = this.phase.get(r.id);
      const wave = 0.5 + 0.5 * Math.sin(this.time * 0.05 + ph) + 0.25 * Math.sin(this.time * 0.17 + ph * 2.3);
      const load = Math.max(0, Math.min(1, (wave / 1.75) * demand * (0.55 + r.rank * 0.12)));

      const freeFlow = { motorway: 90, trunk: 70, primary: 50, secondary: 45, tertiary: 40, residential: 30 }[r.type] ?? 35;
      const speed = freeFlow * (1 - 0.75 * load);
      const level = load > 0.78 ? 4 : load > 0.55 ? 3 : load > 0.3 ? 2 : 1;

      this.data.set(r.id, {
        roadId:    r.id,
        name:      r.name,
        speed:     +speed.toFixed(1),
        occupancy: +(load * 100).toFixed(1),
        level,
        levelName: TrafficService.LEVELS[level - 1].name,
        color:     TrafficService.LEVELS[level - 1].color,
      });
    }
  }

  get(roadId) { return this.data.get(roadId); }

  summary() {
    let jam = 0, sumSpeed = 0, n = 0;
    for (const d of this.data.values()) {
      if (d.level >= 3) jam++;
      sumSpeed += d.speed; n++;
    }
    return {
      congestedRoads: jam,
      congestionRate: n ? +(100 * jam / n).toFixed(1) : 0,
      avgSpeed: n ? +(sumSpeed / n).toFixed(1) : 0,
    };
  }
}
