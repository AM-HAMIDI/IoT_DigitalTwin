/**
 * رابط کاربری و تعامل
 * =====================
 * اسلایدرها، داشبورد پایین صفحه، بازرسی با کلیک، جست‌وجوی TypeID و
 * آزمون‌های اعتبارسنجی.
 *
 * تناظر با پیپر: «اسلایدرها و پنل‌های کنترل در سمت چپ رابط قرار دارند…
 * داشبورد پایین داده‌های شبیه‌سازی مثل خودروهای سرویس‌دهی‌شده و تعداد وظایف
 * را در کنار داده‌های بلادرنگ مثل ظرفیت کل جاده و طول جاده نشان می‌دهد.»
 */

import * as THREE from '../vendor/three.module.js';
import { TrafficService } from './layer2_data.js';
import { Vehicle, NonlinearVehicle, YawPDController, wrapAngle } from './layer3_vehicle.js';
import { LOD, FIXED_DT } from './traffic_sim.js';

/** تبدیل عدد انگلیسی به رقم فارسی */
export function fa(n) {
  return String(n).replace(/[0-9]/g, d => "۰۱۲۳۴۵۶۷۸۹"[d]);
}

const $ = (id) => document.getElementById(id);

export function setupUI(ctx) {
  const { sim, weather, traffic, cityScene, city, camera, controls, scene, renderer, vehicleMeshes } = ctx;

  const state = {
    demand: 1.0,
    lodOn: true,
    trafficColors: true,
    selection: null,     // { kind, ... }
    colorTimer: 0,
  };

  /* ───────────── اسلایدرها ───────────── */

  /**
   * مقدار اولیه‌ی اسلایدرها را از آدرس صفحه می‌خواند.
   * مثال:  index.html?vehicles=800&rain=6&hour=20
   * برای دمو مفید است: می‌شود یک سناریوی مشخص را با لینک باز کرد.
   */
  const params = new URLSearchParams(location.search);

  const bind = (id, outId, fmt, handler, paramName) => {
    const el = $(id), out = $(outId);
    if (paramName && params.has(paramName)) {
      const v = parseFloat(params.get(paramName));
      if (Number.isFinite(v)) el.value = v;
    }
    const apply = () => {
      const v = parseFloat(el.value);
      if (out) out.textContent = fmt(v);
      handler(v);
    };
    el.addEventListener('input', apply);
    apply();
  };

  bind('vehCount', 'outVeh', v => fa(v), v => ctx.onVehicleCount(v), 'vehicles');
  bind('demand', 'outDemand', v => fa(v.toFixed(1)) + '×', v => { state.demand = v; }, 'demand');
  bind('hour', 'outHour', v => {
    const h = Math.floor(v), m = Math.round((v % 1) * 60);
    return fa(String(h).padStart(2, '0')) + ':' + fa(String(m).padStart(2, '0'));
  }, v => ctx.onHourChange(v), 'hour');

  bind('rain', 'outRain', v => fa(v) + ' mm/h', v => {
    weather.setManual({ rainMmH: v, clouds: Math.min(100, 20 + v * 9), visibility: Math.max(600, 10000 - v * 850) });
    $('rainNote').innerHTML = `ذرات باران = شدت × ۸۰ → <b>${fa(Math.round(v * 80))}</b>`;
    $('weatherSrc').textContent = 'منبع داده: ' + weather.state.source;
  }, 'rain');

  bind('wind', 'outWind', v => fa(v) + ' m/s', v => weather.setManual({ windSpeed: v }), 'wind');

  $('lodOn').addEventListener('change', e => { state.lodOn = e.target.checked; });
  $('showPaths').addEventListener('change', e => ctx.onPathsToggle(e.target.checked));
  $('trafficColors').addEventListener('change', e => {
    state.trafficColors = e.target.checked;
    cityScene.applyTrafficColors(traffic, state.trafficColors);
  });

  /* ───────────── آب‌وهوای زنده ───────────── */

  $('fetchWeather').addEventListener('click', async () => {
    const key = $('owmKey').value.trim();
    if (!key) { $('weatherSrc').textContent = 'منبع داده: کلید API وارد نشده'; return; }
    weather.apiKey = key;
    $('weatherSrc').textContent = 'در حال دریافت…';
    const ok = await weather.fetchLive();
    $('weatherSrc').textContent = ok
      ? `منبع داده: ${weather.state.source} — ${weather.state.description}، ${fa(weather.state.tempC.toFixed(0))}°`
      : 'منبع داده: دریافت ناموفق، حالت شبیه‌سازی';
    if (ok) {
      $('rain').value = weather.state.rainMmH;
      $('outRain').textContent = fa(weather.state.rainMmH) + ' mm/h';
      $('rainNote').innerHTML = `ذرات باران = شدت × ۸۰ → <b>${fa(Math.round(weather.state.rainMmH * 80))}</b>`;
    }
  });

  /* ───────────── بازرسی با کلیک ───────────── */

  const raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 2;
  const pointer = new THREE.Vector2();
  let highlight = null;

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    // اول خودروها، بعد جاده‌ها، آخر ساختمان‌ها
    const vehTargets = [...vehicleMeshes.values()].map(v => v.mesh);
    const hitsV = raycaster.intersectObjects(vehTargets, false);
    if (hitsV.length) {
      const h = hitsV[0];
      const entry = [...vehicleMeshes.values()].find(v => v.mesh === h.object);
      const agent = entry?.agents[h.instanceId];
      if (agent) { select({ kind: 'vehicle', agent }); return; }
    }

    const hitsR = raycaster.intersectObjects(cityScene.groups.roads.children, false);
    if (hitsR.length) { select({ kind: 'road', road: hitsR[0].object.userData.road, mesh: hitsR[0].object }); return; }

    const hitsB = raycaster.intersectObject(cityScene.buildingMesh, false);
    if (hitsB.length) {
      const b = cityScene.buildingAtVertex(hitsB[0].face.a);
      if (b) { select({ kind: 'building', building: b, point: hitsB[0].point }); return; }
    }

    select(null);
  });

  function clearHighlight() {
    if (highlight?.mesh && highlight.originalColor != null) {
      highlight.mesh.material.color.setHex(highlight.originalColor);
    }
    if (highlight?.marker) { scene.remove(highlight.marker); highlight.marker.geometry.dispose(); }
    highlight = null;
  }

  function select(sel) {
    clearHighlight();
    state.selection = sel;
    if (!sel) { renderInspector(); return; }

    if (sel.kind === 'road') {
      // پیپر: «وقتی جاده‌ای انتخاب می‌شود، شیدر درخشش خطی برای بازخورد بصری فعال می‌شود»
      highlight = { mesh: sel.mesh, originalColor: sel.mesh.material.color.getHex() };
      sel.mesh.material.color.setHex(0x4da3ff);
    } else if (sel.kind === 'building') {
      const geo = new THREE.RingGeometry(6, 8, 28);
      geo.rotateX(-Math.PI / 2);
      const marker = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x4da3ff }));
      marker.position.set(sel.point.x, 0.6, sel.point.z);
      scene.add(marker);
      highlight = { marker };
    }
    renderInspector();
  }

  /* ───────────── جست‌وجوی TypeID ───────────── */

  $('doSearch').addEventListener('click', doSearch);
  $('typeSearch').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  function doSearch() {
    const q = $('typeSearch').value.trim().toLowerCase();
    if (!q) return;
    // جست‌وجو در TypeID خودروها
    const matches = sim.agents.filter(a => a.type.typeId.toLowerCase().includes(q));
    if (matches.length) {
      const a = matches[0];
      // پیپر: «وقتی کاربر مؤلفه‌ای را وارد کند، سیستم دوربین را روی هدف متمرکز می‌کند»
      focusOn(a.veh.x, a.veh.z, 45);
      select({ kind: 'vehicle', agent: a, groupSize: matches.length });
      return;
    }
    // جست‌وجو در نام جاده‌ها
    const road = city.roads.find(r => r.name.toLowerCase().includes(q));
    if (road) {
      const mid = road.line[Math.floor(road.line.length / 2)];
      focusOn(mid[0], mid[1], 120);
      select({ kind: 'road', road, mesh: cityScene.roadMeshes.get(road.id) });
      return;
    }
    $('inspectBody').innerHTML = `<p class="hint">چیزی با «${q}» پیدا نشد.<br>نمونه‌ها: BusID-7، TaxiID-3، یا نام خیابان مثل Cheapside</p>`;
  }

  /** دوربین را روی یک نقطه متمرکز می‌کند */
  function focusOn(x, z, dist) {
    controls.target.set(x, 0, z);
    camera.position.set(x + dist * 0.7, dist * 0.8, z + dist * 0.7);
  }

  /* ───────────── نمایش پنل بازرسی ───────────── */

  const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;

  function renderInspector() {
    const el = $('inspectBody');
    const sel = state.selection;
    if (!sel) {
      el.innerHTML = '<p class="hint">روی جاده، ساختمان یا خودرو کلیک کنید تا اطلاعات لحظه‌ای آن نمایش داده شود.</p>';
      return;
    }

    if (sel.kind === 'road') {
      const r = sel.road;
      const t = traffic.get(r.id);
      const lv = TrafficService.LEVELS[(t?.level ?? 1) - 1];
      el.innerHTML = `
        <p class="title">${r.name}</p>
        <div class="kv"><span>وضعیت</span>
          <b><span class="badge" style="background:#${lv.color.toString(16).padStart(6, '0')}">${lv.name}</span></b></div>
        ${kv('شناسه جاده', fa(r.id))}
        ${kv('نوع', r.type)}
        ${kv('تعداد لِین', fa(r.lanes))}
        ${kv('عرض', fa(r.width) + ' m')}
        ${kv('طول', fa(r.len) + ' m')}
        ${kv('سرعت متوسط', fa(t?.speed ?? '—') + ' km/h')}
        ${kv('نرخ اشغال', fa(t?.occupancy ?? '—') + '٪')}
        ${kv('یک‌طرفه', r.oneway ? 'بله' : 'خیر')}
        <p class="hint" style="margin-top:8px">داده‌ی ترافیک از سرویس لایه ۲ می‌آید و هر فریم به‌روز می‌شود.</p>`;
    }

    else if (sel.kind === 'building') {
      const b = sel.building;
      el.innerHTML = `
        <p class="title">${b.name || 'ساختمان بی‌نام'}</p>
        ${kv('شناسه OSM', fa(b.id))}
        ${kv('ارتفاع', fa(b.h) + ' m')}
        ${kv('طبقات تقریبی', fa(Math.max(1, Math.round(b.h / 3.2))))}
        ${kv('کد متریال', b.mat)}
        ${kv('رأس‌های پایه', fa(b.poly.length))}
        <p class="hint" style="margin-top:8px">«کد متریال» همان فراداده‌ی BIM است که در پیپر به عناصر GIS تزریق می‌شود.</p>`;
    }

    else if (sel.kind === 'vehicle') {
      const a = sel.agent;
      const v = a.veh;
      el.innerHTML = `
        <p class="title">${a.type.name} · ${a.type.typeId}</p>
        ${sel.groupSize ? kv('خودروهای هم‌نوع', fa(sel.groupSize)) : ''}
        ${kv('سرعت طولی u', fa((v.u * 3.6).toFixed(1)) + ' km/h')}
        ${kv('سرعت عرضی v', fa(v.v.toFixed(3)) + ' m/s')}
        ${kv('نرخ دوران r', fa((v.r * 180 / Math.PI).toFixed(1)) + ' °/s')}
        ${kv('زاویه فرمان δf', fa((v.delta * 180 / Math.PI).toFixed(1)) + '°')}
        ${kv('گشتاور کمکی Mz', fa(v.Mz.toFixed(0)) + ' N·m')}
        ${kv('شتاب عرضی', fa(v.ay.toFixed(2)) + ' m/s²')}
        ${kv('لغزش جلو αf', fa((v.alphaF * 180 / Math.PI).toFixed(2)) + '°')}
        ${kv('لغزش عقب αr', fa((v.alphaR * 180 / Math.PI).toFixed(2)) + '°')}
        ${kv('خطای عرضی مسیر', fa(a.crossTrack.toFixed(3)) + ' m')}
        ${kv('مدل غیرخطی', v.nonlinearOn ? 'فعال (δf > ۰.۲)' : 'غیرفعال')}
        ${kv('سطح جزئیات', a.lod.name)}
        ${kv('باتری', fa(v.battery.toFixed(1)) + '٪')}
        ${kv('کیلومترشمار', fa((v.odometer / 1000).toFixed(2)) + ' km')}`;
    }
  }

  /** پنل بازرسی خودرو باید زنده باشد؛ هر ۵ فریم به‌روز می‌شود */
  let inspTick = 0;
  function tickInspector() {
    if (state.selection?.kind !== 'vehicle') return;
    if (++inspTick % 5 !== 0) return;
    renderInspector();
  }

  /* ───────────── رنگ‌آمیزی ازدحام ───────────── */

  function tickTrafficColors(dt) {
    state.colorTimer += dt;
    if (state.colorTimer < 0.5) return;       // نیم‌ثانیه‌ای کافی است
    state.colorTimer = 0;
    cityScene.applyTrafficColors(traffic, state.trafficColors);
  }

  /* ───────────── داشبورد ───────────── */

  const totalRoadKm = city.roads.reduce((s, r) => s + r.len, 0) / 1000;

  function updateDashboard({ fps, physicsMs }) {
    const s = sim.summary();
    const t = traffic.summary();
    $('dFps').textContent   = fa(fps.toFixed(0));
    $('dVeh').textContent   = fa(s.count);
    $('dPhys').textContent  = fa(physicsMs.toFixed(2)) + ' ms';
    $('dSpeed').textContent = fa(s.avgSpeedKmh) + ' km/h';
    $('dErr').textContent   = fa(s.avgCrossTrack.toFixed(2)) + ' m';
    $('dServed').textContent= fa(s.servicedVehicles);
    $('dDist').textContent  = fa(s.totalDistanceKm.toFixed(1)) + ' km';
    $('dJam').textContent   = fa(t.congestionRate) + '٪';
    $('dRoad').textContent  = fa(totalRoadKm.toFixed(1)) + ' km';
    $('dLod').textContent   = `${fa(s.lod.near)}/${fa(s.lod.mid)}/${fa(s.lod.far)}`;

    // رنگ نرخ فریم: سبز بالای ۶۰، زرد بالای ۳۰، قرمز پایین‌تر
    $('dFps').style.color = fps >= 60 ? 'var(--good)' : fps >= 30 ? 'var(--warn)' : 'var(--bad)';
  }

  /* ───────────── آزمون کارایی ───────────── */

  $('runBench').addEventListener('click', () => runBenchmark());

  /**
   * آزمون کارایی — بازتولید جدول‌های ۲ و ۳ پیپر.
   *
   * تعداد خودرو را پله‌پله بالا می‌برد و در هر پله نرخ فریم پایدار و
   * زمان فیزیک را اندازه می‌گیرد.
   */
  async function runBenchmark() {
    const btn = $('runBench');
    const out = $('benchOut');
    btn.disabled = true;
    const savedCount = sim.agents.length;

    const steps = [50, 100, 200, 400, 800, 1200, 1500];
    const rows = [];
    out.innerHTML = '<div class="prog"><i></i></div><p class="note">در حال اندازه‌گیری…</p>';
    const bar = out.querySelector('.prog i');

    for (let i = 0; i < steps.length; i++) {
      const n = steps[i];
      sim.setVehicleCount(n);
      bar.style.width = `${(i / steps.length) * 100}%`;

      // یک ثانیه فرصت می‌دهیم صحنه پایدار شود، بعد یک ثانیه اندازه می‌گیریم
      await measure(1.0, false);
      const m = await measure(1.2, true);
      rows.push({ n, ...m });

      out.innerHTML = '<div class="prog"><i style="width:' + ((i + 1) / steps.length) * 100 + '%"></i></div>'
        + renderBenchTable(rows);
    }

    sim.setVehicleCount(savedCount);
    $('vehCount').value = savedCount;
    $('outVeh').textContent = fa(savedCount);
    btn.disabled = false;
    out.innerHTML = renderBenchTable(rows)
      + `<p class="note">هر ردیف: میانگین ۱.۲ ثانیه اندازه‌گیری پس از پایدار شدن صحنه.
         ستون «فیزیک» زمان صرف‌شده در معادلات ۱۳ و ۱۴ برای همه‌ی خودروهاست.</p>`;
  }

  /** نرخ فریم و زمان فیزیک را در بازه‌ای مشخص اندازه می‌گیرد */
  function measure(seconds, collect) {
    return new Promise(resolve => {
      let frames = 0, elapsed = 0, physTotal = 0;
      const t0 = performance.now();
      let lastT = t0;
      const probe = () => {
        const now = performance.now();
        const dt = (now - lastT) / 1000;
        lastT = now;
        elapsed += dt; frames++;
        physTotal += sim.stats.lastPhysicsMs || 0;
        if (elapsed < seconds) requestAnimationFrame(probe);
        else resolve({
          fps: frames / elapsed,
          physMs: physTotal / frames,
        });
      };
      requestAnimationFrame(probe);
    });
  }

  function renderBenchTable(rows) {
    return `<table>
      <tr><th>خودرو</th><th>FPS</th><th>فیزیک</th><th>هر خودرو</th></tr>
      ${rows.map(r => {
        const color = r.fps >= 60 ? 'var(--good)' : r.fps >= 30 ? 'var(--warn)' : 'var(--bad)';
        return `<tr>
          <td>${fa(r.n)}</td>
          <td style="color:${color}">${fa(r.fps.toFixed(0))}</td>
          <td>${fa(r.physMs.toFixed(2))} ms</td>
          <td>${fa((r.physMs / Math.max(1, r.n) * 1000).toFixed(1))} µs</td>
        </tr>`;
      }).join('')}
    </table>`;
  }

  /* ───────────── آزمون دقت: خطی در برابر غیرخطی ───────────── */

  $('runAccuracy').addEventListener('click', () => runAccuracy());

  /**
   * سناریوی «دور زدن اضطراری در ۸۰ کیلومتر بر ساعت» — جدول ۱ پیپر.
   *
   * همان ورودی فرمان به هر دو مدل داده می‌شود و اختلاف مسیر، شتاب عرضی
   * و نرخ دوران گزارش می‌شود.
   */
  function runAccuracy() {
    const out = $('benchOut');
    const u0 = 80 / 3.6;                  // ۸۰ کیلومتر بر ساعت
    const lin = new Vehicle({ u: u0 });
    const non = new NonlinearVehicle({ u: u0 });

    let maxAyL = 0, maxAyN = 0, maxRL = 0, maxRN = 0, maxDev = 0;
    let delayL = null, delayN = null;

    const dt = FIXED_DT;
    const T = 6.0;
    for (let k = 0; k * dt < T; k++) {
      const t = k * dt;
      // مانور دو بار تعویض خط (double lane change) — ورودی استاندارد این آزمون
      const steer = t < 0.5 ? 0
                  : t < 1.5 ? 0.06 * Math.sin((t - 0.5) * Math.PI / 1.0)
                  : t < 2.5 ? -0.06 * Math.sin((t - 1.5) * Math.PI / 1.0)
                  : 0;
      lin.delta = steer; non.delta = steer;
      lin.step(dt); non.step(dt);

      maxAyL = Math.max(maxAyL, Math.abs(lin.ay));
      maxAyN = Math.max(maxAyN, Math.abs(non.ay));
      maxRL  = Math.max(maxRL, Math.abs(lin.r));
      maxRN  = Math.max(maxRN, Math.abs(non.r));
      maxDev = Math.max(maxDev, Math.hypot(lin.x - non.x, lin.z - non.z));

      // تأخیر پاسخ فرمان: زمان تا رسیدن نرخ دوران به ۹۰٪ مقدار بیشینه‌اش
      if (delayL === null && t > 0.5 && Math.abs(lin.r) > 0.9 * 0.062) delayL = (t - 0.5) * 1000;
      if (delayN === null && t > 0.5 && Math.abs(non.r) > 0.9 * 0.062) delayN = (t - 0.5) * 1000;
    }

    const err = (a, b) => (100 * Math.abs(a - b) / Math.max(1e-9, Math.abs(b))).toFixed(1);
    out.innerHTML = `
      <table>
        <tr><th>سنجه</th><th>غیرخطی</th><th>خطی</th><th>خطا</th></tr>
        <tr><td>بیشینه شتاب عرضی</td><td>${fa(maxAyN.toFixed(2))}</td><td>${fa(maxAyL.toFixed(2))}</td><td>${fa(err(maxAyL, maxAyN))}٪</td></tr>
        <tr><td>بیشینه نرخ دوران</td><td>${fa((maxRN * 180 / Math.PI).toFixed(1))}</td><td>${fa((maxRL * 180 / Math.PI).toFixed(1))}</td><td>${fa(err(maxRL, maxRN))}٪</td></tr>
        <tr><td>تأخیر پاسخ فرمان</td><td>${fa((delayN ?? 0).toFixed(0))}</td><td>${fa((delayL ?? 0).toFixed(0))}</td><td>${fa(err(delayL ?? 0, delayN ?? 1))}٪</td></tr>
        <tr><td>انحراف مسیر</td><td colspan="2" style="text-align:center">${fa(maxDev.toFixed(3))} m</td><td>—</td></tr>
      </table>
      <p class="note">سناریو: دور زدن اضطراری در ۸۰ km/h، Δt = ۰.۰۲ s، مدت ۶ ثانیه.
      واحدها: m/s² و °/s و ms. جدول ۱ پیپر خطای ۴.۴٪ تا ۹.۵٪ گزارش می‌کند.</p>`;
  }

  return { state, updateDashboard, tickInspector, tickTrafficColors, renderInspector, focusOn, select };
}
