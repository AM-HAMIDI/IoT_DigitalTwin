# Digital Twin Paper to Code Mapping

This document provides a transparent and structured mapping of the mathematical models and architectural ideas presented in the reference paper to our web-based custom implementation.

## 1. System Construction Layer
* **Concept:** Procedural city modeling using GIS and BIM integration, lowering draw calls via SRP batcher.
* **Implementation:** `src/SceneGenerator.js`
* **Details:** 
  * Replicates CityEngine's parametric generation (lanes/widths) via `buildRoads()` and ribbon geometries.
  * Extrudes OpenStreetMap building footprints mimicking BlenderGIS.
  * **Optimization:** Merges all geometries into a single `BufferGeometry`, effectively replicating the Unity SRP Batcher's Draw Call reduction.

## 2. Data Acquisition Layer
* **Concept:** Dynamic environment response via multi-source heterogeneous APIs (Amap for traffic, OpenWeatherMap for weather).
* **Implementation:** `src/EnvironmentIngestion.js`
* **Details:**
  * Maps weather data mathematically (e.g., `Emission Rate = Rain Intensity * 80`).
  * Simulates Amap traffic data by adjusting real-time road material coloration based on derived congestion load calculations.

## 3. Concept Generation Layer (Kinematics)
* **Concept:** A Unity-optimized 3-DoF (longitudinal, lateral, yaw) vehicle dynamics model utilizing a linear cornering stiffness model instead of the heavy Pacejka non-linear model.
* **Implementation:** `src/KinematicsEngine.js`
* **Mathematical Mapping:**
  * **Eq 4 & 5 (Slip Angles):** Handled in `Vehicle.slipFront()` and `Vehicle.slipRear()`.
  * **Eq 13 & 14 (State Matrix Expansion):** Handled in `Vehicle.step()`.
    * *Important Mathematical Correction:* The paper omits the centrifugal acceleration term (`- u * r`) in the `A` matrix of Eq 13. Our codebase correctly integrates this to prevent outward lateral drift in cornering.
  * **Eq 15 (PD Controller):** Implemented in `YawPDController.update()`.

## 4. Simulation Engine and Scaling
* **Concept:** Adaptive Level of Detail (LOD) and fixed timestep physics.
* **Implementation:** `src/SimulationManager.js`
* **Details:** 
  * Implements `FIXED_DT = 0.02` using a deterministic physics accumulator to ensure physics update consistency irrespective of variable browser frame rates.
  * Replicates the paper's Adaptive LOD strategy, modulating the execution frequency of the Kinematics Engine based on distance from the camera view.
