#!/bin/bash
# Read-only security check for the AI agent's Mac Mini. Changes nothing —
# it only reports; the owner flips any setting by hand in System Settings.
ok()  { echo "✓ $1"; }
bad() { echo "✗ $1 — $2"; }

fdesetup status 2>/dev/null | grep -q "On" && ok "FileVault disk encryption is on" || bad "FileVault is off" "System Settings → Privacy & Security → FileVault → Turn On"
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null | grep -qi "enabled" && ok "Firewall is on" || bad "Firewall is off" "System Settings → Network → Firewall → On"
[ "$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null)" = "" ] && ok "No automatic login without a password" || bad "Automatic login is on" "System Settings → Users & Groups → Automatically log in as → Off"
pgrep -qx sshd-session || ! launchctl print system/com.openssh.sshd >/dev/null 2>&1 && ok "Remote Login (SSH) looks off" || bad "Remote Login (SSH) may be on" "System Settings → General → Sharing → Remote Login → Off"
launchctl print system/com.apple.screensharing >/dev/null 2>&1 && bad "Screen Sharing may be on" "System Settings → General → Sharing → Screen Sharing → Off (unless you use it)" || ok "Screen Sharing is off"
d=$(sysadminctl -screenLock status 2>&1 | grep -o "immediate\|[0-9]* seconds" | head -1)
if [ "$d" = "immediate" ] || { [ -n "$d" ] && [ "${d%% *}" -le 60 ]; }; then ok "Password required right after the screen locks ($d)"
else bad "Password after screen lock: ${d:-off}" "System Settings → Lock Screen → Require password after screen saver begins or display is turned off → Immediately"; fi
softwareupdate -l 2>&1 | grep -q "No new software available" && ok "macOS is up to date" || echo "• macOS updates may be waiting — System Settings → General → Software Update"
[ -f "$HOME/.pmu-agent/.env" ] && [ "$(stat -f %Lp "$HOME/.pmu-agent/.env")" = "600" ] && ok "Worker key file is private" || echo "• Worker key file not found yet (run setup first) or not private"
echo
echo "Also: use this Mac only for the agent (no personal email or browsing), and keep its screen locked."
