/**
 * RoadTopology.js
 * =======================
 * Converts raw OSM road coordinates into a navigable directional graph structure.
 * Mimics the topology repair mechanisms typically handled by CityEngine prior to
 * binding CGA rules to ensure network connectivity.
 */

import { Path } from './SplinePath.js';

const SNAP = 6.0;

export class RoadTopology {
  constructor(roads) {
    this.roads = roads;
    this.nodes = [];
    this.adj = new Map();
    this.byId = new Map();
    for (const r of roads) this.byId.set(r.id, r);
    this._build();
    this._findGiantComponent();
  }

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

  _build() {
    this._grid = new Map();
    const nodeIdsPerRoad = new Map();
    const roadsAtNode = new Map();
    
    // Pass 1: Map vertices to nodes
    for (const r of this.roads) {
      const ids = r.line.map(([x, z]) => this._nodeAt(x, z));
      nodeIdsPerRoad.set(r.id, ids);
      for (const id of new Set(ids)) {
        if (!roadsAtNode.has(id)) roadsAtNode.set(id, new Set());
        roadsAtNode.get(id).add(r.id);
      }
    }

    // Pass 2: Break roads at junctions to form edges
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

        const seg = { id: r.id, segKey: `${r.id}:${a}:${b}`, line: pts, len, road: r };
        this.segments.push(seg);

        if (!this.adj.has(a)) this.adj.set(a, []);
        if (!this.adj.has(b)) this.adj.set(b, []);
        this.adj.get(a).push({ to: b, seg, road: r, reverse: false });
        if (!r.oneway) this.adj.get(b).push({ to: a, seg, road: r, reverse: true });
      }
    }
  }

  static orient(edge) {
    return edge.reverse ? [...edge.seg.line].reverse() : edge.seg.line;
  }

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

      const weighted = [];
      for (const e of outs) {
        let w = e.road.rank * e.road.rank;
        if (e.to === prev) w *= 0.1;
        for (let k = 0; k < Math.max(1, Math.round(w)); k++) weighted.push(e);
      }
      const edge = weighted[Math.floor(rng() * weighted.length)];

      const pts = RoadTopology.orient(edge);
      for (let k = points.length ? 1 : 0; k < pts.length; k++) points.push(pts[k]);
      roadIds.push(edge.road.id);
      usedRoads.add(edge.seg.segKey);
      prev = cur;
      cur = edge.to;
    }

    if (points.length < 4) return null;
    return { points, roadIds };
  }

  routeToPath(route, laneOffset = 1.9) {
    const pts = RoadTopology.dedupe(route.points);
    if (pts.length < 4) return null;
    const offset = RoadTopology.offsetPolyline(pts, laneOffset);
    return new Path(offset, false, 6);
  }

  static dedupe(pts, minDist = 3.0) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const last = out[out.length - 1];
      if (Math.hypot(pts[i][0] - last[0], pts[i][1] - last[1]) >= minDist) out.push(pts[i]);
    }
    return out;
  }

  static offsetPolyline(pts, d) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      out.push([pts[i][0] + (dz / len) * d, pts[i][1] - (dx / len) * d]);
    }
    return out;
  }
}
