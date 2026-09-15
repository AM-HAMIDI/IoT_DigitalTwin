#!/bin/sh
# اجرای پروژه روی سرور محلی
# استفاده:  ./serve.sh  [پورت]
PORT="${1:-8080}"
echo "پروژه روی http://localhost:$PORT در حال اجراست  (برای توقف: Ctrl+C)"
exec python3 -m http.server "$PORT"
