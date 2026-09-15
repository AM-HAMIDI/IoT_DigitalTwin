/**
 * KinematicsEngine.js
 * ===================================================
 * Corresponds to the "Concept Generation Layer" in the paper.
 * Implements the "Unity-optimized vehicle dynamics model".
 * 
 * This uses a 3-Degrees of Freedom (3-DoF) linear bicycle model: longitudinal (u), lateral (v), and yaw (r).
 * It replaces the computationally heavy Pacejka magic formula with a linear tire stiffness model,
 * fulfilling the paper's core algorithmic optimization for large-scale real-time simulation.
 */

export const DEFAULT_PARAMS = {
  m:  1500,     // Vehicle mass (kg)
  Iz: 2500,     // Yaw moment of inertia (kg*m^2)
  Cf: 55000,    // Front tire cornering stiffness (N/rad)
  Cr: 60000,    // Rear tire cornering stiffness (N/rad)
  lf: 1.2,      // Distance from CG to front axle (m)
  lr: 1.5,      // Distance from CG to rear axle (m)
};

export const MAX_STEER = 0.55;           // ~31 degrees max steering angle

/**
 * Adaptive Model-Switching Strategy Threshold (from Experiment 2 in the paper).
 * If steering angle exceeds 0.2 rad, a non-linear saturation correction is applied 
 * to prevent the linear model from overestimating forces.
 */
export const NONLINEAR_SWITCH = 0.20;    

/**
 * Vehicle Class
 * State vector (Eq 9 & 10): x = [v, r]
 * Input vector (Eq 11): u = [delta_f, Mz]
 */
export class Vehicle {
  constructor(opts = {}) {
    this.p = { ...DEFAULT_PARAMS, ...(opts.params || {}) };
    
    // Dynamic State Variables
    this.u   = opts.u   ?? 8;      // Longitudinal velocity
    this.v   = 0;                  // Lateral velocity (State variable 1)
    this.r   = 0;                  // Yaw rate (State variable 2)
    this.psi = opts.psi ?? 0;      // Heading angle (psi)

    // Global Position
    this.x = opts.x ?? 0;
    this.z = opts.z ?? 0;

    // Control Inputs
    this.delta = 0;                // Front wheel steering angle (delta_f)
    this.Mz    = 0;                // Additional yaw moment

    // Reporting & Validation Variables
    this.ay          = 0;          // Lateral acceleration
    this.alphaF      = 0;          // Front tire slip angle
    this.alphaR      = 0;          // Rear tire slip angle
    this.nonlinearOn = false;      

    // Non-dynamic properties (Metadata)
    this.typeId   = opts.typeId   || "CarID-1";
    this.targetU  = opts.targetU  ?? this.u;
    this.battery  = 100;
    this.odometer = 0;
    this.id       = opts.id ?? 0;
  }

  /**
   * Front tire slip angle - Corresponds to Eq (4) in the paper:
   * alpha_f ≈ delta_f - (v + r*lf) / u
   */
  slipFront() {
    const uSafe = Math.max(this.u, 1.0);
    return this.delta - (this.v + this.r * this.p.lf) / uSafe;
  }

  /**
   * Rear tire slip angle - Corresponds to Eq (5) in the paper:
   * alpha_r ≈ -(v - r*lr) / u
   */
  slipRear() {
    const uSafe = Math.max(this.u, 1.0);
    return -(this.v - this.r * this.p.lr) / uSafe;
  }

  /**
   * Forward Euler Integration Step - Corresponds to Eq (12) in the paper:
   * x(k+1) = x(k) + (A*x(k) + B*u(k)) * dt
   * (Expands into Equations 13 and 14)
   * @param {number} dt Time step (paper uses 0.02s for Unity FixedUpdate)
   */
  step(dt) {
    const { m, Iz, Cf, Cr, lf, lr } = this.p;
    const uSafe = Math.max(this.u, 1.0);

    const delta = Math.max(-MAX_STEER, Math.min(MAX_STEER, this.delta));

    // Adaptive model switching: apply saturation at high steering angles
    this.nonlinearOn = Math.abs(delta) > NONLINEAR_SWITCH;
    const sat = this.nonlinearOn
      ? NONLINEAR_SWITCH / Math.abs(delta) + (1 - NONLINEAR_SWITCH / Math.abs(delta)) * 0.75
      : 1.0;
    const CfE = Cf * sat;
    const CrE = Cr * sat;

    // --- Eq (13): Lateral Velocity Update ---
    // NOTE: The term `- uSafe * this.r` (centrifugal acceleration) was mathematically corrected 
    // here as it is physically required to prevent outward drift, resolving an omission in the paper's printed matrix A.
    const vDot =
      -((CfE + CrE) / (m * uSafe)) * this.v
      - ((CfE * lf - CrE * lr) / (m * uSafe)) * this.r
      + (CfE / m) * delta
      - uSafe * this.r;

    // --- Eq (14): Yaw Rate Update ---
    const rDot =
      -((CfE * lf - CrE * lr) / (Iz * uSafe)) * this.v
      - ((CfE * lf * lf + CrE * lr * lr) / (Iz * uSafe)) * this.r
      + ((CfE * lf) / Iz) * delta
      + this.Mz / Iz;

    // Apply Euler integration
    this.v += vDot * dt;
    this.r += rDot * dt;

    // psi_dot = r (Heading angle update)
    this.psi += this.r * dt;

    // Coordinate system transformation (Mapping to world space, psi=0 is +Z)
    const sin = Math.sin(this.psi), cos = Math.cos(this.psi);
    const dx = (this.u * sin + this.v * cos) * dt;
    const dz = (this.u * cos - this.v * sin) * dt;
    this.x += dx;
    this.z += dz;

    this.ay       = vDot + uSafe * this.r;
    this.alphaF   = this.slipFront();
    this.alphaR   = this.slipRear();
    this.odometer += Math.hypot(dx, dz);

    // Battery consumption simulated via voltage-current integration approximation
    this.battery = Math.max(0, this.battery - (0.0009 * this.u + 0.0004 * Math.abs(this.ay)) * dt);

    // Numerical stabilization
    if (!Number.isFinite(this.v) || !Number.isFinite(this.r)) { this.v = 0; this.r = 0; }
    this.v = Math.max(-15, Math.min(15, this.v));
    this.r = Math.max(-2.5, Math.min(2.5, this.r));
  }

  /** Simple longitudinal acceleration toward target speed */
  stepLongitudinal(dt, accelLimit = 3.0) {
    const err = this.targetU - this.u;
    const a = Math.max(-accelLimit * 2, Math.min(accelLimit, err * 1.2));
    this.u = Math.max(0, this.u + a * dt);
  }
}

/**
 * Yaw PD Controller - Corresponds to Eq (15) in the paper:
 * Mz = 1.2 * e_psi + 0.15 * e_psi_dot
 * Generates additional yaw moment to align vehicle with the trajectory.
 */
export class YawPDController {
  constructor(kp = 1.2, kd = 0.15) {
    this.kp = kp;
    this.kd = kd;
    this.prevErr = 0;
  }

  update(psiErr, dt) {
    const dErr = dt > 0 ? (psiErr - this.prevErr) / dt : 0;
    this.prevErr = psiErr;
    const SCALE = 3000;
    const Mz = (this.kp * psiErr + this.kd * dErr) * SCALE;
    return Math.max(-9000, Math.min(9000, Mz));
  }

  reset() { this.prevErr = 0; }
}

export function wrapAngle(a) {
  while (a >  Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
