/**
 * Automated Validation Suite
 * =====================================================
 * Executes headless benchmarks to verify the mathematical accuracy 
 * and compute cost of the custom kinematics implementation.
 *
 *     node tools/validate.js
 *
 * Test 1: Physical Accuracy (Linear vs Non-linear baseline)
 * Test 2: Computational Efficiency (Execution time per physics step)
 * Test 3: Path Tracking Accuracy (Cross-track error over real road networks)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { Vehicle, YawPDController, wrapAngle } from '../src/KinematicsEngine.js';
// Note: We'll include a mock NonLinearVehicle class here strictly for the benchmark baseline
import { RoadTopology } from '../src/RoadTopology.js';
import { TrafficService } from '../src/EnvironmentIngestion.js';
import { SimulationManager, FIXED_DT } from '../src/SimulationManager.js';

// Baseline model for testing only
class NonlinearVehicle extends Vehicle {
    static pacejka(alpha, Fz, Calpha, mu = 1.0) {
      const C = 1.9, E = 0.97;
      const D = mu * Fz;                  
      const B = Calpha / (C * D);         
      const Ba = B * alpha;
      return D * Math.sin(C * Math.atan(Ba - E * (Ba - Math.atan(Ba))));
    }
  
    step(dt) {
      const { m, Iz, lf, lr } = this.p;
      const uSafe = Math.max(this.u, 1.0);
      const delta = Math.max(-0.55, Math.min(0.55, this.delta));
      const g = 9.81;
      this.nonlinearOn = true;
      const L = lf + lr;
  
      const FzF = (m * g * lr) / L;
      const FzR = (m * g * lf) / L;
  
      const af = delta - (this.v + this.r * lf) / uSafe;
      const ar = -(this.v - this.r * lr) / uSafe;
  
      const Fyf = NonlinearVehicle.pacejka(af, FzF, this.p.Cf);
      const Fyr = NonlinearVehicle.pacejka(ar, FzR, this.p.Cr);
  
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

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const city = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'simulation_environment.json'), 'utf8'));

const line = (c = '-') => console.log(c.repeat(74));
const pct = (a, b) => (100 * Math.abs(a - b) / Math.max(1e-9, Math.abs(b)));

/* --------- Test 1: Physical Accuracy --------- */
function testPhysicalAccuracy() {
  console.log('\nTest 1 — Physical Accuracy: 80 km/h Emergency Evasion Maneuver');
  line();

  const u0 = 80 / 3.6;
  const lin = new Vehicle({ u: u0 });
  const non = new NonlinearVehicle({ u: u0 });

  let maxAyL = 0, maxAyN = 0, maxRL = 0, maxRN = 0, maxDev = 0;
  let riseL = null, riseN = null;

  for (let k = 0; k * FIXED_DT < 6.0; k++) {
    const t = k * FIXED_DT;
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

    if (riseL === null && t > 0.5 && Math.abs(lin.r) > 0.03) riseL = (t - 0.5) * 1000;
    if (riseN === null && t > 0.5 && Math.abs(non.r) > 0.03) riseN = (t - 0.5) * 1000;
  }

  const rows = [
    ['Max Lateral Accel (m/s²)', maxAyN, maxAyL],
    ['Peak Yaw Rate (°/s)',  maxRN * 180 / Math.PI, maxRL * 180 / Math.PI],
    ['Steering Delay (ms)',   riseN ?? 0, riseL ?? 0],
  ];

  console.log('Metric'.padEnd(30) + 'Baseline'.padStart(12) + 'Custom'.padStart(12) + 'Error'.padStart(10));
  for (const [name, nv, lv] of rows) {
    console.log(name.padEnd(30) + nv.toFixed(2).padStart(12) + lv.toFixed(2).padStart(12)
              + (pct(lv, nv).toFixed(1) + '%').padStart(10));
  }
  console.log('Max Path Deviation'.padEnd(30) + (maxDev.toFixed(3) + ' m').padStart(34));

  return { maxDev, errors: rows.map(([n, nv, lv]) => pct(lv, nv)) };
}

/* --------- Test 2: Compute Cost --------- */
function testComputeCost() {
  console.log('\n\nTest 2 — Computational Cost per Physics Step');
  line();

  const bench = (Cls, label, n = 200000) => {
    const v = new Cls({ u: 18 });
    v.delta = 0.04;
    for (let i = 0; i < 20000; i++) v.step(FIXED_DT);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) v.step(FIXED_DT);
    const t1 = process.hrtime.bigint();
    const msPerStep = Number(t1 - t0) / 1e6 / n;
    return { label, msPerStep };
  };

  const lin = bench(Vehicle, 'Custom 3-DoF Linear Model');
  const non = bench(NonlinearVehicle, 'Baseline Non-linear Model');

  console.log('Model'.padEnd(30) + 'Step Time'.padStart(16) + 'Steps/Sec'.padStart(18));
  for (const r of [non, lin]) {
    console.log(r.label.padEnd(30)
      + (r.msPerStep.toFixed(5) + ' ms').padStart(16)
      + Math.round(1 / (r.msPerStep / 1000)).toLocaleString('en-US').padStart(18));
  }
  const speedup = non.msPerStep / lin.msPerStep;
  console.log(`\nPerformance Gain: Custom model is ${speedup.toFixed(1)}x faster.`);

  return { lin: lin.msPerStep, non: non.msPerStep, speedup };
}

/* --------- Test 3: Path Tracking --------- */
function testPathTracking() {
  console.log('\n\nTest 3 — Path Tracking Accuracy on Real Road Network');
  line();

  const net = new RoadTopology(city.roads);
  const traffic = new TrafficService(city.roads);
  const sim = new SimulationManager(net, traffic);
  sim.setVehicleCount(300);
  sim.updateLOD({ x: 0, z: 0 }, false); 

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

  console.log(`Vehicles Simulated     : ${s.count}`);
  console.log(`Simulation Duration    : ${simSeconds} sec (${steps} steps at dt=${FIXED_DT})`);
  console.log(`Wall Clock Time        : ${(wall / 1000).toFixed(2)} sec`
            + `  -> ${(simSeconds / (wall / 1000)).toFixed(1)}x Realtime`);
  console.log(`Compute Time per Step  : ${(wall / steps).toFixed(3)} ms for ${s.count} vehicles`);
  line('.');
  console.log(`Mean Cross-track Error : ${mean.toFixed(3)} m`);
  console.log(`Median (P50) Error     : ${p50.toFixed(3)} m`);
  console.log(`95th Percentile (P95)  : ${p95.toFixed(3)} m`);

  return { mean, p50, p95, msPerStep: wall / steps, count: s.count };
}

/* --------- Execution --------- */
console.log('\n========================================================================');
console.log('                 DIGITAL TWIN KINEMATICS VALIDATION SUITE               ');
console.log('========================================================================');

const r1 = testPhysicalAccuracy();
const r2 = testComputeCost();
const r3 = testPathTracking();

console.log('\n\nSUMMARY');
line('=');
console.log(`Max Linear vs Non-Linear Deviation : ${Math.max(...r1.errors).toFixed(1)}%`);
console.log(`Computational Speedup              : ${r2.speedup.toFixed(1)}x`);
console.log(`Mean Trajectory Tracking Error     : ${r3.mean.toFixed(3)} m`);
console.log(`Realtime Capacity Benchmarked      : ${r3.count} vehicles at ${r3.msPerStep.toFixed(2)} ms/step`);
line('=');
console.log();