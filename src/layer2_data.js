/**
 * لایه ۲ — اکتساب داده (Data Acquisition Layer)
 * ==============================================
 * پیپر این لایه را «لایه‌ی میانی که دو ماژول بالا و پایین خود را به هم وصل
 * می‌کند» توصیف می‌کند. دو منبع داده‌ی بیرونی دارد:
 *
 *   ۱. OpenWeatherMap  →  نور خورشید، باران/برف، باد، مه
 *   ۲. Amap (Gaode)    →  سرعت متوسط، اشغال جاده، سطح ازدحام
 *
 * هر دو اینجا پیاده شده‌اند و هر کدام دو حالت دارند:
 *   - حالت زنده: اگر کلید API داده شود، از سرویس واقعی می‌خواند
 *   - حالت شبیه‌سازی: بدون کلید هم کار می‌کند تا دمو همیشه قابل اجرا باشد
 */

/* ───────────────────────── موقعیت خورشید ───────────────────────── */

/**
 * زاویه‌ی ارتفاع و سمت خورشید را از روی فرمول‌های نجومی حساب می‌کند.
 *
 * پیپر: «اصل کار بر پایه‌ی فرمول‌های نجومی برای محاسبه‌ی زاویه‌ی ارتفاع
 * خورشید (که چرخش عمودی منبع نور و موقعیت طلوع/غروب را تعیین می‌کند) و
 * زاویه‌ی سمت خورشید (که مسیر روزانه را تعیین می‌کند) است.»
 *
 * @param {Date} date زمان (UTC)
 * @param {number} lat عرض جغرافیایی (درجه)
 * @param {number} lon طول جغرافیایی (درجه)
 * @returns {{altitude:number, azimuth:number}} بر حسب رادیان
 */
export function solarPosition(date, lat, lon) {
  const rad = Math.PI / 180;
  // شماره‌ی روز در سال
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start) / 86400000);

  // زاویه‌ی میل خورشید (declination) — تقریب استاندارد
  const decl = 23.45 * rad * Math.sin(2 * Math.PI * (284 + dayOfYear) / 365);

  // معادله‌ی زمان (اختلاف ساعت خورشیدی حقیقی و متوسط) بر حسب دقیقه
  const B = 2 * Math.PI * (dayOfYear - 81) / 364;
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);

  // ساعت خورشیدی حقیقی و زاویه‌ی ساعتی
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const solarTime = utcHours + (4 * lon + eot) / 60;
  const hourAngle = (solarTime - 12) * 15 * rad;

  const latR = lat * rad;
  const sinAlt = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(hourAngle);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt)));

  const azimuth = Math.atan2(
    -Math.sin(hourAngle),
    Math.tan(decl) * Math.cos(latR) - Math.sin(latR) * Math.cos(hourAngle)
  );

  return { altitude, azimuth };
}

/**
 * دمای رنگ نور را بر حسب ارتفاع خورشید برمی‌گرداند و به RGB تبدیل می‌کند.
 *
 * پیپر: «نور کم‌دما و گرم (۱۸۰۰K تا ۳۰۰۰K، متمایل به نارنجی-قرمز) هنگام
 * سپیده‌دم و غروب، سپس سفید سرد پرحرارت (۵۵۰۰K تا ۶۵۰۰K) در ظهر.»
 *
 * @param {number} altitude ارتفاع خورشید (rad)
 * @returns {{kelvin:number, rgb:[number,number,number], intensity:number}}
 */
export function sunColor(altitude) {
  const deg = altitude * 180 / Math.PI;
  // نگاشت خطی ارتفاع به دمای رنگ در بازه‌ی گفته‌شده در پیپر
  const t = Math.max(0, Math.min(1, (deg - 0) / 45));
  const kelvin = deg < 0 ? 1800 : 1800 + t * (6500 - 1800);
  // شدت نور: زیر افق صفر، و با بالا آمدن خورشید به تدریج زیاد می‌شود
  const intensity = deg <= -6 ? 0 : Math.max(0, Math.min(1.35, Math.sin(Math.max(0, altitude)) * 1.5 + 0.12));
  return { kelvin, rgb: kelvinToRGB(kelvin), intensity, altitudeDeg: deg };
}

/** تبدیل دمای رنگ (کلوین) به RGB — تقریب تانر هلاند */
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

/* ───────────────────────── آب‌وهوا ───────────────────────── */

/**
 * ضریب تبدیل شدت بارش به نرخ تولید ذرات.
 * پیپر صریحاً می‌گوید: «نرخ انتشار ذرات برابر ۸۰ برابر شدت بارش».
 */
export const RAIN_PARTICLES_PER_MM = 80;

export class WeatherService {
  /**
   * @param {object} opts
   * @param {string} [opts.apiKey] کلید OpenWeatherMap؛ اگر نباشد حالت شبیه‌سازی
   * @param {number} opts.lat عرض جغرافیایی
   * @param {number} opts.lon طول جغرافیایی
   */
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || "";
    this.lat = opts.lat ?? 51.516;
    this.lon = opts.lon ?? -0.0915;
    this.live = false;
    this.lastFetch = 0;
    this.state = {
      source:      "شبیه‌سازی‌شده",
      description: "صاف",
      tempC:       14,
      rainMmH:     0,      // شدت بارش (میلی‌متر بر ساعت)
      snowMmH:     0,
      windSpeed:   3.0,    // متر بر ثانیه
      windDeg:     220,
      clouds:      20,     // درصد
      humidity:    70,
      visibility:  10000,  // متر
    };
  }

  /** تعداد ذرات باران — فرمول صریح پیپر: ذرات = شدت × ۸۰ */
  get rainParticles() {
    return Math.round((this.state.rainMmH + this.state.snowMmH) * RAIN_PARTICLES_PER_MM);
  }

  /**
   * چگالی مه از روی رطوبت و دید افقی.
   * پیپر: «بر پایه‌ی غلظت PM2.5 و رطوبت، چگالی مه صحنه به‌صورت پویا تنظیم
   * می‌شود تا با فیزیک پراکندگی جوّی بخواند.»
   */
  get fogDensity() {
    const vis = Math.max(200, this.state.visibility);
    const base = 3.0 / vis;                             // پراکندگی معکوس با دید
    const humidityBoost = Math.max(0, this.state.humidity - 70) / 30 * 0.0006;
    return base + humidityBoost;
  }

  /** داده‌ی واقعی از OpenWeatherMap؛ در صورت شکست به حالت شبیه‌سازی برمی‌گردد */
  async fetchLive() {
    if (!this.apiKey) return false;
    try {
      const url = `https://api.openweathermap.org/data/2.5/weather`
        + `?lat=${this.lat}&lon=${this.lon}&units=metric&appid=${this.apiKey}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      this.state = {
        source:      "OpenWeatherMap (زنده)",
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
      this.live = true;
      this.lastFetch = Date.now();
      return true;
    } catch (e) {
      console.warn("[لایه ۲] دریافت آب‌وهوای زنده ناموفق بود، حالت شبیه‌سازی فعال شد:", e.message);
      this.live = false;
      return false;
    }
  }

  /** تنظیم دستی شرایط جوّی از روی رابط کاربری (حالت «چه می‌شود اگر» پیپر) */
  setManual({ rainMmH, windSpeed, clouds, visibility, humidity }) {
    this.live = false;
    const s = this.state;
    s.source     = "دستی";
    s.rainMmH    = rainMmH    ?? s.rainMmH;
    s.windSpeed  = windSpeed  ?? s.windSpeed;
    s.clouds     = clouds     ?? s.clouds;
    s.visibility = visibility ?? s.visibility;
    s.humidity   = humidity   ?? s.humidity;
    s.description = s.rainMmH > 4 ? "باران شدید"
                  : s.rainMmH > 0.5 ? "باران"
                  : s.clouds > 60 ? "نیمه‌ابری" : "صاف";
  }
}

/* ───────────────────────── وضعیت ترافیک ───────────────────────── */

/**
 * سرویس وضعیت ترافیک — معادل «Amap traffic situation API» در پیپر.
 *
 * پیپر: «API وضعیت ترافیک آمَپ به‌صورت بلادرنگ فراخوانی می‌شود تا داده‌های
 * پویای شبکه‌ی جاده (سرعت متوسط، نرخ اشغال جاده، سطح ازدحام) گرفته شود...
 * وقتی API وضعیت ازدحام برگرداند، رنگ متریال جاده خودکار عوض می‌شود
 * (مثلاً سبز برای روان و قرمز برای ازدحام).»
 *
 * چون Amap کلید چینی می‌خواهد و برای منطقه‌ی لندن داده ندارد، اینجا همان
 * قرارداد داده را با یک مدل نویز زمانی هموار تولید می‌کنیم. ساختار خروجی
 * عیناً همان است، پس جایگزینی با API واقعی فقط تعویض همین کلاس است.
 */
export class TrafficService {
  /** سطوح ازدحام دقیقاً مطابق قرارداد Amap: ۱ روان تا ۴ بسیار پرترافیک */
  static LEVELS = [
    { level: 1, name: "روان",           color: 0x3f8f63 },
    { level: 2, name: "نسبتاً روان",    color: 0x9b8f3a },
    { level: 3, name: "پرترافیک",       color: 0xb06a2e },
    { level: 4, name: "بسیار پرترافیک", color: 0xb03c33 },
  ];

  constructor(roads) {
    this.roads = roads;
    this.data = new Map();     // شناسه‌ی جاده -> وضعیت
    this.time = 0;
    // به هر جاده یک فاز تصادفی می‌دهیم تا همه هم‌زمان شلوغ/خلوت نشوند
    this.phase = new Map();
    for (const r of roads) this.phase.set(r.id, Math.random() * Math.PI * 2);
    this.update(0);
  }

  /**
   * وضعیت را جلو می‌برد.
   * @param {number} dt گام زمانی (ثانیه)
   * @param {number} demand ضریب تقاضای کلی سفر (۰ تا ۲) — از اسلایدر رابط کاربری
   */
  update(dt, demand = 1.0) {
    this.time += dt;
    for (const r of this.roads) {
      const ph = this.phase.get(r.id);
      // نوسان آرام + یک نوسان تندتر، تا الگو طبیعی به نظر برسد
      const wave = 0.5 + 0.5 * Math.sin(this.time * 0.05 + ph)
                       + 0.25 * Math.sin(this.time * 0.17 + ph * 2.3);
      // جاده‌های شریانی زودتر اشباع می‌شوند
      const load = Math.max(0, Math.min(1, (wave / 1.75) * demand * (0.55 + r.rank * 0.12)));

      // سرعت آزاد جریان بر حسب نوع جاده (کیلومتر بر ساعت)
      const freeFlow = { motorway: 90, trunk: 70, primary: 50, secondary: 45,
                         tertiary: 40, residential: 30, unclassified: 30,
                         living_street: 20 }[r.type] ?? 35;
      // رابطه‌ی استاندارد سرعت-جریان: با افزایش اشغال، سرعت افت می‌کند
      const speed = freeFlow * (1 - 0.75 * load);
      const level = load > 0.78 ? 4 : load > 0.55 ? 3 : load > 0.3 ? 2 : 1;

      this.data.set(r.id, {
        roadId:    r.id,
        name:      r.name,
        speed:     +speed.toFixed(1),      // سرعت متوسط (km/h)
        occupancy: +(load * 100).toFixed(1), // نرخ اشغال جاده (٪)
        level,                               // سطح ازدحام ۱..۴
        levelName: TrafficService.LEVELS[level - 1].name,
        color:     TrafficService.LEVELS[level - 1].color,
      });
    }
  }

  get(roadId) { return this.data.get(roadId); }

  /** آمار تجمیعی برای داشبورد پایین صفحه */
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
