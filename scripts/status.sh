#!/bin/bash
set -euo pipefail
SERVICE_NAME="com.atlas.voicesystem"
LEGACY_SERVICE_NAME="com.pai.voice-server"
LOG_PATH="$HOME/Library/Logs/atlas-voicesystem.log"

echo "Service: $SERVICE_NAME"
if launchctl list 2>/dev/null | grep "$SERVICE_NAME" >/dev/null 2>&1; then
  launchctl list | grep "$SERVICE_NAME"
else
  echo "not loaded"
fi

if launchctl list 2>/dev/null | grep "$LEGACY_SERVICE_NAME" >/dev/null 2>&1; then
  echo "Legacy service still loaded: $LEGACY_SERVICE_NAME"
fi

echo
if curl --connect-timeout 2 --max-time 5 -fsS http://localhost:8888/health >/dev/null 2>&1; then
  echo "Health: OK"
  curl --connect-timeout 2 --max-time 5 -fsS http://localhost:8888/health
  echo
else
  echo "Health: FAIL"
fi

echo "Logs: $LOG_PATH"
[ -f "$LOG_PATH" ] && tail -5 "$LOG_PATH" || true
