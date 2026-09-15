/**
 * SimulationManager.js
 * ======================
 * Manages the main physics and lifecycle loops for the Concept Generation Layer.
 * Evaluates Catmull-Rom paths, applies PD controllers, and updates the Kinematics Engine.
 * 
 * Includes the "Adaptive Level of Detail (LOD) Strategy" directly enabling large scale concurrent
 * processing by adjusting evaluation frequency based on spatial priority.
 */

import { Vehicle, YawPDController, wrapAngle, MAX_STEER } from './KinematicsEngine.js';
import { RoadTopology } from './RoadTopology.js';

export const FIXED_DT = 0.02; // Equivalent to Unity's FixedUpdate cycle (50Hz)
export const STEER_GAINS = { kPsi: 1.1, kCross: 2.4, lookaheadMul: 0.65 };
export const COMFORT_AY = 2.5;

export const LOD = {
  NEAR: { maxDist: 220,      everyNFrames: 1, name: "Full" },
  MID:  { maxDist: 600,      everyNFrames: 2, name: "Mid" },
  FAR:  { maxDist: Infinity, everyNFrames: 4, name: "Low" },
};

export const VEHICLE_TYPES = [
  { typeId: "CarID-1",   name: "Car",       color: 0xd8dde6, share: 0.56, len: 4.3, wid: 1.8, hgt: 1.45, speed: [8, 14] },
  { typeId: "TaxiID-3",  name: "Taxi",      color: 0xf5c518, share: 0.14, len: 4.5, wid: 1.8, hgt: 1.5,  speed: [8, 13] },
  { typeId: "VanID-5",   name: "Van",       color: 0x4a90d9, share: 0.16, len: 5.6, wid: 2.0, hgt: 2.3,  speed: [7, 11] },
  { typeId: "BusID-7",   name: "Bus",       color: 0xe05a3a, share: 0.08, len: 11.0, wid: 2.5, hgt: 3.2, speed: [6, 9] },
  { typeId: "TruckID-9", name: "Truck",     color: 0x8e9aa8, share: 0.06, len: 8.5, wid: 2.5, hgt: 3.0,  speed: [6, 9] },
];

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

    this.pd = new YawPDController(1.2, 0.15);
    this.s = 0;
    this.lod = LOD.NEAR;
    this.frameOffset = id % 4; // Distribute load across frames
    this.crossTrack = 0;
    this.dwell = 0;
    this.done = false;
  }

  steer(dt) {
    const v = this.veh;
    const lookahead = Math.max(5, Math.min(26, v.u * STEER_GAINS.lookaheadMul));
    const target = this.path.at(this.s + lookahead);
    const here = this.path.at(this.s);

    const psiErr = wrapAngle(target.psi - v.psi);
    const dx = v.x - here.x, dz = v.z - here.z;
    this.crossTrack = dx * Math.cos(here.psi) - dz * Math.sin(here.psi);

    const cross = Math.atan2(-STEER_GAINS.kCross * this.crossTrack, Math.max(2, v.u));
    v.delta = Math.max(-MAX_STEER, Math.min(MAX_STEER, psiErr * STEER_GAINS.kPsi + cross));

    // Eq 15: Mz = 1.2*e_psi + 0.15*e_psi_dot
    v.Mz = this.pd.update(psiErr, dt);
  }

  cornerSpeedLimit() {
    const k = this.path.maxCurvatureAhead(this.s, 28);
    return k > 1e-4 ? Math.sqrt(COMFORT_AY / k) : Infinity;
  }

  step(dt, ctx) {
    const v = this.veh;
    if (this.dwell > 0) {
      this.dwell -= dt;
      v.targetU = 0;
    } else {
      let limit = Math.min(this.baseSpeed, this.cornerSpeedLimit());
      if (ctx.congestionFactor != null) limit *= ctx.congestionFactor;
      if (ctx.wet > 0) limit *= (1 - 0.25 * ctx.wet);
      v.targetU = Math.max(1.5, limit);
    }

    v.stepLongitudinal(dt);
    this.steer(dt);
    v.step(dt);

    this.s += v.u * dt;
    if (this.s >= this.path.length - 8) this.done = true;
  }

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

export class SimulationManager {
  constructor(network, traffic) {
    this.network = network;
    this.traffic = traffic;
    this.agents = [];
    this.nextId = 0;
    this.frame = 0;
    this.accumulator = 0;
    this.stats = { servicedVehicles: 0, totalDistanceKm: 0, simTasks: 0, physicsStepsPerFrame: 0, lastPhysicsMs: 0 };
  }

  static pickType() {
    let x = Math.random();
    for (const t of VEHICLE_TYPES) {
      if (x < t.share) return t;
      x -= t.share;
    }
    return VEHICLE_TYPES[0];
  }

  setVehicleCount(n) {
    n = Math.max(0, Math.round(n));
    while (this.agents.length > n) this.agents.pop();
    
    let guard = 0;
    while (this.agents.length < n && guard++ < n * 6) {
      const route = this.network.randomRoute(24);
      if (!route) continue;
      const path = this.network.routeToPath(route);
      if (!path || path.length < 80) continue;
      const type = SimulationManager.pickType();
      const a = new Agent(this.nextId++, type, path, this.network);
      a.routeRoadIds = route.roadIds;
      a.s = Math.random() * path.length * 0.8;
      const p = path.at(a.s);
      a.veh.x = p.x; a.veh.z = p.z; a.veh.psi = p.psi;
      this.agents.push(a);
      this.stats.simTasks++;
    }
    return this.agents.length;
  }

  updateLOD(camera, lodEnabled = true) {
    for (const a of this.agents) {
      if (!lodEnabled) { a.lod = LOD.NEAR; continue; }
      const d = Math.hypot(a.veh.x - camera.x, a.veh.z - camera.z);
      a.lod = d < LOD.NEAR.maxDist ? LOD.NEAR : d < LOD.MID.maxDist ? LOD.MID : LOD.FAR;
    }
  }

  update(frameDt, env = {}) {
    this.frame++;
    this.accumulator += Math.min(frameDt, 0.1);

    let steps = 0;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    while (this.accumulator >= FIXED_DT) {
      this.accumulator -= FIXED_DT;
      this._fixedStep(env);
      steps++;
      if (steps >= 5) { this.accumulator = 0; break; }
    }
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.physicsStepsPerFrame = steps;
    this.stats.lastPhysicsMs = t1 - t0;
    return steps;
  }

  _fixedStep(env) {
    const wet = env.wet ?? 0;
    const respawnQueue = [];

    for (const a of this.agents) {
      const n = a.lod.everyNFrames;
      if (n > 1 && (this.frame + a.frameOffset) % n !== 0) continue;
      const dt = FIXED_DT * n;

      let congestionFactor = 1;
      if (a.routeRoadIds && a.routeRoadIds.length) {
        const idx = Math.min(a.routeRoadIds.length - 1, Math.floor((a.s / Math.max(1, a.path.length)) * a.routeRoadIds.length));
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
