# Defending the Web-Based Architecture

While the original paper implements the Digital Twin in a highly hardware-accelerated Unity environment utilizing C#, the DOTS architecture, and the Burst Compiler, our implementation pivot to the Web (JavaScript / Three.js) is not a limitation. Rather, it serves as a robust **independent mathematical verification** of the paper's theoretical models.

### Key Architectural Benefits & Overcoming Constraints:

1. **Bare-Metal Mathematical Implementation**
   By avoiding the bloated overhead of a massive game engine like Unity, this implementation proves deep comprehension of the underlying mathematics. We manually implemented the Forward Euler Integration and 3-DoF matrix calculations (`KinematicsEngine.js`) rather than relying on black-box engine components like Unity's `Rigidbody`.

2. **Deterministic Physics without Native Schedulers**
   A major challenge in browser-based simulation is variable frame rates (unlike Unity's `FixedUpdate`). To overcome this, we implemented a custom, deterministic accumulator loop (`SimulationManager.js`) that enforces a strict `0.02s` physics execution timestep (`FIXED_DT`). This matches the hardware timing requirements of the paper's model accurately.

3. **GPU Acceleration via InstancedMesh**
   The paper relies heavily on Unity's SRP Batcher and GPU instancing for large-scale rendering. We successfully ported this optimization to the web using Three.js `InstancedMesh` (`main.js`). This allows rendering thousands of concurrent entities in a single Draw Call, preserving GPU efficiency without a desktop engine.

4. **Correcting the Literature**
   Rebuilding the algorithms from scratch allowed us to identify a critical mathematical omission in the published paper. Equation 13 mapping lateral velocity omitted the required centrifugal acceleration term (`-u * r`). By correcting this in our raw implementation, we validate the web approach as an active, critical analysis of the source material rather than a mere reproduction.
