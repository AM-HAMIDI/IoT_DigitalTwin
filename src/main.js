/**
 * برنامه‌ی اصلی — اتصال هر سه لایه
 * ==================================
 *   لایه ۱ (layer1_construction.js) : صحنه‌ی سه‌بعدی از داده‌ی OSM
 *   لایه ۲ (layer2_data.js)         : آب‌وهوا، نور خورشید، وضعیت ترافیک
 *   لایه ۳ (layer3_vehicle.js)      : دینامیک خودرو، مسیر، کنترل
 *
 * این فایل حلقه‌ی رندر، نورپردازی، ذرات باران، خودروهای نمونه‌سازی‌شده روی
 * GPU، و رابط کاربری را به هم می‌دوزد.
 */

import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/addons/controls/OrbitControls.js';

import { CityScene } from './layer1_construction.js';
import { WeatherService, TrafficService, solarPosition, sunColor, RAIN_PARTICLES_PER_MM } from './layer2_data.js';
import { RoadNetwork } from './roadnetwork.js';
import { TrafficSim, VEHICLE_TYPES, LOD } from './traffic_sim.js';
import { setupUI, fa } from './ui.js';

const CENTER = { lat: 51.516, lon: -0.0915 };

/* ═══════════════════ راه‌اندازی ═══════════════════ */

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
// نگاشت تُن ACES: بازه‌ی دینامیکی نور خورشید را به بازه‌ی نمایشگر می‌آورد،
// وگرنه صحنه یا سوخته می‌شود یا (مثل حالت اولیه) بیش از حد تیره می‌ماند.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 9000);
camera.position.set(250, 265, 290);   // نمای اولیه: بالا و نزدیک، تا هم شبکه‌ی جاده و هم خودروها دیده شوند

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.maxPolarAngle = Math.PI * 0.487;   // اجازه ندهیم دوربین زیر زمین برود
controls.minDistance = 25;
controls.maxDistance = 2600;
controls.target.set(0, 0, 0);

/* ─────────── نورپردازی (رانده‌شده توسط لایه ۲) ─────────── */

const sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
sunLight.position.set(400, 600, 300);
scene.add(sunLight);

const ambient = new THREE.HemisphereLight(0x9ec3ff, 0x2a3038, 0.9);
scene.add(ambient);

scene.fog = new THREE.FogExp2(0x0d1015, 0.00035);

/* ═══════════════════ بارگذاری داده و ساخت صحنه ═══════════════════ */

const loadText = document.getElementById('loadText');
const setLoad = (t) => { loadText.textContent = t; };

setLoad('در حال خواندن مدل شهر…');
const city = await (await fetch('./data/city_london.json')).json();

setLoad('در حال ساخت هندسه‌ی سه‌بعدی…');
const cityScene = new CityScene(scene, city);
cityScene.build();

setLoad('در حال ساخت شبکه‌ی جاده…');
const network = new RoadNetwork(city.roads);

setLoad('در حال راه‌اندازی سرویس‌های داده…');
const weather = new WeatherService({ lat: CENTER.lat, lon: CENTER.lon });
const traffic = new TrafficService(city.roads);
const sim = new TrafficSim(network, traffic);

/* ═══════════════════ رندر خودروها (نمونه‌سازی روی GPU) ═══════════════════ */

/**
 * برای هر نوع خودرو یک InstancedMesh می‌سازیم.
 *
 * مزیت: صدها خودروی هم‌شکل با یک draw call ترسیم می‌شوند. این همان
 * «GPU instancing» است که پیپر به‌عنوان یکی از سه بهینه‌سازی کلیدی
 * مدل خود نام می‌برد.
 */
const MAX_PER_TYPE = 1600;
const dummy = new THREE.Object3D();
const vehicleMeshes = new Map();

for (const t of VEHICLE_TYPES) {
  const geo = new THREE.BoxGeometry(t.wid, t.hgt, t.len);
  geo.translate(0, t.hgt / 2, 0);
  const mat = new THREE.MeshLambertMaterial({ color: t.color });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX_PER_TYPE);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.userData = { kind: 'vehicles', typeId: t.typeId };
  scene.add(mesh);
  vehicleMeshes.set(t.typeId, { mesh, type: t, agents: [] });
}

/** ماتریس هر خودرو را از وضعیت شبیه‌سازی به‌روز می‌کند */
function syncVehicleInstances() {
  for (const entry of vehicleMeshes.values()) entry.agents.length = 0;
  for (const a of sim.agents) {
    const e = vehicleMeshes.get(a.type.typeId);
    if (e && e.agents.length < MAX_PER_TYPE) e.agents.push(a);
  }
  for (const e of vehicleMeshes.values()) {
    const { mesh, agents } = e;
    for (let i = 0; i < agents.length; i++) {
      const v = agents[i].veh;
      dummy.position.set(v.x, 0.08, v.z);
      // psi حول محور قائم است و در قرارداد ما psi=۰ یعنی رو به +Z
      dummy.rotation.set(0, v.psi, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      agents[i].instanceIndex = i;
    }
    mesh.count = agents.length;
    mesh.instanceMatrix.needsUpdate = true;
  }
}

/* ═══════════════════ ذرات باران (لایه ۲) ═══════════════════ */

/**
 * سامانه‌ی ذرات باران.
 *
 * فرمول تعداد ذرات مستقیماً از پیپر می‌آید:
 *     نرخ انتشار ذرات = شدت بارش (mm/h) × ۸۰
 *
 * ذرات در یک جعبه حول دوربین می‌افتند و وقتی به کف رسیدند دوباره از بالا
 * شروع می‌کنند؛ باد آن‌ها را به پهلو می‌راند (پیپر: «حرکت ذرات تحت تأثیر
 * باد است… شیدر اعوجاج نرمال بر اساس داده‌ی باد»).
 */
const RAIN_BOX = { w: 420, h: 200, d: 420 };
/** ضریب دیداری: نسبت خطی با شدت بارش حفظ می‌شود، فقط مقیاس صحنه جبران می‌شود */
const RAIN_VISUAL_SCALE = 3;
const RAIN_MAX = 12 * RAIN_PARTICLES_PER_MM * RAIN_VISUAL_SCALE;   // سقف: شدت ۱۲ mm/h

const rainGeo = new THREE.BufferGeometry();
const rainPos = new Float32Array(RAIN_MAX * 3);
const rainVel = new Float32Array(RAIN_MAX);
for (let i = 0; i < RAIN_MAX; i++) {
  rainPos[i * 3]     = (Math.random() - 0.5) * RAIN_BOX.w;
  rainPos[i * 3 + 1] = Math.random() * RAIN_BOX.h;
  rainPos[i * 3 + 2] = (Math.random() - 0.5) * RAIN_BOX.d;
  rainVel[i] = 28 + Math.random() * 22;              // سرعت سقوط (m/s)
}
rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
const rainMat = new THREE.PointsMaterial({
  color: 0xaac4e8, size: 0.28, transparent: true, opacity: 0.4, sizeAttenuation: true,
});
const rainPoints = new THREE.Points(rainGeo, rainMat);
rainPoints.frustumCulled = false;
rainPoints.visible = false;
scene.add(rainPoints);

function updateRain(dt) {
  // ── فرمول پیپر ──
  const emission = (weather.state.rainMmH + weather.state.snowMmH) * RAIN_PARTICLES_PER_MM;
  const active = Math.min(RAIN_MAX, Math.round(emission * RAIN_VISUAL_SCALE));

  rainPoints.visible = active > 0;
  if (active === 0) return;

  rainGeo.setDrawRange(0, active);
  // جعبه‌ی باران همراه دوربین حرکت می‌کند تا همیشه اطراف بیننده باران ببارد
  rainPoints.position.set(controls.target.x, 0, controls.target.z);

  // رانش ناشی از باد
  const windRad = weather.state.windDeg * Math.PI / 180;
  const wx = Math.sin(windRad) * weather.state.windSpeed;
  const wz = Math.cos(windRad) * weather.state.windSpeed;

  const p = rainGeo.attributes.position.array;
  for (let i = 0; i < active; i++) {
    const j = i * 3;
    p[j + 1] -= rainVel[i] * dt;
    p[j]     += wx * dt;
    p[j + 2] += wz * dt;
    if (p[j + 1] < 0) {                       // به زمین رسید: از بالا دوباره
      p[j]     = (Math.random() - 0.5) * RAIN_BOX.w;
      p[j + 1] = RAIN_BOX.h;
      p[j + 2] = (Math.random() - 0.5) * RAIN_BOX.d;
    }
  }
  rainGeo.attributes.position.needsUpdate = true;
}

/* ═══════════════════ نورپردازی وابسته به زمان (لایه ۲) ═══════════════════ */

let simHour = 13;

/**
 * خورشید را بر اساس ساعت روز جابه‌جا و رنگش را تنظیم می‌کند.
 * ارتفاع و سمت از فرمول‌های نجومی layer2_data.js می‌آید.
 */
function updateSun() {
  const now = new Date();
  const d = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    Math.floor(simHour), Math.floor((simHour % 1) * 60)
  ));
  const { altitude, azimuth } = solarPosition(d, CENTER.lat, CENTER.lon);
  const { rgb, intensity, kelvin, altitudeDeg } = sunColor(altitude);

  // تبدیل مختصات کروی (ارتفاع، سمت) به موقعیت دکارتی منبع نور
  const dist = 1400;
  sunLight.position.set(
    dist * Math.cos(altitude) * Math.sin(azimuth),
    dist * Math.sin(altitude),
    dist * Math.cos(altitude) * Math.cos(azimuth)
  );
  sunLight.color.setRGB(rgb[0], rgb[1], rgb[2]);

  // ابر، نور مستقیم را کم می‌کند
  const cloudFactor = 1 - 0.55 * (weather.state.clouds / 100);
  sunLight.intensity = intensity * cloudFactor * 2.2;

  // نور محیطی: کف شب صفر نیست. شهر واقعی هم شب روشنایی معابر دارد و
  // بدون این کف، صحنه در ساعات شب عملاً نادیدنی می‌شود.
  ambient.intensity = 0.55 + Math.max(0, intensity) * 0.75;

  // رنگ آسمان و مه با زمان روز عوض می‌شود
  const night = new THREE.Color(0x090b10);
  const day   = new THREE.Color(0x8fb0d8);
  const k = Math.max(0, Math.min(1, (altitudeDeg + 6) / 18));
  const skyColor = night.clone().lerp(day, k);
  // باران و ابر، آسمان را خاکستری می‌کنند
  skyColor.lerp(new THREE.Color(0x6b7480), Math.min(0.75, weather.state.rainMmH / 10 + weather.state.clouds / 260));

  scene.background = skyColor;
  scene.fog.color.copy(skyColor);
  scene.fog.density = weather.fogDensity * 0.22 + 0.00018;

  return { kelvin, altitudeDeg, intensity };
}

/* ═══════════════════ نمایش مسیر اسپلاین ═══════════════════ */

const pathGroup = new THREE.Group();
pathGroup.visible = false;
scene.add(pathGroup);

/** خطوط مسیر Catmull-Rom چند خودرو را رسم می‌کند (برای فهم بصری کنترل مسیر) */
function rebuildPathLines() {
  pathGroup.clear();
  if (!pathGroup.visible) return;
  const mat = new THREE.LineBasicMaterial({ color: 0x4da3ff, transparent: true, opacity: 0.45 });
  const sample = sim.agents.slice(0, 40);
  for (const a of sample) {
    const pts = [];
    for (let s = 0; s <= a.path.length; s += 4) {
      const q = a.path.at(s);
      pts.push(new THREE.Vector3(q.x, 0.5, q.z));
    }
    if (pts.length > 1) pathGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
  }
}

/* ═══════════════════ رابط کاربری ═══════════════════ */

const ui = setupUI({
  sim, weather, traffic, cityScene, city, camera, controls,
  onHourChange:     (h) => { simHour = h; },
  onVehicleCount:   (n) => { sim.setVehicleCount(n); rebuildPathLines(); },
  onPathsToggle:    (on) => { pathGroup.visible = on; rebuildPathLines(); },
  scene, renderer, vehicleMeshes,
});

// تعداد اولیه‌ی خودرو را رابط کاربری تعیین می‌کند (اسلایدر یا پارامتر آدرس)،
// وگرنه مقدار ثابت اینجا پارامتر ?vehicles= را بی‌اثر می‌کرد.
sim.setVehicleCount(parseInt(document.getElementById('vehCount').value, 10) || 150);

// رنگ ازدحام را همان ابتدا اعمال می‌کنیم تا کاربر نیم‌ثانیه جاده‌ی بی‌رنگ نبیند
cityScene.applyTrafficColors(traffic, true);

// داشبورد را پیش از شروع حلقه یک بار پر می‌کنیم تا کاربر خط تیره نبیند
ui.updateDashboard({ fps: 0, physicsMs: 0 });

/* ═══════════════════ حلقه‌ی اصلی ═══════════════════ */

let last = performance.now();
let fpsAccum = 0, fpsFrames = 0, fps = 0;
let physAccum = 0;

function loop() {
  requestAnimationFrame(loop);

  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  // ── لایه ۲: داده‌ی محیطی جلو می‌رود ──
  traffic.update(dt, ui.state.demand);
  const sunInfo = updateSun();
  updateRain(dt);

  // ── لایه ۳: شبیه‌سازی خودروها ──
  sim.updateLOD(controls.target, ui.state.lodOn);
  const wet = Math.min(1, weather.state.rainMmH / 6);   // جاده‌ی خیس رفتار راننده را عوض می‌کند
  const t0 = performance.now();
  sim.update(dt, { wet });
  physAccum += performance.now() - t0;

  syncVehicleInstances();

  // ── رنگ‌آمیزی ازدحام روی جاده (هر نیم ثانیه کافی است) ──
  ui.tickTrafficColors(dt);

  controls.update();
  renderer.render(scene, camera);

  // ── شمارش نرخ فریم ──
  fpsAccum += dt; fpsFrames++;
  if (fpsAccum >= 0.35) {
    fps = fpsFrames / fpsAccum;
    ui.updateDashboard({ fps, physicsMs: physAccum / fpsFrames, sunInfo });
    fpsAccum = 0; fpsFrames = 0; physAccum = 0;
  }
  ui.tickInspector();
}

/* ═══════════════════ رویدادها ═══════════════════ */

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

document.getElementById('loading').classList.add('hidden');
loop();

// برای دسترسی از کنسول مرورگر هنگام دمو یا اشکال‌زدایی
window.DT = { scene, camera, sim, traffic, weather, cityScene, network, ui, THREE };
