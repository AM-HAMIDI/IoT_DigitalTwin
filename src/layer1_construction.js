/**
 * لایه ۱ — ساخت صحنه‌ی سه‌بعدی (System Construction Layer)
 * =========================================================
 * داده‌ی پیش‌پردازش‌شده‌ی شهر را به هندسه‌ی سه‌بعدی تبدیل می‌کند.
 *
 * تناظر با پیپر:
 *   BlenderGIS → ساختمان‌های OSM        =  buildBuildings()  (اکسترود چندضلعی پایه)
 *   CityEngine → جاده‌ی پارامتریک       =  buildRoads()      (نوار جاده با عرض = تعداد لِین × ۳.۵)
 *   مجموعه‌های Blender (Terrain/Main/…) =  گروه‌بندی اشیای صحنه
 *
 * برای رندر بلادرنگ، تمام ساختمان‌ها در یک مش ادغام می‌شوند (merged geometry)
 * تا تعداد فراخوانی ترسیم (draw call) از چند هزار به چند عدد برسد — همان کاری
 * که پیپر با SRP Batcher انجام می‌دهد و ادعا می‌کند ۴۰٪ draw call کم می‌کند.
 */

import * as THREE from '../vendor/three.module.js';

/** رنگ‌بندی بر اساس نوع جاده */
const ROAD_COLORS = {
  motorway: 0x6d737d, trunk: 0x696f79, primary: 0x636972,
  secondary: 0x5d626b, tertiary: 0x585d65, residential: 0x53575f,
  unclassified: 0x53575f, living_street: 0x4e525a,
};

export class CityScene {
  /**
   * @param {THREE.Scene} scene صحنه‌ی three.js
   * @param {object} city داده‌ی خروجی tools/osm_to_city.py
   */
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.roadMeshes = new Map();     // شناسه‌ی جاده -> مش (برای رنگ‌آمیزی ترافیک)
    this.buildingIndex = [];         // برای تشخیص ساختمانِ کلیک‌شده
    this.groups = {};
  }

  build() {
    this.buildGround();
    this.buildRoads();
    this.buildBuildings();
  }

  /* ─────────────────── زمین ─────────────────── */

  buildGround() {
    const b = this.city.meta.bounds;
    const w = (b.maxx - b.minx) * 6;
    const h = (b.maxz - b.minz) * 6;
    const geo = new THREE.PlaneGeometry(w, h);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({ color: 0x232830 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set((b.minx + b.maxx) / 2, -0.4, (b.minz + b.maxz) / 2);
    mesh.receiveShadow = false;
    mesh.name = "زمین";
    this.scene.add(mesh);
    this.groups.ground = mesh;
  }

  /* ─────────────────── جاده‌ها ─────────────────── */

  /**
   * هر جاده را به یک نوار مسطح تبدیل می‌کند.
   *
   * عرض نوار = تعداد لِین × عرض لِین — یعنی همان ویژگی پارامتریک
   * `attr NbrOfLanes` که پیپر در قواعد CGA تعریف می‌کند. اگر تعداد لِین
   * عوض شود، هندسه‌ی جاده هم عوض می‌شود.
   */
  buildRoads() {
    const group = new THREE.Group();
    group.name = "جاده‌ها";
    const laneW = this.city.meta.laneWidth;

    for (const r of this.city.roads) {
      const geo = CityScene.ribbonGeometry(r.line, Math.max(3.5, r.lanes * laneW));
      if (!geo) continue;
      const mat = new THREE.MeshLambertMaterial({
        color: ROAD_COLORS[r.type] ?? 0x53575f,
      });
      const mesh = new THREE.Mesh(geo, mat);
      // جاده‌های مهم‌تر کمی بالاتر تا در تقاطع روی جاده‌های فرعی بیفتند
      mesh.position.y = 0.02 + r.rank * 0.006;
      mesh.userData = { kind: "road", road: r };
      mesh.name = r.name;
      group.add(mesh);
      this.roadMeshes.set(r.id, mesh);
    }

    this.scene.add(group);
    this.groups.roads = group;
  }

  /**
   * از یک خط شکسته، نواری با عرض ثابت می‌سازد.
   * در هر رأس، بردار عمود بر جهت مسیر را حساب می‌کند و دو لبه‌ی نوار را
   * به چپ و راست جابه‌جا می‌کند، سپس بین لبه‌ها مثلث می‌کشد.
   */
  static ribbonGeometry(line, width) {
    if (line.length < 2) return null;
    const half = width / 2;
    const pos = [];
    const idx = [];

    for (let i = 0; i < line.length; i++) {
      const a = line[Math.max(0, i - 1)];
      const b = line[Math.min(line.length - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      const nx = dz, nz = -dx;            // بردار عمود سمت راست
      const [x, z] = line[i];
      pos.push(x + nx * half, 0, z + nz * half);
      pos.push(x - nx * half, 0, z - nz * half);
    }

    // ترتیب رأس‌ها اهمیت دارد: three.js روی مثلث‌هایی که خلاف عقربه‌ی ساعت
    // چیده شده‌اند «رو» را بیرون می‌داند. با ترتیب اشتباه، سطح جاده رو به
    // پایین می‌شود و نور خورشید هرگز به آن نمی‌خورد (جاده کاملاً سیاه می‌ماند).
    //   a = لبه‌ی یکِ رأس i      b = لبه‌ی دوِ رأس i
    //   c = لبه‌ی یکِ رأس i+1    d = لبه‌ی دوِ رأس i+1
    for (let i = 0; i < line.length - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);

    // نرمال را دستی رو به بالا می‌گذاریم.
    // اگر به computeVertexNormals تکیه کنیم، جهت نرمال به ترتیب چرخش مثلث‌ها
    // بستگی پیدا می‌کند و در نیمی از قطعه‌ها رو به پایین درمی‌آید؛ نتیجه‌اش
    // جاده‌ی کاملاً سیاه است چون نور خورشید از بالا به آن نمی‌خورد.
    const nrm = new Float32Array(pos.length);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    return geo;
  }

  /* ─────────────────── ساختمان‌ها ─────────────────── */

  /**
   * ساختمان‌ها را از روی چندضلعی پایه اکسترود می‌کند.
   *
   * پیپر برای ساختمان‌های معمولی «هندسه‌ی جایگزین ساده‌شده که فقط ردپای پایه
   * و ارتفاع کلی را نگه می‌دارد» استفاده می‌کند تا تعداد وجه‌ها کم شود.
   * اینجا هم دقیقاً همین کار انجام می‌شود: منشور عمودی روی چندضلعی پایه.
   *
   * همه در یک BufferGeometry ادغام می‌شوند تا فقط یک draw call بخورند.
   */
  buildBuildings() {
    const positions = [];
    const normals = [];
    const colors = [];
    const color = new THREE.Color();

    let vertexCursor = 0;
    for (const b of this.city.buildings) {
      const startVertex = vertexCursor;
      const h = b.h;
      const poly = b.poly;
      const n = poly.length;

      // رنگ بر اساس ارتفاع: برج‌ها روشن‌تر، ساختمان‌های کوتاه تیره‌تر.
      // این همان نقش «MaterialCode» است: یک ویژگی معنایی که رندر را می‌راند.
      const t = Math.min(1, h / 90);
      color.setHSL(0.60 - t * 0.09, 0.05 + t * 0.09, 0.30 + t * 0.26);

      // ---- دیوارها ----
      for (let i = 0; i < n; i++) {
        const [x1, z1] = poly[i];
        const [x2, z2] = poly[(i + 1) % n];
        let nx = z2 - z1, nz = -(x2 - x1);
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl; nz /= nl;

        // دو مثلث برای هر دیوار
        const quad = [
          [x1, 0, z1], [x2, 0, z2], [x2, h, z2],
          [x1, 0, z1], [x2, h, z2], [x1, h, z1],
        ];
        for (const [px, py, pz] of quad) {
          positions.push(px, py, pz);
          normals.push(nx, 0, nz);
          // دیوارها کمی تیره‌تر از سقف، برای خوانایی حجم
          colors.push(color.r * 0.88, color.g * 0.88, color.b * 0.88);
          vertexCursor++;
        }
      }

      // ---- سقف ----
      // مثلث‌بندی بادبزنی؛ برای چندضلعی‌های محدب دقیق و برای مقعرها تقریبی است.
      // چون ساختمان‌ها از بالا دیده می‌شوند و ساده‌شده‌اند، این تقریب کافی است.
      for (let i = 1; i < n - 1; i++) {
        const tri = [poly[0], poly[i], poly[i + 1]];
        for (const [px, pz] of tri) {
          positions.push(px, h, pz);
          normals.push(0, 1, 0);
          colors.push(color.r, color.g, color.b);
          vertexCursor++;
        }
      }

      this.buildingIndex.push({ start: startVertex, end: vertexCursor, data: b });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
    geo.computeBoundingSphere();

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "ساختمان‌ها";
    mesh.userData = { kind: "buildings" };
    this.scene.add(mesh);
    this.groups.buildings = mesh;
    this.buildingMesh = mesh;
  }

  /**
   * از روی شماره‌ی مثلثِ برخوردخورده، مشخص می‌کند کدام ساختمان کلیک شده است.
   * چون همه‌ی ساختمان‌ها در یک مش ادغام شده‌اند، باید در جدول اندیس بگردیم.
   */
  buildingAtVertex(vertexId) {
    let lo = 0, hi = this.buildingIndex.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = this.buildingIndex[mid];
      if (vertexId < e.start) hi = mid - 1;
      else if (vertexId >= e.end) lo = mid + 1;
      else return e.data;
    }
    return null;
  }

  /**
   * رنگ جاده را بر اساس وضعیت ترافیک به‌روز می‌کند.
   *
   * پیپر: «وقتی API وضعیت ازدحام برگرداند، رنگ متریال جاده خودکار عوض
   * می‌شود (سبز برای روان، قرمز برای ازدحام) و نگاشت بصری جریان ترافیک
   * محقق می‌شود.»
   */
  applyTrafficColors(trafficService, enabled = true) {
    for (const [id, mesh] of this.roadMeshes) {
      if (!enabled) {
        const r = this.city.roads.find(x => x.id === id);
        mesh.material.color.setHex(ROAD_COLORS[r?.type] ?? 0x53575f);
        continue;
      }
      const t = trafficService.get(id);
      if (t) mesh.material.color.setHex(t.color);
    }
  }
}
