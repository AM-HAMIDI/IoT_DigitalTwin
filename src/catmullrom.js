/**
 * درون‌یابی اسپلاین Catmull-Rom
 * ================================
 * پیپر: «سیستم از الگوریتم اسپلاین Catmull-Rom برای درون‌یابی و محاسبه‌ی
 * مسیرهای هموار و پیوسته‌ای که از تمام نقاط کلیدی عبور می‌کنند استفاده می‌کند.
 * این الگوریتم هر بار چهار نقطه‌ی کنترلی متوالی را در نظر می‌گیرد تا شکل قطعه‌ی
 * منحنی بین دو نقطه‌ی میانی را تعریف کند.»
 *
 * ویژگی کلیدی: منحنی از خودِ نقاط کنترلی عبور می‌کند (برخلاف Bézier) و مشتق
 * اول آن پیوسته است، پس جهت حرکت خودرو پرش ندارد.
 */

/**
 * یک قطعه‌ی Catmull-Rom بین p1 و p2 را ارزیابی می‌کند.
 * فرم چندجمله‌ای درجه سه با پارامتر t در بازه‌ی [۰،۱]:
 *
 *   P(t) = 0.5·[ 2p1
 *              + (−p0 + p2)·t
 *              + (2p0 − 5p1 + 4p2 − p3)·t²
 *              + (−p0 + 3p1 − 3p2 + p3)·t³ ]
 */
export function catmullRomPoint(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a, b, c, d) =>
    0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

/** مشتق همان چندجمله‌ای — بردار مماس، که جهت مطلوب خودرو را می‌دهد */
export function catmullRomTangent(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const f = (a, b, c, d) =>
    0.5 * ((-a + c) + 2 * (2 * a - 5 * b + 4 * c - d) * t + 3 * (-a + 3 * b - 3 * c + d) * t2);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

/**
 * مسیری هموار که از تمام نقاط کلیدی (waypoint) عبور می‌کند.
 *
 * در پیپر هر نقطه‌ی کلیدی می‌تواند «سرعت هدف، مدت توقف و دستور بازیابی» داشته
 * باشد — مثلاً رسیدن اتوبوس به ایستگاه یا خودرو به ایستگاه شارژ.
 */
export class Path {
  /**
   * @param {Array<[number,number]>} waypoints نقاط کلیدی به‌صورت [x, z] بر حسب متر
   * @param {boolean} closed آیا مسیر حلقه‌ی بسته است؟
   * @param {number} samplesPerSegment تعداد نمونه در هر قطعه (دقت در برابر حافظه)
   */
  constructor(waypoints, closed = true, samplesPerSegment = 8) {
    this.waypoints = waypoints;
    this.closed = closed;
    this.points = [];     // نقاط نمونه‌برداری‌شده روی منحنی
    this.cum = [];        // طول تجمعی تا هر نقطه — برای یافتن سریع موقعیت بر حسب مسافت
    this.length = 0;
    this._build(samplesPerSegment);
  }

  _build(spp) {
    const w = this.waypoints;
    const n = w.length;
    if (n < 2) { this.points = w.slice(); this.cum = [0]; return; }

    // انتخاب چهار نقطه‌ی کنترلی؛ در مسیر باز، دو سر را تکرار می‌کنیم
    const at = (i) => {
      if (this.closed) return w[((i % n) + n) % n];
      return w[Math.max(0, Math.min(n - 1, i))];
    };

    const segCount = this.closed ? n : n - 1;
    for (let i = 0; i < segCount; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      for (let s = 0; s < spp; s++) {
        this.points.push(catmullRomPoint(p0, p1, p2, p3, s / spp));
      }
    }
    if (!this.closed) this.points.push(w[n - 1]);

    // جدول طول تجمعی
    this.cum = [0];
    for (let i = 1; i < this.points.length; i++) {
      const a = this.points[i - 1], b = this.points[i];
      this.cum.push(this.cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    if (this.closed && this.points.length > 1) {
      const a = this.points[this.points.length - 1], b = this.points[0];
      this.length = this.cum[this.cum.length - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]);
    } else {
      this.length = this.cum[this.cum.length - 1];
    }
  }

  /**
   * موقعیت و جهت روی مسیر در فاصله‌ی s متری از ابتدا.
   * @returns {{x:number, z:number, psi:number}} psi زاویه‌ی سمت مطلوب (rad)
   */
  at(s) {
    if (this.points.length < 2) {
      const p = this.points[0] || [0, 0];
      return { x: p[0], z: p[1], psi: 0 };
    }
    if (this.closed) s = ((s % this.length) + this.length) % this.length;
    else s = Math.max(0, Math.min(this.length, s));

    // جست‌وجوی دودویی در جدول طول تجمعی — O(log n)
    let lo = 0, hi = this.cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid; else hi = mid;
    }
    const a = this.points[lo];
    const b = this.points[(lo + 1) % this.points.length];
    const segLen = Math.max(1e-6, Math.hypot(b[0] - a[0], b[1] - a[1]));
    const t = Math.max(0, Math.min(1, (s - this.cum[lo]) / segLen));

    const x = a[0] + (b[0] - a[0]) * t;
    const z = a[1] + (b[1] - a[1]) * t;
    // قرارداد زاویه مطابق پیپر: psi حول محور قائم، psi=۰ یعنی رو به +Z
    const psi = Math.atan2(b[0] - a[0], b[1] - a[1]);
    return { x, z, psi };
  }

  /**
   * انحنای مسیر در فاصله‌ی s (بر حسب ۱/متر).
   *
   * با مقایسه‌ی جهت مسیر در دو نقطه‌ی نزدیک حساب می‌شود:
   *     κ ≈ Δψ / Δs
   * خودرو از روی این عدد می‌فهمد پیچ چقدر تند است و پیش از رسیدن به آن
   * سرعتش را کم می‌کند — همان کاری که راننده‌ی واقعی می‌کند.
   */
  curvature(s, ds = 6) {
    const a = this.at(s);
    const b = this.at(s + ds);
    let d = b.psi - a.psi;
    while (d >  Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d) / ds;
  }

  /**
   * بیشترین انحنای مسیر در بازه‌ی پیش رو — برای تصمیم زودهنگام کاهش سرعت.
   * @param {number} s موقعیت فعلی روی مسیر
   * @param {number} ahead طول بازه‌ی دیدبانی (متر)
   */
  maxCurvatureAhead(s, ahead = 25) {
    let k = 0;
    for (let d = 0; d <= ahead; d += 5) k = Math.max(k, this.curvature(s + d));
    return k;
  }
}
