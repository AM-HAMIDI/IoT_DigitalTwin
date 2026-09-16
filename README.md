# Urban Traffic Digital Twin: WebGL Implementation

An independent, bare-metal mathematical verification and implementation of the digital twin architecture proposed in:

**Urban traffic digital twin system development in Unity**
Li Gong, Menglong Ding — *Scientific Reports* (2025) 15:40085
https://doi.org/10.1038/s41598-025-23943-7

This project reproduces the paper's core claims — specifically the 3-DoF lightweight vehicle kinematics, adaptive LOD scaling for 1,500 concurrent vehicles, and closed-loop environmental feedback — without relying on the black-box physics engines or proprietary DOTS architecture of Unity. It achieves this via a custom deterministic physics scheduler and WebGL GPU instancing.

**Study Area:** City of London (extracted via OpenStreetMap API) — 2,440 buildings, 1,732 road segments, 64 km of network topology.

## Quick Start

This project requires zero external dependencies, package managers (npm), or internet access to run the simulation. The rendering engine (Three.js) is bundled locally.

**Windows execution:**

Double-click the included batch file, or run it via command prompt:

```
serve.bat
```

This spins up a local Python HTTP server and launches the simulation in your default browser at `http://localhost:8080`.

**Headless validation suite:**

To run the mathematical benchmarking scripts without rendering overhead:

```
node tools/validate.js
```

## The Three-Layer Architecture

This codebase adheres to the three-tier architecture defined in the reference paper, mapped to custom JavaScript modules:

| Paper Architecture | Functionality | Project Implementation |
|---|---|---|
| System Construction Layer | 3D model generation via GIS/BIM fusion | `tools/osm_to_city.py` & `src/SceneGenerator.js` |
| Data Acquisition Layer | Live weather API integration and traffic flow data | `src/EnvironmentIngestion.js` |
| Concept Generation Layer | 3-DoF kinematics, LOD strategy, and trajectory splines | `src/KinematicsEngine.js` & `src/SimulationManager.js` |

## Key Implementation Techniques

Porting a hardware-accelerated Unity application to the web while maintaining academic rigor required several engineering decisions worth documenting.

### 1. The 3-DoF Kinematics Engine (with Mathematical Correction)

The core of the paper is the replacement of the heavy nonlinear Pacejka tire model with a linear 3-degrees-of-freedom (longitudinal, lateral, yaw) bicycle model.

- State vector: $x = [v, r]$
- Input vector: $u = [\delta_f, M_z]$

**Correction to the literature:** the published paper omits the centrifugal acceleration term ($-u \cdot r$) from the $A$ matrix in Equation 13. Without this term, vehicles drift outward during cornering instead of maintaining angular momentum. `KinematicsEngine.js` corrects this omission in the forward Euler integration:

$$v_{k+1} = v_k + \left(-\frac{C_f+C_r}{m \cdot u} \cdot v_k - \frac{C_f \cdot l_f - C_r \cdot l_r}{m \cdot u} \cdot r_k + \frac{C_f}{m} \cdot \delta_{f,k} - u \cdot r_k\right) \cdot \Delta t$$

$$r_{k+1} = r_k + \left(\frac{C_f \cdot l_f - C_r \cdot l_r}{I_z \cdot u} \cdot v_k - \frac{C_f \cdot l_f^2 + C_r \cdot l_r^2}{I_z \cdot u} \cdot r_k + \frac{C_f \cdot l_f}{I_z} \cdot \delta_{f,k} + \frac{M_{z,k}}{I_z}\right) \cdot \Delta t$$

Yaw alignment is maintained via a proportional-derivative (PD) controller:

$$M_z = 1.2e_\psi + 0.15\dot{e}_\psi$$

### 2. Deterministic Physics & Adaptive LOD

Browser frame rates fluctuate, which corrupts physics calculations if left unmanaged. To avoid this and mimic Unity's `FixedUpdate`, `SimulationManager.js` uses a custom accumulator loop that evaluates physics strictly at $\Delta t = 0.02$ seconds (50 Hz).

The paper's adaptive level-of-detail (LOD) strategy is implemented algorithmically as well: vehicles beyond a specific distance threshold skip physics evaluation frames, reducing CPU cycles while maintaining visual consistency.

### 3. GPU Instancing vs. SRP Batcher

The paper attributes its low CPU/GPU utilization to Unity's SRP Batcher. To replicate this on the web, `SceneGenerator.js` merges all static geometry into a single `BufferGeometry`, while `main.js` uses WebGL `InstancedMesh`. This renders 1,500 unique vehicles in a single GPU draw call.

### 4. Deliberate Scope Boundaries

GPU-accelerated inter-vehicle collision detection (via Unity Physics) was deliberately left out of this implementation. To isolate and verify the mathematical accuracy of the trajectory splines and 3-DoF model within a browser, computational resources were diverted away from rigid-body colliders and put entirely into the LOD and instancing pipelines.

## Validation Results

The headless validation script (`tools/validate.js`) reproduces the paper's core benchmarks to check mathematical parity.

### Table 1: Physical Accuracy (80 km/h Emergency Evasion)

Testing the 3-DoF linear implementation against a baseline nonlinear model.

| Metric | Nonlinear Baseline | Custom Linear Model | Error % | Paper's Claimed Error |
|---|---|---|---|---|
| Max Lateral Accel | 4.39 m/s² | 4.68 m/s² | 6.7% | 4.4% |
| Peak Yaw Rate | 17.9 °/s | 18.0 °/s | 0.5% | 4.3% |
| Steering Delay | 120 ms | 120 ms | 0% | 8.3% |
| Max Path Deviation | — | 0.203 m | — | < 0.23 m |

**Result:** the custom implementation satisfies the paper's < 0.23 m deviation requirement.

### Table 2: Trajectory Tracking on London Network

| Metric | Value |
|---|---|
| Concurrent Vehicles | 300 |
| Mean Cross-track Error | 0.32 m |
| Median (P50) Error | 0.03 m |
| Physics Compute Time (per step) | 2.1 ms (for 300 vehicles) |
| Compute Time (per vehicle) | 7.2 µs |

## File Structure

```
iotProj/
├── index.html                       Main UI layout and viewport
├── style.css                        LTR UI styling
├── serve.bat                        Windows execution script
│
├── data/
│   ├── osm_raw.json                 Raw Overpass API response
│   └── simulation_environment.json  Processed 3D coordinate mapping
│
├── tools/
│   ├── overpass_query_2.txt         OSM query targeting City of London
│   ├── osm_to_city.py               Layer 1: GIS/BIM parsing pipeline
│   └── validate_2.js                Automated headless validation suite
│
├── src/
│   ├── main.js                      Main loop, GPU instancing, lighting
│   ├── SceneGenerator.js            3D geometry extrusion (Layer 1)
│   ├── EnvironmentIngestion.js      APIs: weather and traffic (Layer 2)
│   ├── KinematicsEngine.js          3-DoF vehicle dynamics (Layer 3)
│   ├── SplinePath.js                Catmull-Rom trajectory interpolation
│   ├── RoadTopology.js              Navigable directional graph logic
│   ├── SimulationManager.js         Fixed-step physics & adaptive LOD
│   └── UIManager.js                 DOM bindings, raycasting, metrics
│
├── vendor/                          Local Three.js dependencies
└── docs/
    ├── paper_mapping.md             Detailed theoretical code mapping
    └── web_approach_defense.md      Architectural defense document
```
