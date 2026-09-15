/**
 * SplinePath.js
 * ================================
 * Implements Catmull-Rom spline interpolation as specified in the Concept Generation Layer.
 * Derives smooth, continuous paths that pass through all waypoints ensuring C1 continuity
 * for the vehicle dynamics trajectory controller.
 */

export function catmullRomPoint(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a, b, c, d) =>
    0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

export function catmullRomTangent(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const f = (a, b, c, d) =>
    0.5 * ((-a + c) + 2 * (2 * a - 5 * b + 4 * c - d) * t + 3 * (-a + 3 * b - 3 * c + d) * t2);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

export class Path {
  constructor(waypoints, closed = true, samplesPerSegment = 8) {
    this.waypoints = waypoints;
    this.closed = closed;
    this.points = [];
    this.cum = [];
    this.length = 0;
    this._build(samplesPerSegment);
  }

  _build(spp) {
    const w = this.waypoints;
    const n = w.length;
    if (n < 2) { this.points = w.slice(); this.cum = [0]; return; }

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

  at(s) {
    if (this.points.length < 2) return { x: 0, z: 0, psi: 0 };
    if (this.closed) s = ((s % this.length) + this.length) % this.length;
    else s = Math.max(0, Math.min(this.length, s));

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
    const psi = Math.atan2(b[0] - a[0], b[1] - a[1]); // psi around vertical axis
    return { x, z, psi };
  }

  curvature(s, ds = 6) {
    const a = this.at(s);
    const b = this.at(s + ds);
    let d = b.psi - a.psi;
    while (d >  Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d) / ds;
  }

  maxCurvatureAhead(s, ahead = 25) {
    let k = 0;
    for (let d = 0; d <= ahead; d += 5) k = Math.max(k, this.curvature(s + d));
    return k;
  }
}
