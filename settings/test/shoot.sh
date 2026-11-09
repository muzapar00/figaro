#!/usr/bin/env bash
# Self-test evidence harness for the Figaro settings GUI.
#
# Drives the running GUI through its `figaro-settings` IpcHandler (page / act /
# shot / status), exercises every self-test, saves one screenshot per section
# into settings/test/out/ and asserts that the underlying state really moved.
#
# Requires: settings/test/dev.sh restart (fake daemon + GUI on a test socket).
# Usage:
#   settings/test/shoot.sh                  # screenshots into settings/test/out
#   settings/test/shoot.sh /tmp/figaro-out  # custom output dir
#   FIGARO_SETTINGS_IPC=config settings/test/shoot.sh   # deployed `qs -c figaro-settings`
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$(dirname "$here")")"
settings="$repo/settings"
runtime="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
out="${1:-$settings/test/out}"
export XDG_RUNTIME_DIR="$runtime"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export PATH="$HOME/.local/bin:$PATH"
QS="${QS:-$HOME/.local/bin/qs}"

mode="${FIGARO_SETTINGS_IPC:-path}"
if [[ "$mode" == "config" ]]; then
  sel=(-c figaro-settings)
else
  sel=(-p "$settings")
fi

ipc() { "$QS" "${sel[@]}" ipc call figaro-settings "$@" 2>/dev/null; }

fails=0
pass() { echo "  PASS  $*"; }
fail() { echo "  FAIL  $*"; fails=$((fails + 1)); }

wait_gui() {
  local attempt
  for attempt in $(seq 1 60); do
    if [[ -n "$(ipc status)" ]]; then return 0; fi
    sleep 0.25
  done
  echo "GUI did not answer 'figaro-settings status' — start it with settings/test/dev.sh restart" >&2
  exit 2
}

page() { ipc page "$1" >/dev/null; sleep 0.35; }
act() { ipc act "$1"; }
scroll() { ipc act "scroll-$1" >/dev/null; sleep 0.35; }

shot() { # shot <name>
  local name="$1" target="$out/$1.png" attempt
  rm -f "$target"
  ipc shot "$target" >/dev/null
  for attempt in $(seq 1 30); do
    [[ -s "$target" ]] && break
    sleep 0.1
  done
  if [[ ! -s "$target" ]]; then
    # The window can stop being exposed (occluded/minimized/other virtual
    # desktop); grabToImage() then never completes. Re-map it and retry once.
    echo "  note  $name: grab stalled, re-surfacing the window"
    ipc resurface >/dev/null
    sleep 0.9
    ipc shot "$target" >/dev/null
    for attempt in $(seq 1 40); do
      [[ -s "$target" ]] && break
      sleep 0.1
    done
  fi
  if [[ -s "$target" ]]; then
    echo "  shot  $target"
  else
    fail "screenshot $name was not written"
  fi
}

json_get() { # json_get <file> <python expr over d>
  python3 - "$1" "$2" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
expr = sys.argv[2]
print(eval(expr, {"d": d}))
PY
}

mkdir -p "$out"
# Only clear the screenshots this script regenerates; the real-daemon (8/16-19)
# and legacy-daemon (9) evidence comes from separate runs and must survive.
for name in 1-overview 2-wake-settings 2b-wake-test-running 2c-wake-test-result 2d-wake-test-stats             3-ambient-test-table 4-mic-settings 4b-mic-level-live 4c-mic-noise-floor             5-voice-tts 6-asr-streaming 6b-asr-result 7-diagnostics 7b-diagnostics-capabilities             10-interaction-bargein 11-interaction-followup 12-interaction-phrases             13-wake-sensitivity 14-wake-words 15-voice-timbre; do
  rm -f "$out/$name.png"
done
rm -f "$out"/status.json
wait_gui
echo "[shoot] GUI reachable ($mode mode), writing to $out"

# ---------------------------------------------------------------- 1. overview
page overview
scroll top
sleep 0.4
shot 1-overview

# ---------------------------------------------------------------- 2. wake
page wake
scroll top
sleep 0.4
shot 2-wake-settings

echo "[shoot] wake-word test (15 s window, ~8 s sample)"
act wake-start >/dev/null
sleep 8
shot 2b-wake-test-running
act wake-stop >/dev/null
sleep 0.8
shot 2c-wake-test-result
act scroll:190 >/dev/null
sleep 0.35
shot 2d-wake-test-stats

echo "[shoot] ambient-noise / false-wake test (~12 s sample)"
act ambient-start >/dev/null
sleep 12
act scroll:430 >/dev/null
sleep 0.35
shot 3-ambient-test-table
act ambient-csv >/dev/null
act ambient-stop >/dev/null
sleep 0.8

# ---------------------------------------------------------------- 3. mic
page mic
scroll top
sleep 0.4
shot 4-mic-settings

echo "[shoot] microphone live level test"
act mic-monitor >/dev/null
sleep 2.5
shot 4b-mic-level-live
act mic-stop >/dev/null
sleep 0.4

echo "[shoot] microphone noise-floor measurement (3 s silence)"
act mic-noise >/dev/null
sleep 5
act scroll:210 >/dev/null
sleep 0.35
shot 4c-mic-noise-floor

# ---------------------------------------------------------------- 4. voice
page voice
scroll top
sleep 0.4
act voice-preview >/dev/null
sleep 2.5
shot 5-voice-tts

# ---------------------------------------------------------------- 5. asr
page asr
scroll top
sleep 0.4
echo "[shoot] recognition test (streaming partials -> final)"
act asr-start >/dev/null
sleep 4.5
shot 6-asr-streaming
act scroll:170 >/dev/null
sleep 0.35
shot 6b-asr-result

# ---------------------------------------------------------------- 6. diagnostics
page diagnostics
scroll top
sleep 0.4
act diag-export >/dev/null
act diag-copy-log >/dev/null
sleep 1.2
shot 7-diagnostics
act scroll:330 >/dev/null
sleep 0.35
shot 7b-diagnostics-capabilities

# ------------------------------------- 7. new config controls (task-8)
echo "[shoot] new config controls: barge-in / follow-up / phrases / wake words / voice"
page interaction
scroll top
act interaction-demo >/dev/null
sleep 1.0
shot 10-interaction-bargein
act scroll:260 >/dev/null
sleep 0.45
shot 11-interaction-followup
act scroll:520 >/dev/null
sleep 0.45
shot 12-interaction-phrases

page wake
scroll top
act wake-demo >/dev/null
sleep 0.9
shot 13-wake-sensitivity
act scroll:300 >/dev/null
sleep 0.45
shot 14-wake-words

page voice
scroll top
act voice-demo >/dev/null
sleep 0.9
shot 15-voice-timbre

# ---------------------------------------------------------------- state dump
sleep 0.5
ipc status >"$out/status.json"
echo "[shoot] wrote $out/status.json"

echo
echo "[shoot] assertions"
[[ -n "$(cat "$out/status.json")" ]] && pass "status snapshot returned" || fail "no status snapshot"

assert_num() { # assert_num <label> <expr> <min>
  local value
  value="$(json_get "$out/status.json" "$2" 2>/dev/null || echo -1)"
  if python3 -c "import sys; sys.exit(0 if float('$value') >= float('$3') else 1)" 2>/dev/null; then
    pass "$1 = $value (>= $3)"
  else
    fail "$1 = $value (< $3)"
  fi
}

assert_num "wake score samples" "d['wake'].get('scoreSamples', 0)" 20
assert_num "wake last-test hits" "d['wake'].get('lastWakeHits', -1)" 1
assert_num "wake last-test max score" "d['wake'].get('lastWakeMaxScore', -1)" 0.6
assert_num "ambient event rows" "d['wake'].get('ambientRows', 0)" 1
assert_num "ambient csv path length" "len(d['wake'].get('ambientCsv', ''))" 10
assert_num "mic samples" "d['mic'].get('sampleCount', 0)" 20
assert_num "mic last rms" "d['mic'].get('lastRms') or 0" 0.01
assert_num "mic noise floor rms" "d['mic'].get('noiseRms') if d['mic'].get('noiseRms') is not None else -1" 0.01
assert_num "tts first-audio ms" "d['voice'].get('lastResult', {}).get('ms', -1)" 1
assert_num "asr partials" "d['asr'].get('partials', 0)" 5
assert_num "asr audio ms" "d['asr'].get('audioMs') or 0" 500
assert_num "asr accuracy" "d['asr'].get('accuracy') if d['asr'].get('accuracy') is not None else -1" 0.5
assert_num "diagnostics export path length" "len(d['diagnostics'].get('lastExportPath', ''))" 10
assert_num "journal log copied lines" "d['diagnostics'].get('logCopyLines', 0)" 1
assert_num "wake supported" "1 if d['wake'].get('wakeSupported') else 0" 1
assert_num "connected" "1 if d['connected'] else 0" 1
assert_num "test socket in use" "1 if d['testSocket'] else 0" 1

# --- task-8: new config controls landed in the daemon --------------------
echo
echo "[shoot] task-8 new config fields"
python3 - "$out/status.json" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
checks = []

def check(name, ok, detail=""):
    checks.append((name, ok, detail))

inter = d.get("interaction", {})
fs = d.get("fieldStatus", {})
diag = d.get("daemonDiagnostics", {}) or {}
d_asr = diag.get("asr", {}) or {}
d_inter = diag.get("interaction", {}) or {}
d_tts = diag.get("tts", {}) or {}

check("bargeIn.enabled written", inter.get("bargeEnabled") is True)
check("bargeIn.minRms = 0.06", abs(float(inter.get("bargeMinRms", -1)) - 0.06) < 1e-6, str(inter.get("bargeMinRms")))
check("bargeIn.echoFactor = 3.0", abs(float(inter.get("bargeEchoFactor", -1)) - 3.0) < 1e-6, str(inter.get("bargeEchoFactor")))
check("bargeIn.minMs = 600", int(inter.get("bargeMinMs", -1)) == 600, str(inter.get("bargeMinMs")))
check("followUpWindowMs = 7000", int(inter.get("followUpWindow", -1)) == 7000, str(inter.get("followUpWindow")))
check("dismissPhrases contains 告退", "告退" in (inter.get("dismissPhrases") or []), str(inter.get("dismissPhrases")))
check("wakeWordsEn non-empty", len(d.get("wake", {}).get("wakeWordsEn") or []) >= 1, str(d.get("wake", {}).get("wakeWordsEn")))
check("daemon readback bargeIn.minRms = 0.06", abs(float((d_asr.get("bargeIn") or {}).get("minRms", -1)) - 0.06) < 1e-6, str(d_asr.get("bargeIn")))
check("daemon readback dismissPhrases has 告退", "告退" in (d_inter.get("dismissPhrases") or []))
check("daemon readback followUpWindowMs = 7000", int(d_inter.get("followUpWindowMs", -1)) == 7000, str(d_inter.get("followUpWindowMs")))
check("daemon readback tts.voiceId = male-qn-qingse", d_tts.get("voiceId") == "male-qn-qingse", str(d_tts.get("voiceId")))

# hot-path vs restart-required classification the GUI shows to the user
check("asr.sensitivity marked applied (hot)", fs.get("asr.sensitivity", {}).get("state") == "applied", str(fs.get("asr.sensitivity")))
check("tts.voiceId marked applied (hot)", fs.get("tts.voiceId", {}).get("state") == "applied", str(fs.get("tts.voiceId")))
check("bargeIn hot-applied", fs.get("asr.bargeIn.minRms", {}).get("state") == "applied", str(fs.get("asr.bargeIn.minRms")))
check("interaction hot-applied", fs.get("interaction.followUpWindowMs", {}).get("state") == "applied", str(fs.get("interaction.followUpWindowMs")))
check("wakeWords marked restart-required", fs.get("asr.wakeWords", {}).get("state") == "restart", str(fs.get("asr.wakeWords")))

# and the daemon's config file on disk really contains the new values
config_path = diag.get("configPath") or ""
try:
    with open(config_path) as f:
        cfg = json.load(f)
    check("config.json asr.bargeIn.minRms = 0.06", abs(float(cfg["asr"]["bargeIn"]["minRms"]) - 0.06) < 1e-6)
    check("config.json asr.bargeIn.echoFactor = 3.0", abs(float(cfg["asr"]["bargeIn"]["echoFactor"]) - 3.0) < 1e-6)
    check("config.json interaction.followUpWindowMs = 7000", int(cfg["interaction"]["followUpWindowMs"]) == 7000)
    check("config.json dismissPhrases has 告退", "告退" in cfg["interaction"]["dismissPhrases"])
    check("config.json tts.voiceId = male-qn-qingse", cfg["tts"].get("voiceId") == "male-qn-qingse")
except Exception as e:
    check("config.json readable (" + config_path + ")", False, str(e))

failed = [c for c in checks if not c[1]]
for name, ok, detail in checks:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail and not ok else ""))
sys.exit(1 if failed else 0)
PYEOF
task8_fails=$?
if [[ "$task8_fails" -ne 0 ]]; then
  fail "task-8 config assertions ($task8_fails)"
else
  pass "task-8 config assertions (all new fields written + read back by the daemon)"
fi

# copy the exported artifacts next to the screenshots as evidence
latest_diag="$(ls -t "$HOME"/figaro-diagnostics-*.json 2>/dev/null | head -1)"
latest_csv="$(ls -t "$HOME"/figaro-ambient-*.csv 2>/dev/null | head -1)"
if [[ -n "$latest_diag" && -s "$latest_diag" ]]; then
  cp "$latest_diag" "$out/diagnostics-export.json"
  pass "diagnostics JSON exported: $latest_diag -> $out/diagnostics-export.json"
else
  fail "no ~/figaro-diagnostics-*.json was written"
fi
if [[ -n "$latest_csv" && -s "$latest_csv" ]]; then
  cp "$latest_csv" "$out/ambient-export.csv"
  pass "ambient CSV exported: $latest_csv -> $out/ambient-export.csv"
else
  fail "no ~/figaro-ambient-*.csv was written"
fi

echo
if [[ "$fails" -eq 0 ]]; then
  echo "[shoot] OK: all assertions passed; screenshots in $out"
else
  echo "[shoot] $fails assertion(s) FAILED"
fi
exit "$fails"
