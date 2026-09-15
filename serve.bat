@echo off
set PORT=%1
if "%PORT%"=="" set PORT=8080
echo Digital Twin Simulation running at http://localhost:%PORT% (Press Ctrl+C to stop)
python -m http.server %PORT%