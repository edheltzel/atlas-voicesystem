#!/bin/bash
set -euo pipefail
SERVICE_NAME="com.atlas.voicesystem"
PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
LOG_PATH="$HOME/Library/Logs/atlas-voicesystem.log"

if launchctl list 2>/dev/null | grep "$SERVICE_NAME" >/dev/null 2>&1; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

rm -f "$PLIST_PATH"
echo "OK removed LaunchAgent $SERVICE_NAME"

if lsof -i :8888 >/dev/null 2>&1; then
  echo "Port 8888 is still in use; not killing it because it may belong to another service."
fi

echo "Logs preserved at $LOG_PATH"
