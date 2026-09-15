/**
 * لایه ۳ — هسته‌ی دینامیکی (Concept Generation Layer)
 * ===================================================
 * پیاده‌سازی مستقیم «Unity-optimized vehicle dynamics model» پیپر.
 *
 * مدل دوچرخه‌ی خطی با ۳ درجه آزادی: طولی (u)، عرضی (v)، و دوران حول محور قائم (r).
 * لاستیک خطی است (نیرو = سختی پیچشی × زاویه لغزش) — همان ساده‌سازی‌ای که
 * پیپر جایگزین فرمول جادویی Pacejka کرده تا محاسبات سبک شود.
 *
 * شماره‌ی معادله‌ها دقیقاً مطابق متن پیپر است.
 */

/** پارامترهای پیش‌فرض خودرو — جدول نمادهای پیپر (m, Iz, Cf, Cr, lf, lr) */
export const DEFAULT_PARAMS = {
  m:  1500,     // جرم خودرو (kg)
  Iz: 2500,     // ممان اینرسی حول محور قائم (kg·m²)
  Cf: 55000,    // سختی پیچشی لاستیک جلو (N/rad)
  Cr: 60000,    // سختی پیچشی لاستیک عقب (N/rad)
  lf: 1.2,      // فاصله‌ی محور جلو تا مرکز ثقل (m)
  lr: 1.5,      // فاصله‌ی محور عقب تا مرکز ثقل (m)
};

/** حد بالای زاویه فرمان — فراتر از این، فرض خطی بودن لاستیک معتبر نیست */
export const MAX_STEER = 0.55;           // rad  (~۳۱ درجه)

/**
 * آستانه‌ی راهبرد «تعویض تطبیقی مدل» در پیپر:
 * در زاویه فرمان بیش از ۰.۲ رادیان، مدل خطی خطا می‌دهد، پس یک اصلاح
 * غیرخطی سبک (اشباع نیروی لاستیک) فعال می‌شود.
 */
export const NONLINEAR_SWITCH = 0.20;    // rad

/**
 * یک خودرو با وضعیت دینامیکی کامل.
 *
 * بردار حالت مطابق معادله (۹) و (۱۰) پیپر:   x = [ v , r ]
 * بردار ورودی مطابق معادله (۱۱):              u = [ δf , Mz ]
 */
export class Vehicle {
  constructor(opts = {}) {
    const p = { ...DEFAULT_PARAMS, ...(opts.params || {}) };
    this.p = p;

    // --- وضعیت دینامیکی ---
    this.u   = opts.u   ?? 8;      // سرعت طولی (m/s)
    this.v   = 0;                  // سرعت عرضی (m/s)   ← متغیر حالت ۱
    this.r   = 0;                  // نرخ دوران (rad/s) ← متغیر حالت ۲
    this.psi = opts.psi ?? 0;      // زاویه‌ی سمت ψ (rad)

    // --- موقعیت در دستگاه جهانی (متر) ---
    this.x = opts.x ?? 0;
    this.z = opts.z ?? 0;

    // --- ورودی‌های کنترلی ---
    this.delta = 0;                // زاویه فرمان چرخ جلو δf (rad)
    this.Mz    = 0;                // گشتاور دورانی کمکی (N·m)

    // --- مقادیر گزارشی برای رابط کاربری و اعتبارسنجی ---
    this.ay          = 0;          // شتاب عرضی (m/s²)
    this.alphaF      = 0;          // زاویه لغزش لاستیک جلو (rad)
    this.alphaR      = 0;          // زاویه لغزش لاستیک عقب (rad)
    this.nonlinearOn = false;      // آیا اصلاح غیرخطی فعال شده است؟

    // --- ویژگی‌های غیردینامیکی (لایه‌ی روایت شبیه‌سازی) ---
    this.typeId   = opts.typeId   || "CarID-1";
    this.targetU  = opts.targetU  ?? this.u;
    this.battery  = 100;
    this.odometer = 0;
    this.id       = opts.id ?? 0;
  }

  /**
   * زاویه‌ی لغزش لاستیک جلو — معادله (۴) پیپر:
   *     αf ≈ δf − (v + r·lf) / u
   */
  slipFront() {
    const uSafe = Math.max(this.u, 1.0);   // جلوگیری از تقسیم بر صفر در سرعت پایین
    return this.delta - (this.v + this.r * this.p.lf) / uSafe;
  }

  /**
   * زاویه‌ی لغزش لاستیک عقب — معادله (۵) پیپر:
   *     αr ≈ −(v − r·lr) / u
   */
  slipRear() {
    const uSafe = Math.max(this.u, 1.0);
    return -(this.v - this.r * this.p.lr) / uSafe;
  }

  /**
   * یک گام انتگرال‌گیری با روش اویلر پیشرو — معادله (۱۲) پیپر:
   *     x(k+1) = x(k) + (A·x(k) + B·u(k))·Δt
   *
   * که به‌صورت بازشده همان معادلات (۱۳) و (۱۴) است.
   *
   * @param {number} dt گام زمانی Δt — پیپر ۰.۰۲ ثانیه (حلقه‌ی FixedUpdate یونیتی) استفاده می‌کند
   */
  step(dt) {
    const { m, Iz, Cf, Cr, lf, lr } = this.p;
    const uSafe = Math.max(this.u, 1.0);

    // زاویه فرمان را به بازه‌ی فیزیکی محدود می‌کنیم
    const delta = Math.max(-MAX_STEER, Math.min(MAX_STEER, this.delta));

    // --- راهبرد تعویض تطبیقی مدل (بخش «Experiment 2» پیپر) ---
    // در فرمان‌های بزرگ، لاستیک به اشباع می‌رسد و رابطه‌ی خطی
    // نیرو را بیش از حد تخمین می‌زند؛ ضریب زیر آن را تصحیح می‌کند.
    this.nonlinearOn = Math.abs(delta) > NONLINEAR_SWITCH;
    const sat = this.nonlinearOn
      ? NONLINEAR_SWITCH / Math.abs(delta) + (1 - NONLINEAR_SWITCH / Math.abs(delta)) * 0.75
      : 1.0;
    const CfE = Cf * sat;   // سختی مؤثر لاستیک جلو
    const CrE = Cr * sat;   // سختی مؤثر لاستیک عقب

    // ----- معادله (۱۳): به‌روزرسانی سرعت عرضی -----
    //   v(k+1) = v(k) + [ −(Cf+Cr)/(m·u)·v − (Cf·lf − Cr·lr)/(m·u)·r + (Cf/m)·δf ] · Δt
    //
    // یادداشت: جمله‌ی −u·r (شتاب گریز از مرکز ناشی از دوران دستگاه مختصات بدنه)
    // در متن پیپر داخل ماتریس A نیامده ولی از نظر فیزیکی لازم است، وگرنه
    // خودرو در پیچ به‌جای چرخیدن، به بیرون رانده می‌شود. اینجا افزوده شده است.
    const vDot =
      -((CfE + CrE) / (m * uSafe)) * this.v
      - ((CfE * lf - CrE * lr) / (m * uSafe)) * this.r
      + (CfE / m) * delta
      - uSafe * this.r;

    // ----- معادله (۱۴): به‌روزرسانی نرخ دوران -----
    //   r(k+1) = r(k) + [ −(Cf·lf − Cr·lr)/(Iz·u)·v − (Cf·lf² + Cr·lr²)/(Iz·u)·r
    //                     + (Cf·lf/Iz)·δf + Mz/Iz ] · Δt
    const rDot =
      -((CfE * lf - CrE * lr) / (Iz * uSafe)) * this.v
      - ((CfE * lf * lf + CrE * lr * lr) / (Iz * uSafe)) * this.r
      + ((CfE * lf) / Iz) * delta
      + this.Mz / Iz;

    // انتگرال‌گیری اویلر پیشرو — معادله (۹)
    this.v += vDot * dt;
    this.r += rDot * dt;

    // ----- ψ̇ = r  (نرخ تغییر زاویه‌ی سمت برابر نرخ دوران است) -----
    this.psi += this.r * dt;

    // ----- انتقال سرعت بدنه به دستگاه جهانی و به‌روزرسانی موقعیت -----
    // در پیپر محور طولی خودرو با محور Z یونیتی منطبق می‌شود (معادله ۱).
    // اینجا هم همان قرارداد رعایت شده: ψ=۰ یعنی رو به +Z.
    const sin = Math.sin(this.psi), cos = Math.cos(this.psi);
    const dx = (this.u * sin + this.v * cos) * dt;
    const dz = (this.u * cos - this.v * sin) * dt;
    this.x += dx;
    this.z += dz;

    // --- مقادیر گزارشی ---
    this.ay       = vDot + uSafe * this.r;          // شتاب عرضی واقعی حس‌شده توسط سرنشین
    this.alphaF   = this.slipFront();
    this.alphaR   = this.slipRear();
    this.odometer += Math.hypot(dx, dz);

    // مصرف باتری — پیپر آن را «انتگرال ولتاژ-جریان» توصیف می‌کند؛
    // اینجا مدل ساده‌ی متناسب با توان است.
    this.battery = Math.max(0, this.battery - (0.0009 * this.u + 0.0004 * Math.abs(this.ay)) * dt);

    // --- پایدارسازی عددی ---
    // اویلر پیشرو در گام‌های بزرگ می‌تواند واگرا شود؛ حالت را مقید می‌کنیم.
    if (!Number.isFinite(this.v) || !Number.isFinite(this.r)) { this.v = 0; this.r = 0; }
    this.v = Math.max(-15, Math.min(15, this.v));
    this.r = Math.max(-2.5, Math.min(2.5, this.r));
  }

  /** شتاب/ترمز طولی ساده به سمت سرعت هدف (بُعد سوم آزادی) */
  stepLongitudinal(dt, accelLimit = 3.0) {
    const err = this.targetU - this.u;
    const a = Math.max(-accelLimit * 2, Math.min(accelLimit, err * 1.2));
    this.u = Math.max(0, this.u + a * dt);
  }
}

/**
 * مدل مرجع غیرخطی — فقط برای مقایسه در بخش اعتبارسنجی.
 *
 * نقش آن در پروژه همان نقش «Traditional Nonlinear Model» در جدول‌های ۱ تا ۳ پیپر
 * است: یک مدل سنگین‌تر و دقیق‌تر که مدل خطی را با آن می‌سنجیم.
 * از فرمول جادویی Pacejka (نسخه‌ی ساده‌شده) برای نیروی لاستیک استفاده می‌کند.
 */
export class NonlinearVehicle extends Vehicle {
  /**
   * فرمول جادویی Pacejka (نسخه‌ی ساده‌شده):
   *     Fy = D·sin(C·arctan(B·α − E·(B·α − arctan(B·α))))
   *
   * نکته‌ی مهم برای منصفانه بودن مقایسه:
   * ضریب B را از روی سختی پیچشی خطی محاسبه می‌کنیم تا شیب اولیه‌ی این منحنی
   * دقیقاً برابر Cα باشد (چون شیب منحنی در مبدأ برابر B·C·D است).
   * در نتیجه دو مدل در زوایای لغزش کوچک بر هم منطبق‌اند و فقط در مانورهای
   * تند از هم فاصله می‌گیرند — که همان ادعای پیپر است.
   */
  static pacejka(alpha, Fz, Calpha, mu = 1.0) {
    const C = 1.9, E = 0.97;
    const D = mu * Fz;                  // بیشینه‌ی نیروی عرضی (اشباع چسبندگی)
    const B = Calpha / (C * D);         // شیب مبدأ = B·C·D = Cα
    const Ba = B * alpha;
    return D * Math.sin(C * Math.atan(Ba - E * (Ba - Math.atan(Ba))));
  }

  step(dt) {
    const { m, Iz, lf, lr } = this.p;
    const uSafe = Math.max(this.u, 1.0);
    const delta = Math.max(-MAX_STEER, Math.min(MAX_STEER, this.delta));
    const g = 9.81;
    this.nonlinearOn = true;
    const L = lf + lr;

    // بار قائم استاتیک روی هر محور (انتقال بار در پیپر صرف‌نظر شده، اینجا نگه داشته‌ایم)
    const FzF = (m * g * lr) / L;
    const FzR = (m * g * lf) / L;

    // زوایای لغزش — همان معادلات (۴) و (۵)
    const af = delta - (this.v + this.r * lf) / uSafe;
    const ar = -(this.v - this.r * lr) / uSafe;

    // نیروی عرضی از منحنی غیرخطی لاستیک (به‌جای رابطه‌ی خطی معادلات ۲ و ۳)
    const Fyf = NonlinearVehicle.pacejka(af, FzF, this.p.Cf);
    const Fyr = NonlinearVehicle.pacejka(ar, FzR, this.p.Cr);

    // معادلات نیوتن-اویلر صفحه‌ای
    const vDot = (Fyf * Math.cos(delta) + Fyr) / m - uSafe * this.r;
    const rDot = (lf * Fyf * Math.cos(delta) - lr * Fyr + this.Mz) / Iz;

    this.v += vDot * dt;
    this.r += rDot * dt;
    this.psi += this.r * dt;

    const sin = Math.sin(this.psi), cos = Math.cos(this.psi);
    const dx = (this.u * sin + this.v * cos) * dt;
    const dz = (this.u * cos - this.v * sin) * dt;
    this.x += dx;
    this.z += dz;

    this.ay     = vDot + uSafe * this.r;
    this.alphaF = af;
    this.alphaR = ar;
    this.odometer += Math.hypot(dx, dz);
  }
}

/**
 * کنترلر تناسبی-مشتقی زاویه‌ی سمت — معادله (۱۵) پیپر:
 *     Mz = 1.2·eψ + 0.15·ėψ
 *
 * خروجی کنترلر مسیر (زاویه‌ی سمت مطلوب) را می‌گیرد و گشتاور دورانی کمکی
 * تولید می‌کند تا خودرو سریع‌تر روی مسیر بنشیند.
 */
export class YawPDController {
  constructor(kp = 1.2, kd = 0.15) {
    this.kp = kp;
    this.kd = kd;
    this.prevErr = 0;
  }

  /**
   * @param {number} psiErr خطای زاویه‌ی سمت (rad) — در بازه‌ی [−π, π] نرمال شده
   * @param {number} dt گام زمانی
   * @returns {number} گشتاور دورانی کمکی Mz بر حسب نیوتن‌متر
   */
  update(psiErr, dt) {
    const dErr = dt > 0 ? (psiErr - this.prevErr) / dt : 0;
    this.prevErr = psiErr;
    // ضرایب پیپر برای واحد نرمال‌شده تنظیم شده‌اند؛ مقیاس زیر آن را به N·m می‌برد.
    const SCALE = 3000;
    const Mz = (this.kp * psiErr + this.kd * dErr) * SCALE;
    return Math.max(-9000, Math.min(9000, Mz));
  }

  reset() { this.prevErr = 0; }
}

/** زاویه را به بازه‌ی [−π, π] می‌برد */
export function wrapAngle(a) {
  while (a >  Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
