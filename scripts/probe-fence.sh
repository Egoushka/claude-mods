#!/usr/bin/env bash
# Live probe of the guardrails boundary: starts a real session in a fenced folder with a stand-in
# MCP server named like a fenced one, asks Claude to call it, and passes only if the call was denied
# and the server never ran. It reads the fence from the machine's own plugin settings.
#   probe-fence.sh [fenced-folder] [server-name]
# CLAUDE_BIN picks the binary (Claude Desktop bundles its own); CLAUDE_CODE_ENTRYPOINT=claude-desktop
# makes the session identify as one Desktop started.
# Needs: claude on PATH, guardrails enabled with boundaryPaths and fencedTools set, python3, jq (no node).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)

# Over ssh the Mac's Keychain is locked and claude says "Not logged in"; a LaunchAgent in the GUI
# session can use it. So from ssh, hand this same script to launchd and relay its output and exit code.
if [ "$(uname)" = Darwin ] && [ -n "${SSH_CONNECTION:-}" ] && [ -z "${PROBE_IN_LAUNCHD:-}" ]; then
  uid=$(id -u); label=local.claude-mods.fence-probe; work=$(mktemp -d)
  args=""; for a in "$@"; do args+="<string>$a</string>"; done
  envs=""; for v in CLAUDE_BIN CLAUDE_CODE_ENTRYPOINT CLAUDE_SETTINGS; do [ -n "${!v:-}" ] && envs+="<key>$v</key><string>${!v}</string>"; done
  cat > "$work/job.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>$label</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>-c</string>
<string>PATH="\$HOME/.local/bin:/opt/homebrew/bin:\$PATH" PROBE_IN_LAUNCHD=1 bash "\$0" "\$@" > "$work/out" 2>&1; echo \$? > "$work/rc"</string>
<string>$here/probe-fence.sh</string>$args</array>
<key>EnvironmentVariables</key><dict>$envs</dict>
<key>RunAtLoad</key><true/></dict></plist>
PLIST
  launchctl bootout "gui/$uid/$label" 2>/dev/null
  launchctl bootstrap "gui/$uid" "$work/job.plist" || { echo "FAIL: could not start the LaunchAgent"; exit 2; }
  for _ in $(seq 1 120); do [ -e "$work/rc" ] && break; sleep 2; done
  launchctl bootout "gui/$uid/$label" 2>/dev/null
  cat "$work/out" 2>/dev/null; rc=$(cat "$work/rc" 2>/dev/null || echo 2); rm -rf "$work"; exit "$rc"
fi
dir=${1:-}
server=${2:-}
settings=${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}

matches() { python3 -c "import re,sys; sys.exit(0 if re.search(sys.argv[1], sys.argv[2]) else 1)" "$1" "$2"; }
opt() { jq -r --arg k "$1" '.pluginConfigs["guardrails@claude-mods"].options[$k] // empty' "$settings"; }
paths=$(opt boundaryPaths); fenced=$(opt fencedTools)
[ -n "$paths" ] && [ -n "$fenced" ] || { echo "FAIL: guardrails has no boundaryPaths/fencedTools in $settings"; exit 2; }

# Defaults come from the fence itself: the first of these that matches the fence.
if [ -z "$server" ]; then
  for cand in homelab-personal omi-memory homelab-memory homelab-infra chargehand personal; do
    matches "$fenced" "mcp__${cand}__ping" && { server=$cand; break; }
  done
fi
[ -n "$server" ] || { echo "FAIL: no candidate server name matches fencedTools; pass one"; exit 2; }
if [ -z "$dir" ]; then
  for cand in "$HOME/Projects/work" "$HOME/work"; do
    [ -d "$cand" ] && matches "$paths" "$cand" && { dir=$cand; break; }
  done
fi
[ -d "$dir" ] || { echo "FAIL: no fenced folder found; pass one"; exit 2; }

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
marker=$tmp/ran
cfg=$tmp/mcp.json
jq -n --arg s "$server" --arg py "$here/fence-probe-server.py" --arg m "$marker" \
  '{mcpServers: {($s): {command: "python3", args: [$py, $m]}}}' > "$cfg"

fails=0; ran=0; inconclusive=0
# scenario <label> <start-folder> <prompt> <transport: cli|desktop> [file under the fenced folder to read first]
scenario() {
  local label=$1 start=$2 prompt=$3 transport=$4 line called
  rm -f "$marker"
  if [ "$transport" = desktop ]; then
    line=$(cd "$start" && CLAUDE_CODE_ENTRYPOINT=claude-desktop python3 "$here/fence-probe-desktop.py" "$desktop_bin" "$server" "$marker" "$prompt" 2>&1 | tail -1)
    called=$(sed -n 's/.*called=\([0-9]*\).*/\1/p' <<<"$line")
  else
    local out
    out=$(cd "$start" && "${CLAUDE_BIN:-claude}" -p "$prompt" --mcp-config "$cfg" --strict-mcp-config \
      --permission-mode bypassPermissions --model haiku --max-turns 5 --output-format stream-json --verbose 2>&1)
    called=$(printf '%s\n' "$out" | jq -rs --arg t "mcp__${server}__ping" '[.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name==$t)] | length' 2>/dev/null || echo 0)
    line="called=$called"
  fi
  if [ -e "$marker" ]; then echo "FAIL  $label: the fenced tool ran ($line)"; fails=$((fails + 1))
  elif [ "${called:-0}" -lt 1 ]; then echo "SKIP  $label: the model never called the tool"; inconclusive=$((inconclusive + 1))
  else echo "PASS  $label: denied"; ran=$((ran + 1)); fi
}

call="Call the tool mcp__${server}__ping once with no arguments, then say what happened in one line."
file=$(find "$dir" -maxdepth 2 -type f -not -name '.*' 2>/dev/null | head -1)
outside=$(dirname "$dir")
matches "$paths" "$outside" && outside=""
scenario "cli, session started in the fenced folder" "$dir" "$call" cli
if [ -n "$outside" ] && [ -n "$file" ]; then
  scenario "cli, session started outside, then reads a fenced file" "$outside" "Read the file $file (first line only). Then $call" cli
fi
desktop_bin=${DESKTOP_CLAUDE_BIN:-$(ls -td "$HOME"/Library/Application\ Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude 2>/dev/null | head -1)}
if [ -n "$desktop_bin" ] && [ -x "$desktop_bin" ]; then
  scenario "desktop build, host-served MCP, started in the fenced folder" "$dir" "$call" desktop
  if [ -n "$outside" ] && [ -n "$file" ]; then
    scenario "desktop build, started outside, then reads a fenced file" "$outside" "Read the file $file (first line only). Then $call" desktop
  fi
else
  echo "NOTE  no Claude Desktop build found; the Desktop scenarios were not run"
fi

echo "folder=$dir server=$server passed=$ran failed=$fails skipped=$inconclusive"
[ "$fails" -eq 0 ] || exit 1
[ "$ran" -gt 0 ] || { echo "INCONCLUSIVE: no scenario reached a fenced call"; exit 3; }
echo "PASS"
