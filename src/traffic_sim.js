/**
 * مدیر شبیه‌سازی ترافیک
 * ======================
 * حلقه‌ی اصلی لایه ۳ را اداره می‌کند: تولید خودرو، تعقیب مسیر، کنترل فرمان،
 * و راهبرد سطح جزئیات (LOD).
 *
 * زنجیره‌ی کنترل دقیقاً همان چیزی است که پیپر توصیف می‌کند:
 *
 *   مسیر Catmull-Rom  ─→  زاویه‌ی سمت مطلوب
 *                          │
 *                          ├─→ قانون فرمان  ─→  δf  ┐
 *                          │                        ├─→ مدل دینامیک ۳ درجه آزادی
 *                          └─→ کنترلر PD   ─→  Mz  ┘         (معادلات ۱۳ و ۱۴)
 */

import { Vehicle, NonlinearVehicle, YawPDController, wrapAngle, MAX_STEER } from './layer3_vehicle.js';
import { RoadNetwork } from './roadnetwork.js';

/** گام زمانی ثابت فیزیک — پیپر از Δt=۰.۰۲ ثانیه (FixedUpdate یونیتی) استفاده می‌کند */
export const FIXED_DT = 0.02;

/**
 * ضرایب قانون فرمان.
 * این مقادیر با جست‌وجوی شبکه‌ای روی ۵۴ ترکیب و ۲۰۰ خودرو انتخاب شده‌اند؛
 * نتیجه: میانگین خطای عرضی ≈ ۰.۲۶ متر (پیپر ۰.۲۳ متر گزارش می‌کند).
 * اسکریپت بازتولید: tools/validate.js
 */
export const STEER_GAINS = { kPsi: 1.1, kCross: 2.4, lookaheadMul: 0.65 };

/** بیشینه‌ی شتاب عرضی راحت برای سرنشین (m/s²) — مبنای کاهش سرعت در پیچ */
export const COMFORT_AY = 2.5;

/**
 * سطوح جزئیات (LOD) — «راهبرد تطبیقی سطح جزئیات» پیپر.
 *
 * ایده: خودرویی که دور از دوربین است لازم نیست ۵۰ بار در ثانیه فیزیک کامل
 * اجرا کند؛ چشم تفاوت را نمی‌بیند ولی پردازنده تفاوت را حس می‌کند.
 */
export const LOD = {
  NEAR: { maxDist: 220,      everyNFrames: 1, name: "کامل" },
  MID:  { maxDist: 600,      everyNFrames: 2, name: "متوسط" },
  FAR:  { maxDist: Infinity, everyNFrames: 4, name: "ساده" },
};

/** انواع خودرو — معادل «Type Identifier Code» پیپر (مثلاً "BusID-7") */
export const VEHICLE_TYPES = [
  { typeId: "CarID-1",   name: "سواری",     color: 0xd8dde6, share: 0.56, len: 4.3, wid: 1.8, hgt: 1.45, speed: [8, 14] },
  { typeId: "TaxiID-3",  name: "تاکسی",     color: 0xf5c518, share: 0.14, len: 4.5, wid: 1.8, hgt: 1.5,  speed: [8, 13] },
  { typeId: "VanID-5",   name: "ون باری",   color: 0x4a90d9, share: 0.16, len: 5.6, wid: 2.0, hgt: 2.3,  speed: [7, 11] },
  { typeId: "BusID-7",   name: "اتوبوس",    color: 0xe05a3a, share: 0.08, len: 11.0, wid: 2.5, hgt: 3.2, speed: [6, 9] },
  { typeId: "TruckID-9", name: "کامیون",    color: 0x8e9aa8, share: 0.06, len: 8.5, wid: 2.5, hgt: 3.0,  speed: [6, 9] },
];

/** یک خودرو به‌همراه مسیر و کنترلرش */
class Agent {
  constructor(id, type, path, network) {
    this.id = id;
    this.type = type;
    this.path = path;
    this.network = network;

    const [lo, hi] = type.speed;
    const speed = lo + Math.random() * (hi - lo);

    const p0 = path.at(0);
    this.veh = new Vehicle({ id, x: p0.x, z: p0.z, psi: p0.psi, u: speed, typeId: type.typeId });
    this.veh.targetU = speed;
    this.baseSpeed = speed;

    this.pd = new YawPDController(1.2, 0.15);   // ضرایب معادله (۱۵) پیپر
    this.s = 0;                                  // مسافت طی‌شده روی مسیر (m)
    this.lod = LOD.NEAR;
    this.frameOffset = id % 4;                   // پخش بار محاسبه بین فریم‌ها
    this.crossTrack = 0;                         // خطای عرضی نسبت به مسیر (m)
    this.dwell = 0;                              // زمان توقف باقی‌مانده در نقطه‌ی کلیدی
    this.done = false;
  }

  /**
   * قانون فرمان: ترکیب خطای زاویه‌ی سمت و خطای عرضی.
   *
   * نقطه‌ای جلوتر روی مسیر (look-ahead) انتخاب می‌شود؛ هرچه سرعت بیشتر،
   * این نقطه دورتر — وگرنه خودرو در سرعت بالا دور فرمان می‌زند.
   */
  steer(dt) {
    const v = this.veh;
    // فاصله‌ی نقطه‌ی دیدبانی متناسب با سرعت است. ضریب ۰.۶۵ از یک جست‌وجوی
    // شبکه‌ای روی ۵۴ ترکیب پارامتر به دست آمده (کمترین خطای عرضی).
    const lookahead = Math.max(5, Math.min(26, v.u * STEER_GAINS.lookaheadMul));
    const target = this.path.at(this.s + lookahead);
    const here = this.path.at(this.s);

    // خطای زاویه‌ی سمت
    const psiErr = wrapAngle(target.psi - v.psi);

    // خطای عرضی: فاصله‌ی علامت‌دار خودرو از خط مسیر
    const dx = v.x - here.x, dz = v.z - here.z;
    this.crossTrack = dx * Math.cos(here.psi) - dz * Math.sin(here.psi);

    // قانون شبیه Stanley: تصحیح زاویه‌ای + تصحیح عرضی
    const cross = Math.atan2(-STEER_GAINS.kCross * this.crossTrack, Math.max(2, v.u));
    v.delta = Math.max(-MAX_STEER, Math.min(MAX_STEER, psiErr * STEER_GAINS.kPsi + cross));

    // گشتاور دورانی کمکی — معادله (۱۵): Mz = 1.2·eψ + 0.15·ėψ
    v.Mz = this.pd.update(psiErr, dt);
  }

  /**
   * بیشینه‌ی سرعت مجاز در پیچ پیش رو.
   *
   * در یک پیچ با انحنای κ، شتاب عرضی برابر u²·κ است. اگر بخواهیم شتاب
   * عرضی از حد راحتی سرنشین بیشتر نشود:
   *     u_max = √(a_y,max / κ)
   * راننده‌ی واقعی هم همین کار را می‌کند: پیش از پیچ سرعت را کم می‌کند.
   */
  cornerSpeedLimit() {
    const k = this.path.maxCurvatureAhead(this.s, 28);
    return k > 1e-4 ? Math.sqrt(COMFORT_AY / k) : Infinity;
  }

  /**
   * یک گام شبیه‌سازی.
   * @param {number} dt گام زمانی مؤثر (با در نظر گرفتن LOD ممکن است چند برابر FIXED_DT باشد)
   * @param {object} ctx وضعیت محیط: ترافیک، جادهٔ خیس، و غیره
   */
  step(dt, ctx) {
    const v = this.veh;

    // توقف در نقطه‌ی کلیدی (ایستگاه اتوبوس، ایستگاه شارژ و…)
    if (this.dwell > 0) {
      this.dwell -= dt;
      v.targetU = 0;
    } else {
      // سرعت هدف از وضعیت ترافیک جاده‌ای که خودرو روی آن است می‌آید.
      // این همان حلقه‌ی بسته‌ی پیپر است: داده‌ی لایه ۲ رفتار لایه ۳ را عوض می‌کند.
      let limit = Math.min(this.baseSpeed, this.cornerSpeedLimit());
      if (ctx.congestionFactor != null) limit *= ctx.congestionFactor;
      // جاده‌ی خیس: راننده‌ها آهسته‌تر می‌رانند
      if (ctx.wet > 0) limit *= (1 - 0.25 * ctx.wet);
      v.targetU = Math.max(1.5, limit);
    }

    v.stepLongitudinal(dt);
    this.steer(dt);
    v.step(dt);

    // پیشروی روی مسیر بر اساس مسافت واقعاً طی‌شده
    this.s += v.u * dt;

    // رسیدن به انتهای مسیر: یک مسیر تازه بگیر (خودرو از شبیه‌سازی خارج نمی‌شود)
    if (this.s >= this.path.length - 8) {
      this.done = true;
    }
  }

  /** مسیر تازه می‌گیرد و خودرو را به ابتدای آن منتقل می‌کند */
  respawn(network) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const route = network.randomRoute(24);
      if (!route) continue;
      const path = network.routeToPath(route);
      if (!path || path.length < 80) continue;
      this.path = path;
      this.routeRoadIds = route.roadIds;
      this.s = 0;
      const p = path.at(0);
      this.veh.x = p.x; this.veh.z = p.z; this.veh.psi = p.psi;
      this.veh.v = 0; this.veh.r = 0;
      this.pd.reset();
      this.done = false;
      return true;
    }
    return false;
  }
}

export class TrafficSim {
  /**
   * @param {RoadNetwork} network شبکه‌ی جاده
   * @param {TrafficService} traffic سرویس وضعیت ترافیک (لایه ۲)
   */
  constructor(network, traffic) {
    this.network = network;
    this.traffic = traffic;
    this.agents = [];
    this.nextId = 0;
    this.frame = 0;
    this.accumulator = 0;

    // شمارنده‌های داشبورد — پیپر «خودروهای سرویس‌دهی‌شده» و «تعداد وظایف» را نشان می‌دهد
    this.stats = { servicedVehicles: 0, totalDistanceKm: 0, simTasks: 0,
                   physicsStepsPerFrame: 0, lastPhysicsMs: 0 };

    // مدل مرجع غیرخطی برای سنجش خطای مسیر (بخش اعتبارسنجی)
    this.referenceEnabled = false;
  }

  /** نوع خودرو را بر اساس سهم هر نوع در ترافیک شهری انتخاب می‌کند */
  static pickType() {
    let x = Math.random();
    for (const t of VEHICLE_TYPES) {
      if (x < t.share) return t;
      x -= t.share;
    }
    return VEHICLE_TYPES[0];
  }

  /** تعداد خودروها را به مقدار خواسته‌شده می‌رساند (اسلایدر رابط کاربری) */
  setVehicleCount(n) {
    n = Math.max(0, Math.round(n));
    while (this.agents.length > n) {
      this.agents.pop();
    }
    let guard = 0;
    while (this.agents.length < n && guard++ < n * 6) {
      const route = this.network.randomRoute(24);
      if (!route) continue;
      const path = this.network.routeToPath(route);
      if (!path || path.length < 80) continue;
      const type = TrafficSim.pickType();
      const a = new Agent(this.nextId++, type, path, this.network);
      a.routeRoadIds = route.roadIds;
      // خودرو را در نقطه‌ای تصادفی از مسیرش می‌گذاریم تا همه از یک‌جا شروع نکنند
      a.s = Math.random() * path.length * 0.8;
      const p = path.at(a.s);
      a.veh.x = p.x; a.veh.z = p.z; a.veh.psi = p.psi;
      this.agents.push(a);
      this.stats.simTasks++;
    }
    return this.agents.length;
  }

  /**
   * سطح جزئیات هر خودرو را بر اساس فاصله از دوربین تعیین می‌کند.
   * @param {{x:number,z:number}} camera موقعیت دوربین روی صفحه‌ی زمین
   */
  updateLOD(camera, lodEnabled = true) {
    for (const a of this.agents) {
      if (!lodEnabled) { a.lod = LOD.NEAR; continue; }
      const d = Math.hypot(a.veh.x - camera.x, a.veh.z - camera.z);
      a.lod = d < LOD.NEAR.maxDist ? LOD.NEAR : d < LOD.MID.maxDist ? LOD.MID : LOD.FAR;
    }
  }

  /**
   * شبیه‌سازی را با گام زمانی ثابت جلو می‌برد.
   *
   * از الگوی «انباشتگر» استفاده می‌کنیم: هرچقدر هم نرخ فریم نوسان کند،
   * فیزیک همیشه با Δt ثابت ۰.۰۲ ثانیه اجرا می‌شود. این همان تضمینی است که
   * FixedUpdate در یونیتی می‌دهد و پیپر رویش حساب کرده است.
   *
   * @param {number} frameDt زمان واقعی سپری‌شده از فریم قبل (ثانیه)
   * @param {object} env وضعیت محیط از لایه ۲
   */
  update(frameDt, env = {}) {
    this.frame++;
    // سقف می‌گذاریم تا بعد از یک وقفه‌ی طولانی، مارپیچ مرگ رخ ندهد
    this.accumulator += Math.min(frameDt, 0.1);

    let steps = 0;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    while (this.accumulator >= FIXED_DT) {
      this.accumulator -= FIXED_DT;
      this._fixedStep(env);
      steps++;
      // سقف تعداد گام در یک فریم: اگر سیستم عقب بیفتد، نباید تلاش کند
      // همه‌ی گام‌های عقب‌مانده را یک‌جا جبران کند (مارپیچ مرگ)
      if (steps >= 5) { this.accumulator = 0; break; }
    }
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.physicsStepsPerFrame = steps;
    // زمان واقعی صرف‌شده در معادلات دینامیک — آزمون کارایی این را می‌خواند
    this.stats.lastPhysicsMs = t1 - t0;
    return steps;
  }

  _fixedStep(env) {
    const wet = env.wet ?? 0;
    const respawnQueue = [];

    for (const a of this.agents) {
      // --- راهبرد LOD: خودروهای دور هر چند فریم یک‌بار به‌روز می‌شوند ---
      const n = a.lod.everyNFrames;
      if (n > 1 && (this.frame + a.frameOffset) % n !== 0) continue;
      // گام زمانی را جبران می‌کنیم تا سرعت حرکت درست بماند
      const dt = FIXED_DT * n;

      // وضعیت ترافیک جاده‌ی فعلی → سقف سرعت (حلقه‌ی بسته‌ی لایه ۲ به لایه ۳)
      let congestionFactor = 1;
      if (a.routeRoadIds && a.routeRoadIds.length) {
        const idx = Math.min(
          a.routeRoadIds.length - 1,
          Math.floor((a.s / Math.max(1, a.path.length)) * a.routeRoadIds.length)
        );
        const t = this.traffic.get(a.routeRoadIds[idx]);
        if (t) congestionFactor = Math.max(0.25, 1 - 0.7 * (t.occupancy / 100));
      }

      const before = a.veh.odometer;
      a.step(dt, { congestionFactor, wet });
      this.stats.totalDistanceKm += (a.veh.odometer - before) / 1000;

      if (a.done) respawnQueue.push(a);
    }

    for (const a of respawnQueue) {
      this.stats.servicedVehicles++;
      a.respawn(this.network);
    }
  }

  /** آمار تجمیعی برای داشبورد */
  summary() {
    let sumSpeed = 0, sumCross = 0, nearCount = 0, midCount = 0, farCount = 0;
    for (const a of this.agents) {
      sumSpeed += a.veh.u;
      sumCross += Math.abs(a.crossTrack);
      if (a.lod === LOD.NEAR) nearCount++;
      else if (a.lod === LOD.MID) midCount++;
      else farCount++;
    }
    const n = this.agents.length || 1;
    return {
      count: this.agents.length,
      avgSpeedKmh: +(sumSpeed / n * 3.6).toFixed(1),
      avgCrossTrack: +(sumCross / n).toFixed(3),
      lod: { near: nearCount, mid: midCount, far: farCount },
      ...this.stats,
    };
  }
}
