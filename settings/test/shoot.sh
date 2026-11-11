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

wait_status() { # wait_status <python expr over d> [timeout_s]
  local expr="$1" timeout="${2:-20}" i
  for ((i = 0; i < timeout * 2; i++)); do
    if ipc status 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);sys.exit(0 if ($expr) else 1)" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  return 1
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

# ------------------------------------- 8. task-12: appearance / api / model / sfx / wizard
echo "[shoot] task-12: appearance, API keys, ASR model path, sound effects, guided wizard"

page appearance
scroll top
sleep 0.4
shot 20-appearance
act appearance-demo >/dev/null
sleep 1.0
shot 21-appearance-demo
act scroll:600 >/dev/null
sleep 0.45
shot 22-appearance-buttons

page api
scroll top
sleep 0.4
act api-demo >/dev/null
sleep 1.0
shot 23-api

page asr
act scroll-bottom >/dev/null
sleep 0.5
# harmless fake path, reset to default after the screenshot/assertions
ipc writeB64 asr.modelDir "$(printf '%s' '"/tmp/figaro-settings-test-models"' | base64 -w0)" >/dev/null 2>&1
sleep 0.8
shot 24-asr-model

page voice
act scroll:520 >/dev/null
sleep 0.5
act sfx-demo >/dev/null
sleep 0.9
shot 25-sfx

page wizard
act wizard-start >/dev/null
sleep 0.6
act wizard-run >/dev/null
wait_status "d['wizard']['results'][0] in ('pass','fail')" 10 || true
sleep 0.4
shot 26-wizard-step1
act wizard-next >/dev/null
act wizard-run >/dev/null
wait_status "d['wizard']['results'][1] in ('pass','fail')" 10 || true
sleep 0.4
shot 27-wizard-step2
act wizard-next >/dev/null
act wizard-run >/dev/null
wait_status "d['wizard']['results'][2] in ('pass','fail')" 18 || true
sleep 0.4
shot 28-wizard-step3
act wizard-next >/dev/null
act wizard-run >/dev/null
wait_status "d['wizard']['results'][3] in ('pass','fail')" 12 || true
sleep 0.4
shot 29-wizard-step4
act wizard-next >/dev/null
act wizard-run >/dev/null
wait_status "d['wizard']['results'][4] in ('pass','fail')" 10 || true
sleep 0.4
shot 30-wizard-step5
act wizard-finish >/dev/null
sleep 0.6
shot 31-wizard-summary

# --------------------------------- voiceprint card + Home Assistant (task home/voiceprint)
echo "[shoot] voiceprint card + Home Assistant card"

page wake
ipc act "scroll:300" >/dev/null
sleep 0.5
shot 38-wake-speaker
act wake-speaker-demo >/dev/null
sleep 1.1
shot 39-wake-speaker-on

act wake-enroll-dialog >/dev/null
sleep 0.7
shot 40-wake-enroll-dialog
act enroll-copy >/dev/null
sleep 0.5
if [[ "$(wl-paste -n 2>/dev/null)" == "figaro enroll-voice" ]]; then
  pass "enroll dialog copies 'figaro enroll-voice' to the clipboard"
else
  fail "enroll dialog clipboard content was '$(wl-paste -n 2>/dev/null)'"
fi
act dialog-close >/dev/null
sleep 0.3

page api
ipc act "scroll-bottom" >/dev/null
sleep 0.5
act api-home-demo >/dev/null
sleep 0.3
act api-home-save >/dev/null
sleep 1.0
shot 41-api-home
act api-home-test >/dev/null
sleep 1.0
shot 42-api-home-test-ok
act api-home-test-bad >/dev/null
sleep 1.0
shot 43-api-home-test-401
# leave a successful result in status.json for the assertions
act api-home-test >/dev/null
sleep 1.0

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

# The latest wake window is the wizard's short hit test (it disarms on the first
# deterministic hit at ~1.5 s), so 3 live score frames already prove streaming.
assert_num "wake score samples" "d['wake'].get('scoreSamples', 0)" 3
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

# --- task-12: appearance / API / model / sfx / wizard --------------------
echo
echo "[shoot] task-12 fields and guided wizard"
python3 - "$out/status.json" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    raw = f.read()
d = json.loads(raw)
checks = []

def check(name, ok, detail=""):
    checks.append((name, ok, detail))

app = d.get("appearance", {})
ui = d.get("ui", {}) or {}
fs = d.get("fieldStatus", {})
diag = d.get("daemonDiagnostics", {}) or {}
wiz = d.get("wizard", {}) or {}
api = d.get("api", {}) or {}
voice = d.get("voice", {}) or {}

check("appearance.scale = 1.25", abs(float(app.get("scale", -1)) - 1.25) < 1e-6, str(app.get("scale")))
check("appearance.shape = ball", app.get("shape") == "ball", str(app.get("shape")))
check("appearance.windowButtonSize = 20", int(app.get("windowButtonSize", -1)) == 20, str(app.get("windowButtonSize")))
check("daemon ui frame received (scale 1.25)", abs(float((ui or {}).get("scale", -1)) - 1.25) < 1e-6, str(ui))
check("daemon ui frame shape ball", (ui or {}).get("shape") == "ball", str(ui))
check("ui.* hot-applied status", all((fs.get(k, {}).get("state") == "applied") for k in
      ["ui.scale", "ui.shape", "ui.motion", "ui.windowButtonSize"]), str(fs))
check("sfx.enabled hot-applied", fs.get("sfx.enabled", {}).get("state") == "applied", str(fs.get("sfx.enabled")))
check("sfx.volume hot-applied", fs.get("sfx.volume", {}).get("state") == "applied", str(fs.get("sfx.volume")))
check("daemon sfx readback volume=0.5", abs(float((diag.get("sfx") or {}).get("volume", -1)) - 0.5) < 1e-6, str(diag.get("sfx")))
check("deepseek key marked restart-required", fs.get("deepseek.apiKey", {}).get("state") == "restart", str(fs.get("deepseek.apiKey")))
check("minimax key marked restart-required", fs.get("minimax.apiKey", {}).get("state") == "restart", str(fs.get("minimax.apiKey")))
check("api page sees keys stored (masked)", api.get("deepseekStored") is True and api.get("minimaxStored") is True, str(api))
check("secret values never leak into status.json", "placeholder" not in raw and "sk-test" not in raw)
check("asr.modelDir marked restart-required", fs.get("asr.modelDir", {}).get("state") == "restart", str(fs.get("asr.modelDir")))
check("wizard finished (step 5)", int(wiz.get("step", -1)) == 5, str(wiz.get("step")))
check("wizard all passed", wiz.get("allPassed") is True, str(wiz.get("results")))
check("wizard 5/5 pass", (wiz.get("results") or []).count("pass") == 5, str(wiz.get("results")))

# config.json really contains the written values
config_path = diag.get("configPath") or ""
try:
    with open(config_path) as f:
        cfg = json.load(f)
    check("config.json ui.scale = 1.25", abs(float(cfg["ui"]["scale"]) - 1.25) < 1e-6, str(cfg["ui"]))
    check("config.json ui.windowButtonSize = 20", int(cfg["ui"]["windowButtonSize"]) == 20, str(cfg["ui"]))
    check("config.json ui.shape = ball", cfg["ui"].get("shape") == "ball", str(cfg["ui"]))
    check("config.json sfx.volume = 0.5", abs(float(cfg["sfx"]["volume"]) - 0.5) < 1e-6, str(cfg.get("sfx")))
    check("config.json sfx.enabled = true", bool(cfg["sfx"]["enabled"]) is True, str(cfg.get("sfx")))
    check("config.json asr.modelDir written", cfg.get("asr", {}).get("modelDir") == "/tmp/figaro-settings-test-models", str(cfg.get("asr", {}).get("modelDir")))
    check("config.json deepseek key stored (masked in get, present in file)", isinstance(cfg.get("deepseek", {}).get("apiKey"), str) and len(cfg["deepseek"]["apiKey"]) > 0)
except Exception as e:
    check("config.json readable (" + config_path + ")", False, str(e))

failed = [c for c in checks if not c[1]]
for name, ok, detail in checks:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail and not ok else ""))
sys.exit(1 if failed else 0)
PYEOF
task12_fails=$?
if [[ "$task12_fails" -ne 0 ]]; then
  fail "task-12 config assertions ($task12_fails)"
else
  pass "task-12 config assertions (appearance/API/model/sfx/wizard all verified)"
fi

# the wizard summary is the log/status evidence for a completed walk-through
python3 - "$out/status.json" <<'PYEOF' > "$out/wizard-result.log"
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
w = d.get("wizard", {})
print(json.dumps(w, ensure_ascii=False, indent=2))
PYEOF
[[ -s "$out/wizard-result.log" ]] && pass "wizard result evidence -> $out/wizard-result.log"

# --- voiceprint gate + Home Assistant -----------------------------
echo
echo "[shoot] voiceprint / Home Assistant fields"
python3 - "$out/status.json" <<'PYEOF'
import json, sys, os
with open(sys.argv[1]) as f:
    raw = f.read()
d = json.loads(raw)
checks = []

def check(name, ok, detail=""):
    checks.append((name, ok, detail))

fs = d.get("fieldStatus", {})
diag = d.get("daemonDiagnostics", {}) or {}
d_asr = diag.get("asr", {}) or {}
speaker = d_asr.get("speaker") or {}
wake = d.get("wake", {}) or {}
api = d.get("api", {}) or {}
home_test = api.get("homeTest") or {}

check("asr.speaker.enabled written (restart-required)", fs.get("asr.speaker.enabled", {}).get("state") == "restart", str(fs.get("asr.speaker.enabled")))
check("asr.speaker.threshold written (restart-required)", fs.get("asr.speaker.threshold", {}).get("state") == "restart", str(fs.get("asr.speaker.threshold")))
check("diagnostics passes asr.speaker through", bool(speaker), str(speaker))
check("speaker state = ready after enabling", speaker.get("state") == "ready", str(speaker.get("state")))
check("speaker enrolled", speaker.get("enrolled") is True, str(speaker.get("enrolled")))
check("speaker threshold readback 0.72", abs(float(speaker.get("threshold", -1)) - 0.72) < 1e-6, str(speaker.get("threshold")))
check("speaker checked/rejected counters", int(speaker.get("checked", 0)) == 17 and int(speaker.get("rejected", 0)) == 3, str(speaker))
check("speaker lastScore 0.82", abs(float(speaker.get("lastScore", -1)) - 0.82) < 1e-6, str(speaker.get("lastScore")))
check("wake page speaker snapshot ready", wake.get("speakerState") == "ready" and wake.get("speakerLabel") == "就绪", str(wake.get("speakerState")))
check("wake page speaker threshold 0.72", abs(float(wake.get("speakerThreshold", -1)) - 0.72) < 1e-6, str(wake.get("speakerThreshold")))

check("home.haUrl written (restart-required)", fs.get("home.haUrl", {}).get("state") == "restart", str(fs.get("home.haUrl")))
check("home.haToken written (restart-required)", fs.get("home.haToken", {}).get("state") == "restart", str(fs.get("home.haToken")))
check("home.defaultRoom written (restart-required)", fs.get("home.defaultRoom", {}).get("state") == "restart", str(fs.get("home.defaultRoom")))
check("api page kept URL/room drafts", api.get("haUrl") == "http://homeassistant.local:8123" and api.get("haRoom") == "客厅", str(api.get("haUrl")))
check("api page sees the token as stored (masked)", api.get("haTokenStored") is True, str(api.get("haTokenStored")))
check("api page token draft was cleared after save", api.get("haTokenDraftEmpty") is True, str(api.get("haTokenDraftEmpty")))
check("api page shows the restart hint", "重启费加罗后生效" in (api.get("haHint") or ""), str(api.get("haHint")))
check("home.test reported connected", home_test.get("ok") is True, str(home_test))
check("home.test message", "已连接 Home Assistant" in (home_test.get("message") or ""), str(home_test))

# token privacy: the secret must never appear in the GUI status snapshot
check("home token never leaks into status.json", "ha-test-token" not in raw and "bad-token" not in raw)
# ...nor may the fake-daemon config masking be bypassed through config.get
tok = ((d.get("daemonDiagnostics") or {}).get("home") or {}).get("haToken")
check("diagnostics never includes the raw HA token", tok is None, str(tok))

config_path = diag.get("configPath") or ""
try:
    with open(config_path) as f:
        cfg = json.load(f)
    check("config.json asr.speaker.enabled = true", cfg["asr"]["speaker"]["enabled"] is True, str(cfg.get("asr", {}).get("speaker")))
    check("config.json asr.speaker.threshold = 0.72", abs(float(cfg["asr"]["speaker"]["threshold"]) - 0.72) < 1e-6)
    check("config.json home.haUrl written", cfg["home"]["haUrl"] == "http://homeassistant.local:8123", str(cfg.get("home")))
    check("config.json home.haToken stored", cfg["home"]["haToken"] == "ha-test-token")
    check("config.json home.defaultRoom written", cfg["home"]["defaultRoom"] == "客厅")
except Exception as e:
    check("config.json readable (" + config_path + ")", False, str(e))

# screenshots that must exist (both HA test outcomes + the enroll dialog)
for name in ["38-wake-speaker.png", "39-wake-speaker-on.png", "40-wake-enroll-dialog.png",
             "41-api-home.png", "42-api-home-test-ok.png", "43-api-home-test-401.png"]:
    path = os.path.join(os.path.dirname(sys.argv[1]), name)
    check("screenshot " + name, os.path.isfile(path) and os.path.getsize(path) > 10000, path)

failed = [c for c in checks if not c[1]]
for name, ok, detail in checks:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail and not ok else ""))
sys.exit(1 if failed else 0)
PYEOF
task13_fails=$?
if [[ "$task13_fails" -ne 0 ]]; then
  fail "voiceprint/Home Assistant assertions ($task13_fails)"
else
  pass "voiceprint/Home Assistant assertions (speaker card + HA card + both test outcomes)"
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
