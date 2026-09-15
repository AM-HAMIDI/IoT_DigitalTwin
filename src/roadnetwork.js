/**
 * شبکه‌ی جاده و مسیریابی
 * =======================
 * جاده‌های OSM را به یک گراف قابل پیمایش تبدیل می‌کند تا خودروها بتوانند
 * مسیرهای واقعی و پیوسته در شهر طی کنند (نه حرکت تصادفی).
 *
 * این بخش معادل «توپولوژی جاده» است که پیپر با CityEngine می‌سازد و
 * ویژگی‌هایی مثل NbrOfLanes و شناسه‌ی جاده را روی آن سوار می‌کند.
 */

import { Path } from './catmullrom.js';

/** دو نقطه که فاصله‌شان از این کمتر باشد، یک گره‌ی مشترک حساب می‌شوند (متر) */
const SNAP = 6.0;

export class RoadNetwork {
  constructor(roads) {
    this.roads = roads;
    this.nodes = [];           // [x, z] گره‌های تقاطع
    this.adj = new Map();      // شماره‌ی گره -> آرایه‌ای از یال‌ها
    this.byId = new Map();     // شناسه‌ی جاده -> شیء جاده
    for (const r of roads) this.byId.set(r.id, r);
    this._build();
    this._findGiantComponent();
  }

  /**
   * بزرگ‌ترین مؤلفه‌ی همبند گراف را پیدا می‌کند.
   *
   * شبکه‌ی جاده‌ی هر شهر چند جزیره‌ی کوچک جدا هم دارد (کوچه‌های بن‌بست،
   * قطعه‌هایی که لبه‌ی محدوده‌ی برش داده‌ها بریده شده‌اند). اگر خودرویی روی
   * یکی از این جزیره‌ها متولد شود، فقط چند متر می‌رود و گیر می‌کند. پس
   * خودروها را فقط در مؤلفه‌ی اصلی متولد می‌کنیم.
   */
  _findGiantComponent() {
    const seen = new Set();
    let best = [];
    for (const start of this.adj.keys()) {
      if (seen.has(start)) continue;
      const stack = [start], comp = [];
      seen.add(start);
      while (stack.length) {
        const u = stack.pop();
        comp.push(u);
        for (const e of this.adj.get(u) || []) {
          if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
        }
      }
      if (comp.length > best.length) best = comp;
    }
    this.giant = best;
    this.spawnNodes = best.filter(n => (this.adj.get(n) || []).length > 0);
  }

  /**
   * شناسه‌ی گره برای یک مختصات برمی‌گرداند و در صورت نبودن، گره‌ی تازه می‌سازد.
   *
   * نکته: صرفِ گرد کردن مختصات روی یک شبکه‌ی سلولی کافی نیست — دو نقطه‌ی
   * بسیار نزدیک ممکن است درست دو طرف مرز یک سلول بیفتند و اشتباهاً دو گره
   * جدا شوند؛ نتیجه‌اش شبکه‌ی جاده‌ی تکه‌تکه است. پس ۹ سلول همسایه را هم
   * می‌گردیم و نزدیک‌ترین گره در شعاع SNAP را برمی‌داریم.
   */
  _nodeAt(x, z) {
    const cx = Math.round(x / SNAP), cz = Math.round(z / SNAP);
    let best = -1, bestD = SNAP * SNAP;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = this._grid.get(`${cx + dx},${cz + dz}`);
        if (!bucket) continue;
        for (const id of bucket) {
          const n = this.nodes[id];
          const d = (n[0] - x) ** 2 + (n[1] - z) ** 2;
          if (d < bestD) { bestD = d; best = id; }
        }
      }
    }
    if (best >= 0) return best;

    const id = this.nodes.length;
    this.nodes.push([x, z]);
    const k = `${cx},${cz}`;
    if (!this._grid.has(k)) this._grid.set(k, []);
    this._grid.get(k).push(id);
    return id;
  }

  /**
   * گراف را در دو گذر می‌سازد.
   *
   * گذر ۱: هر رأس هر جاده به یک گره نگاشت می‌شود و می‌شماریم هر گره به چند
   *         جاده‌ی متفاوت تعلق دارد.
   * گذر ۲: هر جاده را در گره‌هایی که بیش از یک جاده به آن‌ها می‌رسد می‌شکنیم
   *         و برای هر تکه یک یال می‌سازیم.
   *
   * گذر ۲ همان کاری است که پیپر پیش از بستن قواعد CGA انجام می‌دهد:
   * «ترمیم توپولوژی برای اطمینان از اتصال شبکه».
   */
  _build() {
    this._grid = new Map();

    // ---- گذر ۱: نگاشت رأس‌ها به گره و شمارش جاده‌های هر گره ----
    const nodeIdsPerRoad = new Map();
    const roadsAtNode = new Map();
    for (const r of this.roads) {
      const ids = r.line.map(([x, z]) => this._nodeAt(x, z));
      nodeIdsPerRoad.set(r.id, ids);
      for (const id of new Set(ids)) {
        if (!roadsAtNode.has(id)) roadsAtNode.set(id, new Set());
        roadsAtNode.get(id).add(r.id);
      }
    }

    // ---- گذر ۲: شکستن جاده‌ها در تقاطع و ساخت یال‌ها ----
    this.segments = [];
    for (const r of this.roads) {
      const ids = nodeIdsPerRoad.get(r.id);
      const line = r.line;
      let start = 0;

      for (let i = 1; i < line.length; i++) {
        const isJunction = (roadsAtNode.get(ids[i])?.size || 0) >= 2;
        const isEnd = i === line.length - 1;
        if (!isJunction && !isEnd) continue;

        const pts = line.slice(start, i + 1);
        const a = ids[start], b = ids[i];
        start = i;
        if (pts.length < 2 || a === b) continue;

        let len = 0;
        for (let k = 1; k < pts.length; k++) {
          len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        }
        if (len < 5) continue;

        // هر تکه یال مستقلی است ولی ویژگی‌های جاده‌ی مادر را به ارث می‌برد
        const seg = { id: r.id, segKey: `${r.id}:${a}:${b}`, line: pts, len, road: r };
        this.segments.push(seg);

        if (!this.adj.has(a)) this.adj.set(a, []);
        if (!this.adj.has(b)) this.adj.set(b, []);
        this.adj.get(a).push({ to: b, seg, road: r, reverse: false });
        if (!r.oneway) this.adj.get(b).push({ to: a, seg, road: r, reverse: true });
      }
    }
  }

  /** نقاط یک تکه‌جاده را در جهت حرکت برمی‌گرداند */
  static orient(edge) {
    return edge.reverse ? [...edge.seg.line].reverse() : edge.seg.line;
  }

  /**
   * یک مسیر تصادفی اما معتبر در شبکه می‌سازد: از یک گره شروع می‌کند و
   * پشت سر هم یال‌های متصل را دنبال می‌کند (با ترجیح جاده‌های اصلی).
   *
   * @param {number} maxEdges بیشینه‌ی تعداد قطعه‌های جاده در مسیر
   * @returns {{points:Array<[number,number]>, roadIds:number[]}|null}
   */
  randomRoute(maxEdges = 14, rng = Math.random) {
    const startNodes = this.spawnNodes;
    if (!startNodes || !startNodes.length) return null;

    let cur = startNodes[Math.floor(rng() * startNodes.length)];
    const points = [];
    const roadIds = [];
    const usedRoads = new Set();
    let prev = -1;

    for (let i = 0; i < maxEdges; i++) {
      const outs = (this.adj.get(cur) || []).filter(e => !usedRoads.has(e.seg.segKey));
      if (!outs.length) break;

      // ترجیح جاده‌های شریانی و پرهیز از بازگشت فوری به گره‌ی قبلی
      const weighted = [];
      for (const e of outs) {
        let w = e.road.rank * e.road.rank;
        if (e.to === prev) w *= 0.1;
        for (let k = 0; k < Math.max(1, Math.round(w)); k++) weighted.push(e);
      }
      const edge = weighted[Math.floor(rng() * weighted.length)];

      const pts = RoadNetwork.orient(edge);
      // نقطه‌ی اول هر قطعه با نقطه‌ی آخر قطعه‌ی قبلی یکی است، پس حذفش می‌کنیم
      for (let k = points.length ? 1 : 0; k < pts.length; k++) points.push(pts[k]);
      roadIds.push(edge.road.id);
      usedRoads.add(edge.seg.segKey);
      prev = cur;
      cur = edge.to;
    }

    if (points.length < 4) return null;
    return { points, roadIds };
  }

  /**
   * مسیر را به یک شیء Path (اسپلاین Catmull-Rom) تبدیل می‌کند و آن را
   * به اندازه‌ی نصف عرض یک لِین به سمت راست جابه‌جا می‌کند تا خودروها
   * در لِین درست حرکت کنند، نه روی خط وسط جاده.
   */
  routeToPath(route, laneOffset = 1.9) {
    const pts = RoadNetwork.dedupe(route.points);
    if (pts.length < 4) return null;
    const offset = RoadNetwork.offsetPolyline(pts, laneOffset);
    // مسیر باز است: خودرو به انتها که رسید، دوباره از ابتدا شروع می‌کند
    return new Path(offset, false, 6);
  }

  /** نقاط تکراری یا خیلی نزدیک را حذف می‌کند (اسپلاین را بی‌ثبات می‌کنند) */
  static dedupe(pts, minDist = 3.0) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const last = out[out.length - 1];
      if (Math.hypot(pts[i][0] - last[0], pts[i][1] - last[1]) >= minDist) out.push(pts[i]);
    }
    return out;
  }

  /** خط شکسته را به اندازه‌ی d متر به سمت راستِ جهت حرکت جابه‌جا می‌کند */
  static offsetPolyline(pts, d) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      // بردار عمود سمت راست در دستگاه (x به شرق، z به شمال)
      out.push([pts[i][0] + (dz / len) * d, pts[i][1] - (dx / len) * d]);
    }
    return out;
  }
}
