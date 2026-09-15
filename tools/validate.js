/**
 * اعتبارسنجی خودکار — بازتولید جدول‌های ۱، ۲ و ۳ پیپر
 * =====================================================
 * بدون مرورگر اجرا می‌شود تا عددها قابل تکرار و قابل استناد باشند.
 *
 *     node tools/validate.js
 *
 * سه آزمون:
 *   ۱. دقت فیزیکی  : مدل خطی در برابر مدل غیرخطی (جدول ۱)
 *   ۲. کارایی محاسباتی: زمان یک گام و بیشینه‌ی خودرو (جدول ۲)
 *   ۳. دقت تعقیب مسیر : خطای عرضی روی شبکه‌ی واقعی لندن
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { Vehicle, NonlinearVehicle, YawPDController, wrapAngle } from '../src/layer3_vehicle.js';
import { RoadNetwork } from '../src/roadnetwork.js';
import { TrafficService } from '../src/layer2_data.js';
import { TrafficSim, FIXED_DT } from '../src/traffic_sim.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const city = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'city_london.json'), 'utf8'));

const line = (c = '─') => console.log(c.repeat(74));
const pct = (a, b) => (100 * Math.abs(a - b) / Math.max(1e-9, Math.abs(b)));

/* ═════════ آزمون ۱ — دقت فیزیکی (جدول ۱ پیپر) ═════════ */

/**
 * سناریوی دور زدن اضطراری در ۸۰ کیلومتر بر ساعت.
 * ورودی فرمان یکسان به هر دو مدل داده می‌شود و پاسخشان مقایسه می‌شود.
 */
function testPhysicalAccuracy() {
  console.log('\nآزمون ۱ — دقت فیزیکی: دور زدن اضطراری در ۸۰ km/h');
  line();

  const u0 = 80 / 3.6;
  const lin = new Vehicle({ u: u0 });
  const non = new NonlinearVehicle({ u: u0 });

  let maxAyL = 0, maxAyN = 0, maxRL = 0, maxRN = 0, maxDev = 0;
  let riseL = null, riseN = null;
  const trajL = [], trajN = [];

  for (let k = 0; k * FIXED_DT < 6.0; k++) {
    const t = k * FIXED_DT;
    // مانور استاندارد دو بار تعویض خط
    const steer = t < 0.5 ? 0
                : t < 1.5 ?  0.06 * Math.sin((t - 0.5) * Math.PI)
                : t < 2.5 ? -0.06 * Math.sin((t - 1.5) * Math.PI)
                : 0;
    lin.delta = steer; non.delta = steer;
    lin.step(FIXED_DT); non.step(FIXED_DT);

    maxAyL = Math.max(maxAyL, Math.abs(lin.ay));
    maxAyN = Math.max(maxAyN, Math.abs(non.ay));
    maxRL  = Math.max(maxRL,  Math.abs(lin.r));
    maxRN  = Math.max(maxRN,  Math.abs(non.r));
    maxDev = Math.max(maxDev, Math.hypot(lin.x - non.x, lin.z - non.z));
    trajL.push([lin.x, lin.z]); trajN.push([non.x, non.z]);

    // تأخیر پاسخ فرمان: زمان تا رسیدن نرخ دوران به نصف مقدار نهایی‌اش
    if (riseL === null && t > 0.5 && Math.abs(lin.r) > 0.03) riseL = (t - 0.5) * 1000;
    if (riseN === null && t > 0.5 && Math.abs(non.r) > 0.03) riseN = (t - 0.5) * 1000;
  }

  const rows = [
    ['بیشینه شتاب عرضی (m/s²)', maxAyN, maxAyL],
    ['بیشینه نرخ دوران (°/s)',  maxRN * 180 / Math.PI, maxRL * 180 / Math.PI],
    ['تأخیر پاسخ فرمان (ms)',   riseN ?? 0, riseL ?? 0],
  ];

  console.log('سنجه'.padEnd(30) + 'غیرخطی'.padStart(12) + 'خطی'.padStart(12) + 'خطا'.padStart(10));
  for (const [name, nv, lv] of rows) {
    console.log(name.padEnd(30) + nv.toFixed(2).padStart(12) + lv.toFixed(2).padStart(12)
              + (pct(lv, nv).toFixed(1) + '٪').padStart(10));
  }
  console.log('بیشینه انحراف مسیر'.padEnd(30) + (maxDev.toFixed(3) + ' m').padStart(34));
  console.log('\nپیپر در جدول ۱ خطای ۴.۳٪ تا ۹.۵٪ گزارش می‌کند.');

  return { maxDev, errors: rows.map(([n, nv, lv]) => pct(lv, nv)) };
}

/* ═════════ آزمون ۲ — کارایی محاسباتی (جدول ۲ پیپر) ═════════ */

/** زمان یک گام دینامیک را برای هر دو مدل اندازه می‌گیرد */
function testComputeCost() {
  console.log('\n\nآزمون ۲ — هزینه‌ی محاسباتی یک گام دینامیک');
  line();

  const bench = (Cls, label, n = 200000) => {
    const v = new Cls({ u: 18 });
    v.delta = 0.04;
    // گرم‌کردن، تا کامپایلر JIT کدش را بهینه کند و اندازه‌گیری منصفانه باشد
    for (let i = 0; i < 20000; i++) v.step(FIXED_DT);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) v.step(FIXED_DT);
    const t1 = process.hrtime.bigint();
    const msPerStep = Number(t1 - t0) / 1e6 / n;
    return { label, msPerStep };
  };

  const lin = bench(Vehicle, 'مدل خطی ۳ درجه آزادی');
  const non = bench(NonlinearVehicle, 'مدل غیرخطی (Pacejka)');

  console.log('مدل'.padEnd(30) + 'زمان یک گام'.padStart(16) + 'گام بر ثانیه'.padStart(18));
  for (const r of [non, lin]) {
    console.log(r.label.padEnd(30)
      + (r.msPerStep.toFixed(5) + ' ms').padStart(16)
      + Math.round(1 / (r.msPerStep / 1000)).toLocaleString('en-US').padStart(18));
  }
  const speedup = non.msPerStep / lin.msPerStep;
  console.log(`\nمدل خطی ${speedup.toFixed(1)} برابر سریع‌تر است.`);

  // بیشینه‌ی خودرویی که در بودجه‌ی ۱۶.۶ میلی‌ثانیه‌ی هر فریم (۶۰ FPS) جا می‌شود.
  // سهم فیزیک را یک‌سوم بودجه در نظر می‌گیریم؛ بقیه برای رندر و منطق است.
  const budgetMs = (1000 / 60) / 3;
  const stepsPerFrame = 1;
  console.log('\nبرآورد بیشینه‌ی خودرو در ۶۰ FPS (سهم فیزیک = یک‌سوم بودجه‌ی فریم):');
  console.log('  مدل غیرخطی : ' + Math.floor(budgetMs / (non.msPerStep * stepsPerFrame)).toLocaleString('en-US'));
  console.log('  مدل خطی    : ' + Math.floor(budgetMs / (lin.msPerStep * stepsPerFrame)).toLocaleString('en-US'));
  console.log('\nپیپر در جدول ۲ نسبت ۰.۳–۰.۵ ms در برابر ۰.۰۱–۰.۰۲ ms را گزارش می‌کند.');

  return { lin: lin.msPerStep, non: non.msPerStep, speedup };
}

/* ═════════ آزمون ۳ — دقت تعقیب مسیر روی شبکه‌ی واقعی ═════════ */

function testPathTracking() {
  console.log('\n\nآزمون ۳ — دقت تعقیب مسیر روی شبکه‌ی واقعی City of London');
  line();

  const net = new RoadNetwork(city.roads);
  const traffic = new TrafficService(city.roads);
  const sim = new TrafficSim(net, traffic);
  sim.setVehicleCount(300);
  sim.updateLOD({ x: 0, z: 0 }, false);   // LOD خاموش، تا همه‌ی خودروها فیزیک کامل بگیرند

  const errs = [];
  const simSeconds = 40;
  const steps = Math.round(simSeconds / FIXED_DT);
  const warmup = Math.round(6 / FIXED_DT);

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < steps; i++) {
    traffic.update(FIXED_DT);
    sim.update(FIXED_DT, { wet: 0 });
    if (i > warmup && i % 5 === 0) {
      for (const a of sim.agents) errs.push(Math.abs(a.crossTrack));
    }
  }
  const wall = Number(process.hrtime.bigint() - t0) / 1e6;

  errs.sort((a, b) => a - b);
  const mean = errs.reduce((s, x) => s + x, 0) / errs.length;
  const p50 = errs[Math.floor(errs.length * 0.50)];
  const p95 = errs[Math.floor(errs.length * 0.95)];
  const s = sim.summary();

  console.log(`خودرو                  : ${s.count}`);
  console.log(`مدت شبیه‌سازی          : ${simSeconds} ثانیه (${steps} گام با Δt=${FIXED_DT})`);
  console.log(`زمان واقعی اجرا        : ${(wall / 1000).toFixed(2)} ثانیه`
            + `  → ${(simSeconds / (wall / 1000)).toFixed(1)}× بلادرنگ`);
  console.log(`زمان هر گام            : ${(wall / steps).toFixed(3)} ms برای ${s.count} خودرو`);
  console.log(`زمان هر خودرو در هر گام: ${(wall / steps / s.count * 1000).toFixed(2)} µs`);
  line('·');
  console.log(`میانگین خطای عرضی      : ${mean.toFixed(3)} m`);
  console.log(`میانه (P50)            : ${p50.toFixed(3)} m`);
  console.log(`صدک ۹۵                 : ${p95.toFixed(3)} m`);
  console.log(`سرعت متوسط ناوگان      : ${s.avgSpeedKmh} km/h`);
  console.log(`مسافت تجمعی            : ${s.totalDistanceKm.toFixed(1)} km`);
  console.log(`سفرهای کامل‌شده        : ${s.servicedVehicles}`);
  console.log('\nپیپر خطای تعقیب مسیر ۰.۲۳ متر گزارش می‌کند.');

  return { mean, p50, p95, msPerStep: wall / steps, count: s.count };
}

/* ═════════ اجرا ═════════ */

console.log('\n╔' + '═'.repeat(72) + '╗');
console.log('║' + 'اعتبارسنجی دوقلوی دیجیتال ترافیک شهری'.padStart(52).padEnd(72) + '║');
console.log('╚' + '═'.repeat(72) + '╝');

const r1 = testPhysicalAccuracy();
const r2 = testComputeCost();
const r3 = testPathTracking();

console.log('\n\nخلاصه');
line('═');
console.log(`بیشینه خطای مدل خطی در برابر غیرخطی : ${Math.max(...r1.errors).toFixed(1)}٪`);
console.log(`شتاب محاسباتی مدل خطی               : ${r2.speedup.toFixed(1)}×`);
console.log(`میانگین خطای تعقیب مسیر             : ${r3.mean.toFixed(3)} m`);
console.log(`ظرفیت بلادرنگ                       : ${r3.count} خودرو در ${r3.msPerStep.toFixed(2)} ms بر گام`);
line('═');
console.log();
