#!/bin/sh
# Local server execution script
# Usage: ./serve.sh [PORT]
PORT="${1:-8080}"
echo "Digital Twin Simulation running at http://localhost:$PORT (Press Ctrl+C to stop)"
exec python3 -m http.server "$PORT"