# MIGRATIONS

Tracks edits to PAI core files that must be re-applied after upstream PAI updates.
These edits live OUTSIDE `~/Developer/atlas-voicesystem/` (the upstream-safe zone), so PAI releases may clobber them. After every PAI upgrade, run through this list and re-apply.

> **Tip**: `git diff` in `~/.claude/PAI/` after a PAI update reveals what was overwritten.

---

## 1. PULSE.toml — disable built-in voice module

**File**: `~/.claude/PAI/PULSE/PULSE.toml`

```toml
[voice]
enabled = false  # 2026-05-15: voice now handled by atlas-voicesystem on :8888
```

Required because Pulse's built-in voice module (ElevenLabs-only, fails on free-tier 402) would otherwise compete for the `/notify` route on :31337.

---

## 2. PAI internal callers — 31337 → 8888 (12 files, 15 occurrences)

All `localhost:31337/notify` and `127.0.0.1:31337/notify` references in PAI `.ts` files are rewritten to port 8888.

| File | Occurrences |
|------|-------------|
| `~/.claude/PAI/TOOLS/algorithm.ts` | 1 |
| `~/.claude/PAI/TOOLS/pai.ts` | 2 |
| `~/.claude/PAI/TOOLS/CostTracker.ts` | 1 |
| `~/.claude/PAI/TOOLS/IntegrityMaintenance.ts` | 2 |
| `~/.claude/PAI/TOOLS/ForgeProgress.ts` | 1 |
| `~/.claude/PAI/TOOLS/AnvilProgress.ts` | 1 |
| `~/.claude/PAI/PULSE/lib.ts` | 1 |
| `~/.claude/PAI/PULSE/modules/telegram.ts` | 1 (comment) |
| `~/.claude/PAI/PULSE/checks/notification-governor.ts` | 1 |
| `~/.claude/PAI/PAI-Install/cli/index.ts` | 1 |
| `~/.claude/PAI/PAI-Install/engine/validate.ts` | 1 |
| `~/.claude/PAI/PAI-Install/engine/actions.ts` | 2 |

**Re-apply** with:
```bash
FILES=(
  ~/.claude/PAI/TOOLS/algorithm.ts
  ~/.claude/PAI/TOOLS/pai.ts
  ~/.claude/PAI/TOOLS/CostTracker.ts
  ~/.claude/PAI/TOOLS/IntegrityMaintenance.ts
  ~/.claude/PAI/TOOLS/ForgeProgress.ts
  ~/.claude/PAI/TOOLS/AnvilProgress.ts
  ~/.claude/PAI/PULSE/lib.ts
  ~/.claude/PAI/PULSE/modules/telegram.ts
  ~/.claude/PAI/PULSE/checks/notification-governor.ts
  ~/.claude/PAI/PAI-Install/cli/index.ts
  ~/.claude/PAI/PAI-Install/engine/validate.ts
  ~/.claude/PAI/PAI-Install/engine/actions.ts
)
for f in "${FILES[@]}"; do
  sed -i '' 's|localhost:31337/notify|localhost:8888/notify|g; s|127\.0\.0\.1:31337/notify|127.0.0.1:8888/notify|g' "$f"
done
```

---

## 3. PAI core hooks — 31337 → 8888 (4 files)

PAI ships its own voice-related hooks at `~/.claude/hooks/`. Retargeted to 8888:

| File | Role |
|------|------|
| `~/.claude/hooks/PromptProcessing.hook.ts` | UserPromptSubmit mode classifier |
| `~/.claude/hooks/StopFailureHandler.hook.ts` | Stop-phase failure notification |
| `~/.claude/hooks/handlers/DocCrossRefIntegrity.ts` | Doc integrity voice cue |
| `~/.claude/hooks/handlers/VoiceNotification.ts` | Stop-phase 🗣️ speaker (PAI's own; left in place) |

**Re-apply** with:
```bash
for f in $(rg -l "31337/notify" ~/.claude/hooks/); do
  sed -i '' 's|localhost:31337/notify|localhost:8888/notify|g; s|127\.0\.0\.1:31337/notify|127.0.0.1:8888/notify|g' "$f"
done
```

---

## 4. settings.json — additive hook registrations + perms

Two additive hook registrations + one chmod. The hooks themselves live inside `~/Developer/atlas-voicesystem/...`, so only the registration entries are upstream-fragile.

**PreToolUse Bash** (additive — added alongside SecurityPipeline + ContextReduction):
```json
{ "type": "command",
  "command": "$HOME/Developer/atlas-voicesystem/claudecode/.claude/PAI/USER/Voice/hooks/VoiceGate.hook.ts" }
```

**SessionStart matcher="startup"** (new entry):
```json
{ "matcher": "startup",
  "hooks": [{ "type": "command",
              "command": "$HOME/Developer/atlas-voicesystem/claudecode/.claude/PAI/USER/Voice/hooks/VoiceGreeting.hook.ts" }] }
```

**Permissions**: `chmod 600 ~/.claude/settings.json` (was 0755 world-readable — RedTeam PT-7 finding).

**Re-apply** by running the Python block at the bottom of this doc.

---

## 5. LaunchAgent cleanup (one-time — already done)

Removed orphaned plists that referenced the missing `~/.claude/VoiceServer/server.ts` path:
- `~/Library/LaunchAgents/com.pai.voice-server.plist` (old, dangling)
- `~/Library/LaunchAgents/com.paivoice.server.plist` (older, dangling)

The new `com.pai.voice-server.plist` (created by our `install.sh`) references the canonical `~/Developer/atlas-voicesystem/...` path.

---

## 6. Markdown docs NOT edited (intentional — review on upgrade)

These reference `localhost:31337/notify` and were left untouched (safer than churning spec docs):

- `~/.claude/CLAUDE.md` (line 19, NATIVE mode example)
- `~/.claude/PAI/ALGORITHM/v*.md` (5 files, voice command template)
- `~/.claude/PAI/DOCUMENTATION/Notifications/NotificationSystem.md` (3 places)

When the Algorithm executes voice curls inline as the spec instructs, they hit :31337 — which no longer has a voice route. Result: silent failure for Algorithm phase voice announcements specifically.

**If you want Algorithm phase voice working**, either:
(a) Edit those markdown files too (add them to this MIGRATIONS list), or
(b) Tell future-Atlas to dynamically retarget Algorithm voice to :8888 at the time of execution.

---

## Re-apply script (combined)

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# 1. PULSE.toml
sed -i '' 's|^\(enabled = \)true\(  *#.*atlas-voicesystem.*\)\?$|enabled = false  # voice handled by atlas-voicesystem|' \
  ~/.claude/PAI/PULSE/PULSE.toml || true

# 2 + 3. find/replace 31337 → 8888
find ~/.claude/PAI ~/.claude/hooks -type f \( -name "*.ts" -o -name "*.sh" \) -print0 \
  | xargs -0 sed -i '' 's|localhost:31337/notify|localhost:8888/notify|g; s|127\.0\.0\.1:31337/notify|127.0.0.1:8888/notify|g'

# 4. settings.json hook registrations + chmod
python3 ~/Developer/atlas-voicesystem/scripts/restore-hooks.py
chmod 600 ~/.claude/settings.json

# 5. Bounce Pulse so PULSE.toml takes effect
launchctl kickstart -k gui/$UID/com.pai.pulse

# 6. Verify
curl -fsS http://localhost:8888/health > /dev/null && echo "✓ VoiceServer healthy"
```

(A `restore-hooks.py` script can be added to `scripts/` if you want the settings.json re-application fully automated.)
