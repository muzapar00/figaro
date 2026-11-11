pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io

// Figaro IPC bridge for the settings GUI.
//
// Speaks the NDJSON unix-socket protocol from docs/ipc.md: §3 base messages
// (state / level / partial / reply / error) plus the §3.1 settings & self-test
// extension (config.get|set, test.mic.*, test.asr.*, test.wake.*, test.tts,
// service.restart, diagnostics).
//
// The daemon may be an older build that silently ignores §3.1 messages. Every
// request therefore carries a deadline; when it expires the feature is marked
// "unsupported" and the UI shows “当前 daemon 不支持此功能” instead of hanging.
Singleton {
    id: root

    // ---------------------------------------------------------------- address
    // FIGARO_SOCKET lets the dev harness point the GUI at settings/test/fake-daemon.mjs.
    readonly property string socketPath: Quickshell.env("FIGARO_SOCKET")
        || ((Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/figaro/sock")
    readonly property string runtimeDir: Quickshell.env("XDG_RUNTIME_DIR") || "/tmp"
    // Fallback only; $HOME is always set in a graphical session. Never a real user name.
    readonly property string homeDir: Quickshell.env("HOME") || "/tmp"
    readonly property string configPath: homeDir + "/.config/figaro/config.json"
    readonly property bool usingTestSocket: socketPath.indexOf("figaro-settings-test") >= 0
        || socketPath.indexOf("/tmp/") === 0

    // ------------------------------------------------------------- connection
    property bool connected: false
    property string daemonState: "idle"   // idle | listening | thinking | speaking
    property real daemonLevel: 0
    property string daemonPartial: ""
    property string daemonReply: ""
    property string daemonTool: ""
    property int connectGeneration: 0

    // --------------------------------------------------------------- protocol
    property int nextId: 1
    property var pending: ({})        // id -> {type, deadline, onReply, onTimeout}
    property var capabilities: ({})   // message type -> "unknown" | "supported" | "unsupported"
    property string lastError: ""
    property var recentErrors: []     // [{t, message}]
    property int requestCount: 0
    property int responseCount: 0

    // ----------------------------------------------------------------- config
    property var config: ({})
    property bool configLoaded: false
    property bool configDirty: false
    property var configErrors: []      // last config.set errors (whitelist rejections etc.)
    // Authoritative overlay prefs pushed by the daemon ({type:"ui", scale, shape,
    // motion, windowButtonSize}) so the settings window can live-update too.
    property var uiSnapshot: ({})
    property var configApplied: []     // last config.set applied paths
    property var configRestartRequired: []
    // Per-config-path write state, so every control can show 已生效/需重启/未开放.
    // path -> {state: "pending"|"applied"|"restart"|"forbidden"|"error", at, message}
    property var fieldStatus: ({})

    // ------------------------------------------------------------ diagnostics
    property var diagnostics: ({})
    property bool diagnosticsLoaded: false
    property var diagnosticsExportedPath: ""

    // ------------------------------------------------------- microphone stream
    property bool micRunning: false
    property var mic: ({})            // {rms, peak, level, t}
    property var micSamples: []       // numbers (rms), capped
    property int micSampleCount: 0
    property int micEndSeq: 0
    property bool micClipped: false

    // ------------------------------------------------------------- wake stream
    property bool wakeArmed: false
    property var wakeScores: []       // numbers, capped
    property real wakeScore: 0
    property string wakeKeyword: "费加罗"
    property var wakeHits: []         // [{t, score, latencyMs, falseAlarm}]
    property int wakeHitSeq: 0
    property var wakeEnd: ({})        // last {type:"test.wake.end"}
    property bool wakeNoiseMode: false
    property double wakeArmedAt: 0
    property int wakeArmedMs: 0

    // -------------------------------------------------------------- asr stream
    property bool asrRunning: false
    property var asrPartials: []      // [{t, text}]
    property int asrPartialSeq: 0
    property var asrResult: ({})      // last {type:"test.asr.result"}
    property double asrStartedAt: 0

    // -------------------------------------------------------------- tts stream
    property bool ttsRunning: false
    property var ttsResult: ({})      // last {type:"test.tts.result"}
    property string ttsLastText: ""

    // ------------------------------------------------------- home assistant
    property bool homeTestRunning: false
    property var homeTestResult: ({})   // last {type:"home.test", ok, status, message}
    property int homeTestSeq: 0

    // ---------------------------------------------------------- generic llm
    property bool llmTestRunning: false
    property var llmTestResult: ({})   // last {type:"llm.test", ...}
    property int llmTestSeq: 0

    // ---------------------------------------------------------- service restart
    property bool restartPending: false
    property string restartState: ""  // "" | sent | accepted | unsupported | restarting | done

    // ----------------------------------------------------------------- socket
    Socket {
        id: sock
        path: root.socketPath
        parser: SplitParser {
            onRead: line => root.onLine(line)
        }
        onConnectionStateChanged: root.onSocketStateChanged()
    }

    // Retry a dead socket: Quickshell only reconnects after a *disconnect*, not
    // after a failed first connect, and the user daemon may start after the GUI.
    Timer {
        interval: 1200
        running: true
        repeat: true
        onTriggered: {
            if (!root.connected) {
                sock.connected = false;
                sock.connected = true;
            }
        }
    }

    // Request deadlines (kept in one timer instead of one Timer per request).
    Timer {
        interval: 120
        running: root.connected
        repeat: true
        onTriggered: root.tickDeadlines()
    }

    // Diagnostics/poll: cheap, and detects a restarted or upgraded daemon.
    property int diagTick: 0
    Timer {
        interval: 4000
        running: root.connected
        repeat: true
        onTriggered: {
            root.diagTick += 1;
            const unsupported = root.feature("diagnostics") === "unsupported";
            if (!unsupported || root.diagTick % 4 === 0) root.refreshDiagnostics();
            if (root.diagTick % 8 === 0) root.refreshConfig(true);
        }
    }

    // ------------------------------------------------------------ lifecycle
    Component.onCompleted: {
        sock.connected = true;
        console.info("[figaro-settings] ipc target: " + root.socketPath
            + (root.usingTestSocket ? " (test socket)" : " (production socket)"));
    }

    function onSocketStateChanged() {
        root.connected = sock.connected;
        if (root.connected) {
            root.connectGeneration += 1;
            root.capabilities = ({});
            root.pending = ({});
            root.requestCount = 0;
            root.responseCount = 0;
            root.sendRaw({ type: "subscribe" });
            root.refreshConfig(true);
            root.refreshDiagnostics();
            if (root.restartPending) {
                root.restartPending = false;
                root.restartState = "done";
            }
            console.info("[figaro-settings] connected to " + root.socketPath);
        } else {
            root.daemonState = "idle";
            root.daemonLevel = 0;
            root.daemonPartial = "";
            root.micRunning = false;
            root.wakeArmed = false;
            root.asrRunning = false;
            root.ttsRunning = false;
            root.pending = ({});
            if (root.restartState === "sent" || root.restartState === "accepted")
                root.restartState = "restarting";
        }
    }

    // ------------------------------------------------------------- low level
    function sendRaw(obj) {
        if (!sock.connected) return false;
        try {
            sock.write(JSON.stringify(obj) + "\n");
            sock.flush();
            root.requestCount += 1;
            return true;
        } catch (e) {
            root.noteError(I18n.t("发送失败: ") + e);
            return false;
        }
    }

    // Send a message and wait for a reply sharing its id.
    // opts: { timeoutMs, onReply(msg), onTimeout() }
    function call(type, params, opts) {
        opts = opts || {};
        const id = root.nextId;
        root.nextId = id + 1;
        const msg = { type: type, id: id };
        if (params) {
            for (const k in params) msg[k] = params[k];
        }
        const entry = {
            type: type,
            deadline: Date.now() + (opts.timeoutMs || 1800),
            firstDeadline: opts.firstFrameTimeoutMs ? Date.now() + opts.firstFrameTimeoutMs : 0,
            onReply: opts.onReply || null,
            onTimeout: opts.onTimeout || null,
            onError: opts.onError || null,
        };
        root.pending[id] = entry;
        if (!root.sendRaw(msg)) {
            delete root.pending[id];
            if (entry.onTimeout) entry.onTimeout();
        }
        return id;
    }

    function resolvePending(id, msg, markSupported) {
        const entry = root.pending[id];
        if (!entry) return false;
        delete root.pending[id];
        root.responseCount += 1;
        if (markSupported !== false) root.markCapability(entry.type, "supported");
        if (entry.onReply) entry.onReply(msg);
        return true;
    }

    function tickDeadlines() {
        const now = Date.now();
        const due = [];
        for (const key in root.pending) {
            const entry = root.pending[key];
            if (!entry) continue;
            // Streaming tests: "no first frame" means the daemon does not know
            // the message at all, so report it as unsupported quickly instead
            // of waiting for the whole test window to elapse.
            if (entry.firstDeadline && now >= entry.firstDeadline) due.push(key);
            else if (now >= entry.deadline) due.push(key);
        }
        for (let i = 0; i < due.length; i++) {
            const entry = root.pending[due[i]];
            delete root.pending[due[i]];
            if (!entry) continue;
            root.markCapability(entry.type, "unsupported");
            if (entry.onTimeout) entry.onTimeout();
        }
    }

    // --------------------------------------------------------- capabilities
    function feature(type) {
        return root.capabilities[type] || "unknown";
    }
    function supported(type) {
        return root.feature(type) === "supported";
    }
    function unsupported(type) {
        return root.feature(type) === "unsupported";
    }
    function markCapability(type, state) {
        if (!type) return;
        if (root.capabilities[type] === state) return;
        const next = {};
        for (const k in root.capabilities) next[k] = root.capabilities[k];
        next[type] = state;
        root.capabilities = next;
    }
    function featureLabel(type) {
        if (root.feature(type) === "supported") return I18n.t("已支持");
        if (root.feature(type) === "unsupported") return I18n.t("当前 daemon 不支持此功能");
        return I18n.t("等待响应…");
    }
    function noteError(message) {
        root.lastError = message;
        const next = [{ t: Date.now(), message: message }];
        const prev = root.recentErrors || [];
        for (let i = 0; i < prev.length && i < 40; i++) next.push(prev[i]);
        root.recentErrors = next;
    }

    // ------------------------------------------------------------- incoming
    function onLine(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch (e) {
            return;
        }
        if (!msg || typeof msg.type !== "string") return;

        switch (msg.type) {
        case "state":
            root.daemonState = msg.state || "idle";
            if (root.daemonState !== "listening") root.daemonLevel = 0;
            break;
        case "level":
            root.daemonLevel = Math.max(0, Math.min(1, Number(msg.value) || 0));
            break;
        case "partial":
            if (root.asrRunning) {
                root.asrPartialSeq += 1;
                const parts = root.asrPartials.slice(0);
                parts.push({ t: Date.now(), text: msg.text || "" });
                if (parts.length > 60) parts.splice(0, parts.length - 60);
                root.asrPartials = parts;
                // A partial only proves the daemon took the request: do not
                // resolve the pending test. Give the eventual result more time.
                if (msg.id) {
                    const entry = root.pending[msg.id];
                    if (entry) entry.firstDeadline = 0;
                }
                root.markCapability("test.asr.start", "supported");
            } else {
                root.daemonPartial = msg.text || "";
            }
            break;
        case "reply":
            root.daemonReply = msg.text || "";
            root.daemonPartial = "";
            root.daemonTool = "";
            break;
        case "tool":
            root.daemonTool = msg.status === "start" ? (msg.summary || msg.name || "") : "";
            break;
        case "pong":
            break;
        case "ack":
            if (msg.id) root.resolvePending(msg.id, msg);
            break;
        case "error": {
            root.noteError(msg.message || "daemon error");
            const entry = msg.id !== undefined ? root.pending[msg.id] : null;
            if (entry) {
                delete root.pending[msg.id];
                root.responseCount += 1;
                const unsupported = msg.code === "unsupported"
                    || /unsupported|unknown|not implemented|不支持/i.test(msg.message || "");
                if (unsupported) root.markCapability(entry.type, "unsupported");
                if (entry.onError) entry.onError(msg);
                else if (entry.onTimeout) entry.onTimeout();
            }
            break;
        }

        // ---- §3.1 ----------------------------------------------------------
        case "ui":
            root.uiSnapshot = ({
                scale: msg.scale,
                shape: msg.shape,
                motion: msg.motion,
                windowButtonSize: msg.windowButtonSize,
            });
            break;
        case "config":
            if (msg.config) root.config = msg.config;
            root.configLoaded = true;
            if (Array.isArray(msg.errors)) root.configErrors = msg.errors;
            else if (msg.ok !== false) root.configErrors = [];
            if (Array.isArray(msg.applied)) root.configApplied = msg.applied;
            if (Array.isArray(msg.restartRequired)) root.configRestartRequired = msg.restartRequired;
            root.markCapability("config.get", "supported");
            root.markCapability("config.set", "supported");
            if (msg.forbidden && msg.forbidden.length) root.configErrors = msg.forbidden.map(f => I18n.t("不允许修改：") + f);
            if (msg.id) root.resolvePending(msg.id, msg);
            break;
        case "diagnostics":
            root.diagnostics = msg;
            root.diagnosticsLoaded = true;
            root.markCapability("diagnostics", "supported");
            root.markCapability("config.get", "supported");
            if (Array.isArray(msg.recentErrors)) {
                const merged = [];
                for (let i = 0; i < msg.recentErrors.length && i < 20; i++) {
                    const e = msg.recentErrors[i] || {};
                    merged.push({
                        t: typeof e.t === "number" ? e.t : (e.at ? Date.parse(e.at) : Date.now()),
                        message: e.message || String(e),
                    });
                }
                const live = root.recentErrors || [];
                for (let i = 0; i < live.length && i < 20; i++) {
                    let dup = false;
                    for (let j = 0; j < merged.length; j++) {
                        if (Math.abs((merged[j].t || 0) - (live[i].t || 0)) < 1500
                            && merged[j].message === live[i].message) { dup = true; break; }
                    }
                    if (!dup) merged.push(live[i]);
                }
                merged.sort((a, b) => (b.t || 0) - (a.t || 0));
                root.recentErrors = merged;
            }
            if (msg.id) root.resolvePending(msg.id, msg);
            break;
        case "mic": {
            root.micRunning = true;
            const s = { rms: Number(msg.rms) || 0, peak: Number(msg.peak) || 0, level: Number(msg.level) || 0, t: Number(msg.t) || 0 };
            root.mic = s;
            root.micSampleCount += 1;
            const samples = root.micSamples.slice(0);
            samples.push(s.rms);
            if (samples.length > 800) samples.splice(0, samples.length - 800);
            root.micSamples = samples;
            if (s.peak >= 0.985) root.micClipped = true;
            if (msg.id) root.resolvePending(msg.id, msg);
            root.markCapability("test.mic.start", "supported");
            break;
        }
        case "mic.end":
            root.micRunning = false;
            root.micEndSeq += 1;
            if (msg.id) root.resolvePending(msg.id, msg);
            root.markCapability("test.mic.start", "supported");
            break;
        case "wake.score": {
            root.wakeArmed = true;
            root.wakeScore = Number(msg.score) || 0;
            if (msg.keyword) root.wakeKeyword = msg.keyword;
            const scores = root.wakeScores.slice(0);
            scores.push(root.wakeScore);
            if (scores.length > 220) scores.splice(0, scores.length - 220);
            root.wakeScores = scores;
            if (msg.id) root.resolvePending(msg.id, msg);
            root.markCapability("test.wake.arm", "supported");
            break;
        }
        case "wake.hit": {
            const hit = {
                t: Number(msg.t) >= 0 ? Number(msg.t) : (Date.now() - root.wakeArmedAt),
                score: Number(msg.score) || 0,
                latencyMs: Number(msg.latencyMs) || 0,
                falseAlarm: !!msg.falseAlarm,
            };
            const hits = root.wakeHits.slice(0);
            hits.push(hit);
            if (hits.length > 300) hits.splice(0, hits.length - 300);
            root.wakeHits = hits;
            root.wakeHitSeq += 1;
            root.markCapability("test.wake.arm", "supported");
            break;
        }
        case "test.wake.end":
            root.wakeArmed = false;
            root.wakeEnd = msg;
            if (msg.id) root.resolvePending(msg.id, msg);
            root.markCapability("test.wake.arm", "supported");
            break;
        case "test.asr.result":
            root.asrRunning = false;
            root.asrResult = msg;
            if (msg.id) root.resolvePending(msg.id, msg);
            root.markCapability("test.asr.start", "supported");
            break;
        case "test.tts.result":
            root.ttsRunning = false;
            root.ttsResult = msg;
            if (msg.id) root.resolvePending(msg.id, msg);
            root.markCapability("test.tts", "supported");
            break;
        case "home.test":
            root.homeTestRunning = false;
            root.homeTestResult = msg;
            root.homeTestSeq += 1;
            if (msg.id) root.resolvePending(msg.id, msg);
            root.markCapability("home.test", "supported");
            break;
        case "llm.test":
            root.llmTestRunning = false;
            root.llmTestResult = msg;
            root.llmTestSeq += 1;
            if (msg.id) root.resolvePending(msg.id, msg);
            root.markCapability("llm.test", "supported");
            break;
        default:
            if (msg.id) root.resolvePending(msg.id, msg, false);
            break;
        }
    }

    // ---------------------------------------------------------- config access
    function refreshConfig(force) {
        if (!root.connected) return;
        if (!force && root.configLoaded) return;
        root.call("config.get", {}, {
            timeoutMs: 2000,
            onReply: function(msg) {
                root.config = msg.config || {};
                root.configLoaded = true;
            },
            onTimeout: function() {
                root.configLoaded = true;
            },
        });
    }

    // Overlay appearance preference: prefer the daemon-pushed ui frame, fall
    // back to config.get, then the documented default.
    function uiValue(key, fallback) {
        const snap = root.uiSnapshot || ({});
        if (snap[key] !== undefined && snap[key] !== null) return snap[key];
        return root.cfg("ui." + key, fallback);
    }

    // Secret fields are write-only: config.get returns "***" (or nothing) for
    // apiKey, so the UI can only show whether one is stored - never the value.
    function secretRaw(path) {
        return root.cfg(path, undefined);
    }

    // The daemon answers "***" for a secret (it never returns the key itself);
    // an empty string means unset. "***" cannot tell us whether one is stored
    // when the daemon masks unconditionally, so the UI says so explicitly.
    function secretStored(path) {
        const raw = root.secretRaw(path);
        if (typeof raw !== "string") return false;
        return raw.length > 0;
    }

    function secretMaskedOnly(path) {
        return root.secretRaw(path) === "***";
    }

    function secretPlaceholder(path, hint) {
        if (!root.configLoaded) return I18n.t("读取中…");
        if (!root.secretStored(path)) return (hint || I18n.t("未设置"));
        if (root.secretMaskedOnly(path)) return I18n.t("已保存（daemon 只回传掩码，不回显）");
        return I18n.t("已保存");
    }

    // Read a config value with a fallback (daemon may not have answered yet).
    function cfg(path, fallback) {
        let cur = root.config;
        const parts = String(path).split(".");
        for (let i = 0; i < parts.length; i++) {
            if (cur === null || cur === undefined || typeof cur !== "object") return fallback;
            cur = cur[parts[i]];
        }
        return cur === undefined || cur === null ? fallback : cur;
    }

    // Deep-merge a patch into the daemon config and echo the applied config.
    function applyPatch(patch, onDone) {
        root.call("config.set", { patch: patch }, {
            timeoutMs: 2500,
            onReply: function(msg) {
                if (msg && msg.config) root.config = msg.config;
                root.configDirty = false;
                const ok = !(msg && msg.ok === false);
                if (!ok) {
                    root.noteError((msg.errors && msg.errors.length ? msg.errors.join("；") : I18n.t("配置被 daemon 拒绝")));
                }
                if (onDone) onDone(ok, msg);
            },
            onTimeout: function() {
                root.noteError(I18n.t("config.set 未响应：当前 daemon 可能不支持配置写入"));
                if (onDone) onDone(false, null);
            },
            onError: function(msg) {
                root.configDirty = false;
                if (onDone) onDone(false, msg);
            },
        });
    }

    // ---------------------------------------------------- per-field config writes
    // Write one dotted config path (e.g. "asr.bargeIn.minRms") so the daemon
    // applies it immediately where it has a hot path, and so the UI can show
    // what happened to *this* field (applied / restart required / rejected).
    function writeField(path, value, opts) {
        return root.writeFields([{ path: path, value: value }], opts);
    }

    function writeFields(entries, opts) {
        opts = opts || {};
        entries = entries || [];
        if (entries.length === 0) return "";
        if (!root.connected) {
            const paths0 = [];
            for (let i = 0; i < entries.length; i++) paths0.push(entries[i].path);
            root.markFieldStatus(paths0, "error", I18n.t("daemon 未连接"));
            if (opts.onDone) opts.onDone(null);
            return paths0.join(",");
        }
        const patch = {};
        const paths = [];
        for (let i = 0; i < entries.length; i++) {
            const path = String(entries[i].path);
            paths.push(path);
            const parts = path.split(".");
            let node = patch;
            for (let j = 0; j < parts.length - 1; j++) {
                if (!node[parts[j]]) node[parts[j]] = {};
                node = node[parts[j]];
            }
            node[parts[parts.length - 1]] = entries[i].value;
        }
        root.markFieldStatus(paths, "pending", I18n.t("写入中…"));
        root.call("config.set", { patch: patch }, {
            timeoutMs: 2500,
            onReply: function(msg) {
                root.applyFieldStatus(paths, msg);
                if (opts.onDone) opts.onDone(msg);
            },
            onTimeout: function() {
                root.markFieldStatus(paths, "error", I18n.t("config.set 未响应（daemon 可能不支持写入）"));
                if (opts.onDone) opts.onDone(null);
            },
            onError: function(msg) {
                root.markFieldStatus(paths, "error", (msg && msg.message) || I18n.t("写入失败"));
                if (opts.onDone) opts.onDone(msg);
            },
        });
        return paths.join(",");
    }

    function pathMatches(list, path) {
        if (!list) return false;
        for (let i = 0; i < list.length; i++) {
            const p = String(list[i]);
            if (p === path || path.indexOf(p + ".") === 0 || p.indexOf(path + ".") === 0) return true;
        }
        return false;
    }

    function applyFieldStatus(paths, msg) {
        const forbidden = (msg && msg.forbidden) || [];
        const restart = (msg && msg.restartRequired) || [];
        const applied = (msg && msg.applied) || [];
        const errors = (msg && msg.errors) || [];
        for (let i = 0; i < paths.length; i++) {
            const path = paths[i];
            if (root.pathMatches(forbidden, path)) {
                root.markFieldStatus([path], "forbidden", I18n.t("daemon 未开放该配置（settings.js 白名单缺失）"));
            } else if (root.pathMatches(restart, path)) {
                root.markFieldStatus([path], "restart", I18n.t("已写入，重启 daemon 后生效"));
            } else if (root.pathMatches(applied, path)) {
                root.markFieldStatus([path], "applied", I18n.t("已生效"));
            } else if (Array.isArray(msg && msg.applied) && Array.isArray(msg && msg.restartRequired)
                       && applied.length === 0 && restart.length === 0 && forbidden.length === 0) {
                // The daemon accepted and wrote the value but reported no apply
                // path for it: it may need a restart or silently ignore it.
                root.markFieldStatus([path], "unknown", I18n.t("已写入 · daemon 未报告是否生效"));
            } else if (msg && msg.ok === false) {
                root.markFieldStatus([path], "forbidden", I18n.t("daemon 拒绝写入"));
            } else if (errors.length > 0) {
                root.markFieldStatus([path], "error", String(errors[0]));
            } else {
                root.markFieldStatus([path], "applied", I18n.t("已生效"));
            }
        }
    }

    function markFieldStatus(paths, state, message) {
        const next = {};
        for (const key in root.fieldStatus) next[key] = root.fieldStatus[key];
        const now = Date.now();
        for (let i = 0; i < paths.length; i++) next[paths[i]] = { state: state, at: now, message: message };
        root.fieldStatus = next;
    }

    function fieldState(path) {
        if (root.fieldStatus[path]) return root.fieldStatus[path];
        for (const key in root.fieldStatus) {
            if (key.indexOf(path + ".") === 0 || path.indexOf(key + ".") === 0) return root.fieldStatus[key];
        }
        return null;
    }

    // Worst state wins when several paths are shown together.
    function fieldStateFor(paths) {
        let worst = null;
        const rank = { error: 5, forbidden: 4, pending: 3, restart: 2, applied: 1 };
        for (let i = 0; i < paths.length; i++) {
            const st = root.fieldState(paths[i]);
            if (!st) continue;
            if (!worst || (rank[st.state] || 0) > (rank[worst.state] || 0)) worst = st;
        }
        return worst;
    }

    function refreshDiagnostics() {
        if (!root.connected) return;
        root.call("diagnostics", {}, {
            timeoutMs: 2000,
            onReply: function(msg) {
                root.diagnostics = msg;
                root.diagnosticsLoaded = true;
            },
            onTimeout: function() {
                root.diagnosticsLoaded = false;
            },
        });
    }

    // ------------------------------------------------------------- mic tests
    function micStart(ms) {
        root.micRunning = true;
        root.micSamples = [];
        root.micSampleCount = 0;
        root.micClipped = false;
        root.mic = ({});
        root.micEndSeq = 0;
        root.call("test.mic.start", { ms: ms }, {
            timeoutMs: Math.max(3000, ms + 3000),
            firstFrameTimeoutMs: 2000,
            onReply: function(msg) {
                root.markCapability("test.mic.start", "supported");
            },
            onTimeout: function() {
                root.micRunning = false;
            },
            onError: function(msg) {
                root.micRunning = false;
                root.noteError(msg.message || I18n.t("麦克风测试启动失败"));
            },
        });
    }

    function micStop() {
        root.micRunning = false;
        root.call("test.mic.stop", {}, { timeoutMs: 1200 });
    }

    // ------------------------------------------------------------ wake tests
    function wakeArm(ms, noise) {
        root.wakeScores = [];
        root.wakeHits = [];
        root.wakeEnd = ({});
        root.wakeHitSeq = 0;
        root.wakeArmed = true;
        root.wakeNoiseMode = !!noise;
        root.wakeArmedAt = Date.now();
        root.wakeArmedMs = ms;
        root.call("test.wake.arm", { ms: ms, noise: !!noise }, {
            timeoutMs: ms + 3500,
            firstFrameTimeoutMs: 2500,
            onReply: function(msg) {
                // The real daemon answers the arm command with {"type":"ack",...}
                // and only later sends test.wake.end. Do not stop the UI on ack.
                if (msg && msg.type === "test.wake.end") {
                    root.wakeEnd = msg;
                    root.wakeArmed = false;
                }
            },
            onTimeout: function() {
                root.wakeArmed = false;
            },
            onError: function(msg) {
                root.wakeArmed = false;
                root.wakeEnd = msg;
            },
        });
    }

    function wakeDisarm() {
        root.wakeArmed = false;
        if (root.connected) root.call("test.wake.disarm", {}, { timeoutMs: 1200 });
    }

    // ------------------------------------------------------------ asr test
    function asrStart() {
        root.asrRunning = true;
        root.asrPartials = [];
        root.asrPartialSeq = 0;
        root.asrResult = ({});
        root.asrStartedAt = Date.now();
        root.call("test.asr.start", {}, {
            timeoutMs: 20000,
            firstFrameTimeoutMs: 3000,
            onReply: function(msg) {
                root.asrResult = msg;
                root.asrRunning = false;
            },
            onTimeout: function() {
                root.asrRunning = false;
            },
            onError: function(msg) {
                root.asrRunning = false;
                root.asrResult = msg;
            },
        });
    }

    function asrStop() {
        if (root.connected) root.call("test.asr.stop", {}, { timeoutMs: 3000 });
    }

    // ------------------------------------------------------------ tts test
    function ttsTest(text, voiceId) {
        root.ttsRunning = true;
        root.ttsResult = ({});
        root.ttsLastText = text;
        const params = { text: text };
        if (voiceId) params.voiceId = voiceId;
        root.call("test.tts", params, {
            timeoutMs: 8000,
            onReply: function(msg) {
                root.ttsResult = msg;
                root.ttsRunning = false;
            },
            onTimeout: function() {
                root.ttsRunning = false;
            },
            onError: function(msg) {
                root.ttsRunning = false;
                root.ttsResult = msg;
            },
        });
    }

    // ------------------------------------------------------- home assistant
    // Probe ${haUrl}/api/ through the daemon (it holds the saved token; the GUI
    // never reads it back). A *draft* token typed in the page may be passed for
    // an unsaved config; the reply never contains the token.
    function homeTest(haUrl, haToken) {
        root.homeTestRunning = true;
        root.homeTestResult = ({});
        const params = {};
        if (haUrl) params.haUrl = haUrl;
        if (haToken) params.haToken = haToken;
        root.call("home.test", params, {
            timeoutMs: 7000,
            onReply: function(msg) {
                root.homeTestRunning = false;
                root.homeTestResult = msg;
                if (msg && msg.type === "home.test") root.markCapability("home.test", "supported");
            },
            onTimeout: function() {
                root.homeTestRunning = false;
                root.homeTestResult = { ok: false, message: I18n.t("daemon 没有响应连接测试（当前 daemon 可能不支持 home.test）") };
            },
            onError: function(msg) {
                root.homeTestRunning = false;
                root.homeTestResult = { ok: false, message: (msg && msg.message) || I18n.t("连接测试失败") };
                if (msg && msg.code === "unsupported") root.markCapability("home.test", "unsupported");
            },
        });
    }

    // --------------------------------------------------------- generic llm
    // Draft values are allowed so "test before save" works; the daemon overlays
    // them on the saved effective config. A masked key ("***") means the daemon
    // should use the saved key.
    function llmTest(draft) {
        root.llmTestRunning = true;
        root.llmTestResult = ({});
        const params = {};
        if (draft && typeof draft === "object") params.llm = draft;
        root.call("llm.test", params, {
            timeoutMs: 12000,
            onReply: function(msg) {
                root.llmTestRunning = false;
                root.llmTestResult = msg;
                if (msg && msg.type === "llm.test") root.markCapability("llm.test", "supported");
            },
            onTimeout: function() {
                root.llmTestRunning = false;
                root.llmTestResult = { ok: false, message: I18n.t("daemon 没有响应 LLM 连接测试（当前 daemon 可能不支持 llm.test）") };
            },
            onError: function(msg) {
                root.llmTestRunning = false;
                root.llmTestResult = { ok: false, message: (msg && msg.message) || I18n.t("LLM 连接测试失败") };
                if (msg && msg.code === "unsupported") root.markCapability("llm.test", "unsupported");
            },
        });
    }

    // -------------------------------------------------------- service restart
    function restartService() {
        root.restartPending = true;
        root.restartState = "sent";
        root.call("service.restart", {}, {
            timeoutMs: 3000,
            onReply: function() {
                root.restartState = "accepted";
            },
            onTimeout: function() {
                root.restartState = "unsupported";
                root.restartPending = false;
                root.markCapability("service.restart", "unsupported");
            },
            onError: function(msg) {
                root.restartState = "unsupported";
                root.restartPending = false;
                root.noteError(msg.message || I18n.t("重启请求失败"));
            },
        });
    }

    function ping() {
        root.sendRaw({ type: "ping" });
    }

    function cancel() {
        root.sendRaw({ type: "cancel" });
    }

    // ------------------------------------------------------------- formatting
    function fmtMs(ms) {
        if (ms === undefined || ms === null || isNaN(ms)) return "—";
        return Math.round(ms) + " ms";
    }
    function fmtDuration(ms) {
        if (ms === undefined || ms === null || isNaN(ms)) return "—";
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (h > 0) return h + I18n.t(" 小时 ") + m + I18n.t(" 分");
        if (m > 0) return m + I18n.t(" 分 ") + sec + I18n.t(" 秒");
        return sec + I18n.t(" 秒");
    }
    function errorTime(err) {
        if (!err) return 0;
        if (typeof err.t === "number") return err.t;
        if (typeof err.at === "string") return Date.parse(err.at) || 0;
        return 0;
    }
    function fmtClock(t) {
        if (!t) return "—";
        const d = new Date(t);
        const pad = (n) => (n < 10 ? "0" + n : "" + n);
        return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    }
    function fmtBytes(n) {
        if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
        if (n > 1024) return (n / 1024).toFixed(1) + " KB";
        return n + " B";
    }
}
