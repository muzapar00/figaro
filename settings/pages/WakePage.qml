import QtQuick
import QtQuick.Layouts
import Quickshell.Io
import ".."
import "../components"

MPageScroll {
    id: page

    // ---- settings drafts (synced from Ipc.config on load/save) -------------
    property bool wakeEnabled: true
    property string sensitivity: "low"
    property int cooldownMs: 2500
    property var wakeWords: []
    property var wakeWordsEn: []
    property bool englishEnabled: true
    property string hotkey: ""
    property bool editingHotkey: false
    property string draftHotkey: ""
    // ---- voiceprint gate (asr.speaker.*) ----------------------------------
    property bool speakerEnabledDraft: false
    property real speakerThresholdDraft: 0.65
    signal enrollCommandRequested()
    readonly property var englishDefaults: ["figaro", "hey figaro"]
    readonly property var chineseDefaults: ["费加罗", "菲加罗", "飞加罗", "figaro", "费加"]

    // ---- wake test state ---------------------------------------------------
    property string testMode: ""          // "" | "wake" | "ambient"
    property double testStartedAt: 0
    property int testDurationMs: 15000
    property var ambientRows: []
    property int lastSeenHitSeq: 0
    property string countdown: "0.0"
    property int lastWakeHits: -1
    property real lastWakeLatency: -1
    property real lastWakeMaxScore: -1
    property int lastWakeMisses: -1
    property real ambientElapsedMs: 0
    property bool noisePlaying: false
    property string lastCsvPath: ""
    property int ambientDurationIndex: 1  // 30s / 60s / 120s
    readonly property var ambientDurations: [30000, 60000, 120000]

    readonly property var wakeEndInfo: (Ipc.wakeEnd && Ipc.wakeEnd.type === "test.wake.end") ? Ipc.wakeEnd : ({})
    readonly property bool wakeDone: wakeEndInfo.hits !== undefined
    readonly property bool wakeSupported: !Ipc.unsupported("test.wake.arm")

    function syncFromConfig() {
        page.wakeEnabled = Ipc.cfg("asr.enabled", true) !== false;
        page.sensitivity = String(Ipc.cfg("asr.sensitivity", "low"));
        page.cooldownMs = Number(Ipc.cfg("asr.wakeCooldownMs", 2500));
        const words = Ipc.cfg("asr.wakeWords", page.chineseDefaults);
        page.wakeWords = Array.isArray(words) ? words : page.chineseDefaults;
        const wordsEn = Ipc.cfg("asr.wakeWordsEn", page.englishDefaults);
        const list = Array.isArray(wordsEn) ? wordsEn : [];
        page.englishEnabled = list.length > 0;
        page.wakeWordsEn = list.length > 0 ? list : page.englishDefaults.slice(0);
        page.hotkey = String(Ipc.cfg("asr.hotkey", "") || "");
        page.speakerEnabledDraft = Ipc.cfg("asr.speaker.enabled", false) === true;
        page.speakerThresholdDraft = Number(Ipc.cfg("asr.speaker.threshold", 0.65));
    }

    // ---- voiceprint gate ---------------------------------------------------
    // Read-only snapshot pushed by the daemon diagnostics (src/agent/settings.js
    // passthrough of the ASR module's `speaker` state).
    readonly property var speakerInfo: {
        const diag = Ipc.diagnostics || ({});
        const asr = diag.asr || ({});
        return asr.speaker && typeof asr.speaker === "object" ? asr.speaker : null;
    }
    readonly property string speakerState: page.speakerInfo ? String(page.speakerInfo.state || "") : ""
    readonly property bool speakerEnrolled: page.speakerInfo ? page.speakerInfo.enrolled === true : false
    readonly property int speakerChecked: page.speakerInfo ? Number(page.speakerInfo.checked || 0) : 0
    readonly property int speakerRejected: page.speakerInfo ? Number(page.speakerInfo.rejected || 0) : 0
    readonly property real speakerLastScore: (page.speakerInfo && page.speakerInfo.lastScore !== null
        && page.speakerInfo.lastScore !== undefined) ? Number(page.speakerInfo.lastScore) : -1

    function speakerLabel() {
        switch (page.speakerState) {
        case "ready": return "就绪";
        case "not-enrolled": return "未注册";
        case "model-missing": return "模型缺失";
        case "disabled": return "关闭";
        default: return page.speakerInfo ? "未知" : "未提供";
        }
    }
    function speakerTone() {
        switch (page.speakerState) {
        case "ready": return Theme.green;
        case "not-enrolled": return Theme.orange;
        case "model-missing": return Theme.red;
        case "disabled": return Theme.textFaint;
        default: return Theme.textDim;
        }
    }
    function speakerNote() {
        switch (page.speakerState) {
        case "ready":
            return "声纹已就绪：唤醒时会先比对你的声纹，非主人声音会被过滤掉。";
        case "not-enrolled":
            return "还没有录制声纹：运行下面的命令在安静环境录 3 句，录完自动启用。";
        case "model-missing":
            return "缺少声纹模型：先运行 scripts/fetch-models.sh（或检查 asr.speaker.model 路径）。";
        case "disabled":
            return "声纹门控关闭时，任何人喊「费加罗」都会唤醒。开启前建议先录制声纹。";
        default:
            return "当前 daemon 没有提供声纹状态（旧 daemon 或 ASR 模块未加载）。";
        }
    }
    function speakerScoreText() {
        if (page.speakerState === "disabled") return "声纹门控已关闭";
        if (!page.speakerInfo) return "—";
        const parts = [];
        if (page.speakerLastScore >= 0) parts.push("上次 score " + page.speakerLastScore.toFixed(2));
        parts.push("已检测 " + page.speakerChecked + " 次");
        parts.push("已过滤 " + page.speakerRejected + " 次");
        return parts.join(" · ");
    }
    function setSpeakerEnabled(value) {
        page.speakerEnabledDraft = value;
        Ipc.writeField("asr.speaker.enabled", value);
    }
    function setSpeakerThreshold(value) {
        const rounded = Math.round(Number(value) * 100) / 100;   // slider step 0.01
        page.speakerThresholdDraft = rounded;
        Ipc.writeField("asr.speaker.threshold", rounded);
    }
    function openEnrollDialog() {
        page.enrollCommandRequested();
        return "wake-enroll-dialog";
    }
    function speakerDemoWrite() {
        page.speakerEnabledDraft = true;
        page.speakerThresholdDraft = 0.72;
        Ipc.writeFields([
            { path: "asr.speaker.enabled", value: true },
            { path: "asr.speaker.threshold", value: 0.72 },
        ]);
        return "speaker-demo-written";
    }

    function timestamp() {
        const d = new Date();
        const p = n => (n < 10 ? "0" + n : "" + n);
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-"
            + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }

    function remainingSeconds() {
        if (!Ipc.wakeArmed) return "0.0";
        const left = Ipc.wakeArmedAt + Ipc.wakeArmedMs - Date.now();
        return Math.max(0, left / 1000).toFixed(1);
    }

    function averageLatency() {
        const hits = Ipc.wakeHits || [];
        if (page.testMode !== "wake" || hits.length === 0) {
            return page.lastWakeLatency >= 0 ? Math.round(page.lastWakeLatency) + " ms" : "—";
        }
        let sum = 0;
        for (let i = 0; i < hits.length; i++) sum += Number(hits[i].latencyMs) || 0;
        return Math.round(sum / hits.length) + " ms";
    }

    function wakeHitsShown() {
        if (page.testMode === "wake") return String(Ipc.wakeHits.length);
        return page.lastWakeHits >= 0 ? String(page.lastWakeHits) : "—";
    }

    function wakeMissesShown() {
        if (page.wakeEndInfo.misses !== undefined && page.testMode !== "ambient")
            return String(page.wakeEndInfo.misses);
        return page.lastWakeMisses >= 0 ? String(page.lastWakeMisses) : "—";
    }

    function maxScoreShown() {
        if (page.testMode === "wake") {
            let max = 0;
            for (let i = 0; i < Ipc.wakeScores.length; i++) max = Math.max(max, Ipc.wakeScores[i]);
            return max.toFixed(2);
        }
        if (page.testMode === "ambient") return "—";
        if (page.lastWakeMaxScore >= 0) return page.lastWakeMaxScore.toFixed(2);
        return page.maxScore();
    }

    function ambientRate() {
        const ms = page.ambientElapsedMs > 0 ? page.ambientElapsedMs : page.testDurationMs;
        const minutes = Math.max(ms / 60000, 1 / 60);
        return (page.ambientRows.length / minutes).toFixed(1);
    }

    function maxScore() {
        if (page.wakeEndInfo.maxScore !== undefined) return Number(page.wakeEndInfo.maxScore).toFixed(2);
        let max = 0;
        for (let i = 0; i < Ipc.wakeScores.length; i++) max = Math.max(max, Ipc.wakeScores[i]);
        return max.toFixed(2);
    }

    // ---- wake / ambient test control --------------------------------------
    function startWakeTest() {
        page.testMode = "wake";
        page.testStartedAt = Date.now();
        page.testDurationMs = 15000;
        page.ambientRows = [];
        Ipc.wakeArm(15000, false);
        page.lastSeenHitSeq = Ipc.wakeHitSeq;   // wakeArm resets the hit counter
        return "wake-test-started";
    }

    function stopWakeTest() {
        page.testMode = "";
        Ipc.wakeDisarm();
        return "wake-test-stopped";
    }

    function startAmbientTest() {
        const ms = page.ambientDurations[page.ambientDurationIndex];
        page.testMode = "ambient";
        page.testStartedAt = Date.now();
        page.testDurationMs = ms;
        page.ambientRows = [];
        Ipc.wakeArm(ms, true);
        page.lastSeenHitSeq = Ipc.wakeHitSeq;   // wakeArm resets the hit counter
        return "ambient-test-started:" + ms;
    }

    function stopAmbientTest() {
        page.testMode = "";
        Ipc.wakeDisarm();
        return "ambient-test-stopped";
    }

    function setNoisePlayback(on) {
        page.noisePlaying = !!on;
        noiseProcess.running = !!on;
        return page.noisePlaying ? "noise-on" : "noise-off";
    }

    function exportAmbientCsv() {
        const stamp = page.timestamp();
        const path = Ipc.homeDir + "/figaro-ambient-" + stamp + ".csv";
        let text = "time,score,kws_hit,false_trigger,latency_ms\n";
        for (let i = 0; i < page.ambientRows.length; i++) {
            const r = page.ambientRows[i];
            text += Ipc.fmtClock(r.t) + "," + Number(r.score).toFixed(3) + ","
                + (r.hit ? "yes" : "no") + "," + (r.falseAlarm ? "yes" : "no") + ","
                + (r.latencyMs || 0) + "\n";
        }
        text += "# summary: rows=" + page.ambientRows.length
            + " hits=" + page.ambientRows.length
            + " duration_ms=" + (page.ambientElapsedMs > 0 ? Math.round(page.ambientElapsedMs) : page.testDurationMs)
            + " generated=" + new Date().toISOString() + "\n";
        csvFile.path = path;
        csvFile.setText(text);
        page.lastCsvPath = path;
        return path;
    }

    function masterSwitchNeedsRestart() {
        const req = Ipc.configRestartRequired || [];
        for (let i = 0; i < req.length; i++)
            if (String(req[i]).indexOf("asr.enabled") >= 0) return true;
        return false;
    }

    function sensitivityNote() {
        if (page.sensitivity === "high")
            return "实测（15.2 分钟负样本）：中文 8/8 · 英文 19/20 · 近音误触发 5/40 · 合计误唤醒 6 次（更灵敏，近音代价更高）";
        if (page.sensitivity === "medium")
            return "实测（15.2 分钟负样本）：中文 8/8 · 英文 20/20 · 近音误触发 2/40 · 合计误唤醒 3 次";
        return "实测（15.2 分钟负样本）：中文 8/8 · 英文 20/20 · 近音误触发 2/40 · 真人中文 0/10min · 合计 3 次（默认，最保守）";
    }

    function sensitivityLatencyNote() {
        return "中文检测中位 ≈ 900 ms（「费加」说完）；onWake 延迟中位：中文 ≈ 1249 ms / 英文 ≈ 1435 ms";
    }

    function setWakeEnabled(value) {
        page.wakeEnabled = value;
        Ipc.writeField("asr.enabled", value);
    }

    function setSensitivity(value) {
        page.sensitivity = value;
        Ipc.writeField("asr.sensitivity", value);
    }

    function setCooldown(value) {
        const v = Math.round(value / 100) * 100;
        page.cooldownMs = v;
        Ipc.writeField("asr.wakeCooldownMs", v);
    }

    function setWakeWords(values) {
        const list = [];
        for (let i = 0; i < values.length; i++) {
            const w = String(values[i]).trim();
            if (w.length > 0) list.push(w);
        }
        page.wakeWords = list;
        Ipc.writeField("asr.wakeWords", list);
    }

    function setEnglishEnabled(value) {
        page.englishEnabled = value;
        Ipc.writeField("asr.wakeWordsEn", value ? page.wakeWordsEn : []);
    }

    function setWakeWordsEn(values) {
        const list = [];
        for (let i = 0; i < values.length; i++) {
            const w = String(values[i]).trim();
            if (w.length > 0) list.push(w);
        }
        page.wakeWordsEn = list;
        page.englishEnabled = list.length > 0;
        Ipc.writeField("asr.wakeWordsEn", list);
    }

    // Harness hook for the screenshot/verification script.
    function demoWrite() {
        Ipc.writeFields([
            { path: "asr.sensitivity", value: "low" },
            { path: "asr.wakeWords", value: ["费加罗", "菲加罗", "飞加罗"] },
            { path: "asr.wakeWordsEn", value: ["figaro", "hey figaro"] },
        ]);
        return "wake-demo-written";
    }

    function snapshot() {
        return {
            title: "唤醒",
            testMode: page.testMode,
            wakeArmed: Ipc.wakeArmed,
            wakeSupported: page.wakeSupported,
            scoreSamples: Ipc.wakeScores.length,
            hits: Ipc.wakeHits.length,
            lastScore: Ipc.wakeScore,
            wakeEnd: page.wakeEndInfo,
            ambientRows: page.ambientRows.length,
            ambientCsv: page.lastCsvPath,
            ambientRate: page.ambientRate(),
            lastWakeHits: page.lastWakeHits,
            lastWakeLatencyMs: page.lastWakeLatency,
            lastWakeMaxScore: page.lastWakeMaxScore,
            lastWakeMisses: page.lastWakeMisses,
            noisePlaying: page.noisePlaying,
            sensitivity: page.sensitivity,
            cooldownMs: page.cooldownMs,
            wakeWords: page.wakeWords,
            wakeWordsEn: page.wakeWordsEn,
            englishEnabled: page.englishEnabled,
            hotkey: page.hotkey,
            speakerState: page.speakerState,
            speakerLabel: page.speakerLabel(),
            speakerEnrolled: page.speakerEnrolled,
            speakerEnabled: page.speakerEnabledDraft,
            speakerThreshold: page.speakerThresholdDraft,
            speakerChecked: page.speakerChecked,
            speakerRejected: page.speakerRejected,
            speakerLastScore: page.speakerLastScore,
            speakerInfo: page.speakerInfo,
        };
    }

    Connections {
        target: Ipc
        function onConfigChanged() {
            page.syncFromConfig();
            Ipc.refreshDiagnostics();
        }
        function onDiagnosticsLoadedChanged() {
            if (Ipc.diagnosticsLoaded && page.speakerInfo && page.speakerInfo.threshold !== undefined
                && page.speakerInfo.threshold !== null) {
                // daemon is authoritative for the stored threshold
                if (Math.abs(Number(page.speakerInfo.threshold) - page.speakerThresholdDraft) > 1e-9
                    && Ipc.fieldState("asr.speaker.threshold") === null) {
                    page.speakerThresholdDraft = Number(page.speakerInfo.threshold);
                }
            }
        }
        function onWakeHitSeqChanged() {
            if (page.testMode !== "ambient") return;
            if (Ipc.wakeHitSeq <= page.lastSeenHitSeq) return;
            page.lastSeenHitSeq = Ipc.wakeHitSeq;
            const hit = Ipc.wakeHits[Ipc.wakeHits.length - 1];
            const rows = page.ambientRows.slice(0);
            rows.push({
                t: Date.now(),
                score: hit.score,
                hit: true,
                falseAlarm: true,
                latencyMs: hit.latencyMs,
            });
            if (rows.length > 200) rows.splice(0, rows.length - 200);
            page.ambientRows = rows;
        }
        function onCapabilitiesChanged() {
            if (Ipc.unsupported("test.wake.arm")) page.testMode = "";
            if (Ipc.unsupported("config.get")) page.syncFromConfig();
        }
        function onWakeEndChanged() {
            const end = Ipc.wakeEnd || ({});
            if (end.type !== "test.wake.end") return;
            if (!end.noise) {
                page.lastWakeHits = Number(end.hits) || 0;
                page.lastWakeMisses = Number(end.misses) || 0;
                page.lastWakeMaxScore = Number(end.maxScore) || 0;
                const hits = Ipc.wakeHits || [];
                let sum = 0;
                for (let i = 0; i < hits.length; i++) sum += Number(hits[i].latencyMs) || 0;
                page.lastWakeLatency = hits.length > 0 ? sum / hits.length : -1;
            }
            page.ambientElapsedMs = end.durationMs !== undefined ? Number(end.durationMs)
                : (end.ms !== undefined ? Number(end.ms) : Date.now() - page.testStartedAt);
            page.testMode = "";
        }
    }

    Component.onCompleted: {
        page.syncFromConfig();
        Ipc.refreshDiagnostics();
    }

    Timer {
        interval: 100
        repeat: true
        running: Ipc.wakeArmed
        onTriggered: {
            page.countdown = page.remainingSeconds();
            page.ambientElapsedMs = Date.now() - page.testStartedAt;
        }
    }

    FileView {
        id: csvFile
        path: ""
        blockWrites: true
        printErrors: false
    }

    // Pink noise generator for the false-wake test (ffmpeg renders once, then
    // pw-play loops the file while the test runs). Any failure is non-fatal.
    Process {
        id: noiseProcess
        running: false
        command: ["sh", "-c",
            "f=\"${XDG_RUNTIME_DIR:-/tmp}/figaro-settings-noise.wav\"; " +
            "if [ ! -s \"$f\" ]; then ffmpeg -hide_banner -loglevel error -f lavfi " +
            "-i anoisesrc=d=180:c=pink:r=48000 -y \"$f\" || exit 3; fi; exec pw-play \"$f\""]
        onExited: (code, status) => {
            if (code !== 0) console.warn("[figaro-settings] noise playback exited " + code);
            page.noisePlaying = false;
        }
    }

    Rectangle {
        visible: Ipc.unsupported("config.get")
        Layout.fillWidth: true
        implicitHeight: 36
        radius: 8
        color: Qt.rgba(1.0, 0.84, 0.04, 0.10)
        RowLayout {
            anchors.fill: parent
            anchors.margins: 9
            spacing: 8
            MIcon { kind: "warning"; size: 14; color: Theme.yellow }
            Text {
                Layout.fillWidth: true
                text: "当前 daemon 不支持 config.get：以下显示本机默认值，修改不会生效。"
                color: Theme.yellow
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
    }

    MPageHeader {
        title: "唤醒"
        subtitle: "唤醒词、灵敏度与误唤醒自测"
        icon: "wake"
    }

    MCard {
        title: "唤醒设置"

        MRow {
            label: "唤醒监听"
            subtitle: "总开关 · 写入 asr.enabled"
            RowLayout {
                spacing: 8
                MApplyStatus { paths: ["asr.enabled"] }
                MToggle {
                    checked: page.wakeEnabled
                    onToggled: (value) => page.setWakeEnabled(value)
                }
            }
        }
        Text {
            visible: page.masterSwitchNeedsRestart()
            Layout.fillWidth: true
            text: "asr.enabled 需要重启 daemon 才能生效（诊断页有「重启服务」按钮）。"
            color: Theme.orange
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: Text.WordWrap
        }
        MRow {
            label: "灵敏度"
            subtitle: "low 更保守（少误唤醒）· high 更灵敏 · 热切换立即生效"
            RowLayout {
                spacing: 8
                MApplyStatus { paths: ["asr.sensitivity"] }
                MSegmented {
                    options: ["low", "medium", "high"]
                    currentIndex: page.sensitivity === "high" ? 2 : (page.sensitivity === "medium" ? 1 : 0)
                    onActivated: (index, value) => page.setSensitivity(value)
                }
            }
        }
        Text {
            Layout.fillWidth: true
            text: page.sensitivityNote()
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WordWrap
        }
        Text {
            Layout.fillWidth: true
            text: page.sensitivityLatencyNote()
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WordWrap
        }
        Text {
            visible: Ipc.configErrors.length > 0
            Layout.fillWidth: true
            text: "daemon 拒绝：" + Ipc.configErrors.join("；")
            color: Theme.orange
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: Text.WordWrap
        }
    }

    // ---------------------------------------------------------- 声纹（门控）
    MCard {
        title: "声纹"
        subtitle: "用你自己的声音做二次校验：别人喊「费加罗」不会唤醒（asr.speaker.*）"

        MRow {
            label: "声纹门控"
            subtitle: "开启后唤醒前先比对声纹 · 写入 asr.speaker.enabled（需重启 daemon）"
            RowLayout {
                spacing: 8
                MPill {
                    text: page.speakerLabel()
                    tone: page.speakerTone()
                }
                MApplyStatus { paths: ["asr.speaker.enabled"] }
                MToggle {
                    checked: page.speakerEnabledDraft
                    onToggled: (value) => page.setSpeakerEnabled(value)
                }
            }
        }
        MRow {
            label: "相似度阈值"
            subtitle: "0.35–0.90 · 越高越严格 · config 优先（需重启）"
            RowLayout {
                spacing: 8
                Text {
                    text: page.speakerThresholdDraft.toFixed(2)
                    color: Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    Layout.preferredWidth: 38
                    horizontalAlignment: Text.AlignRight
                }
                MSlider {
                    Layout.preferredWidth: 170
                    from: 0.35
                    to: 0.90
                    value: page.speakerThresholdDraft
                    markers: [0.65]
                    onMoved: (v) => page.setSpeakerThreshold(v)
                }
                MApplyStatus { paths: ["asr.speaker.threshold"] }
            }
        }
        MRow {
            label: "声纹记录"
            subtitle: "安静环境下用正常音量录 3 句，约 10 秒；录完自动启用"
            showSeparator: false
            MButton {
                text: "重新录制声纹"
                icon: "mic"
                onClicked: page.openEnrollDialog()
            }
        }
        Text {
            Layout.fillWidth: true
            text: page.speakerScoreText()
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: Text.WordWrap
        }
        Text {
            Layout.fillWidth: true
            text: page.speakerNote()
            color: page.speakerState === "model-missing" ? Theme.orange
                : page.speakerState === "ready" ? Theme.green : Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: Text.WordWrap
        }
    }

    MAdvancedCard {
        title: "高级 · 热键与防抖"
        subtitle: "平时不用管：两次唤醒的最小间隔、全局热键重新绑定"

        MRow {
            label: "防抖冷却"
            subtitle: "两次唤醒之间的最小间隔 · 写入 asr.wakeCooldownMs"
            RowLayout {
                spacing: 8
                Text {
                    text: page.cooldownMs + " ms"
                    color: Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    Layout.preferredWidth: 62
                    horizontalAlignment: Text.AlignRight
                }
                MSlider {
                    Layout.preferredWidth: 150
                    from: 500
                    to: 6000
                    value: page.cooldownMs
                    markers: [2500]
                    onMoved: (v) => page.setCooldown(v)
                }
                MApplyStatus { paths: ["asr.wakeCooldownMs"] }
            }
        }
        MRow {
            label: "全局热键"
            subtitle: "保存在 asr.hotkey；daemon 重启后向系统注册"
            visible: !page.editingHotkey
            RowLayout {
                spacing: 8
                Rectangle {
                    implicitWidth: hotkeyText.implicitWidth + 16
                    implicitHeight: 24
                    radius: 6
                    color: Theme.insetBg
                    border.width: 0.5
                    border.color: Qt.rgba(1, 1, 1, 0.10)
                    Text {
                        id: hotkeyText
                        anchors.centerIn: parent
                        text: page.hotkey.length > 0 ? page.hotkey : "未绑定"
                        color: Theme.text
                        font.family: "JetBrains Mono, Inter, " + Theme.fontCJK
                        font.pixelSize: Theme.fsSmall
                    }
                }
                MButton {
                    text: "重新绑定"
                    onClicked: {
                        page.editingHotkey = true;
                        page.draftHotkey = page.hotkey;
                    }
                }
            }
        }
        Item {
            visible: page.editingHotkey
            Layout.fillWidth: true
            Layout.preferredHeight: 64
            ColumnLayout {
                anchors.fill: parent
                spacing: 4
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    MTextField {
                        Layout.fillWidth: true
                        text: page.draftHotkey
                        placeholder: "例如 CTRL+ALT+F5"
                    }
                    MButton {
                        text: "保存"
                        primary: true
                        onClicked: {
                            Ipc.applyPatch({ asr: { hotkey: page.draftHotkey.trim() } });
                            page.editingHotkey = false;
                        }
                    }
                    MButton {
                        text: "取消"
                        onClicked: page.editingHotkey = false;
                    }
                }
                Text {
                    Layout.fillWidth: true
                    text: "保存后请在系统弹出的 XDG GlobalShortcuts 授权窗口里点「允许」。"
                        + "未弹出时，重启 daemon（诊断页）会重新注册热键。"
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsTiny
                    wrapMode: Text.WordWrap
                }
            }
        }
        MApplyStatus {
            Layout.fillWidth: true
            paths: ["asr.wakeCooldownMs", "asr.hotkey"]
        }
    }

    // -------------------------------------------------------- 唤醒词（中英）
    MCard {
        title: "唤醒词（中英双语）"
        subtitle: "模型 sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20 · 中文拼音与英文音素同时监听"
        contentSpacing: 14
            + " · 默认灵敏度 low 实测中文 8/8、英文 20/20"

        Text {
            Layout.fillWidth: true
            text: "中文唤醒词"
            color: Theme.textDim
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            font.weight: Font.DemiBold
        }
        MChipEditor {
            Layout.fillWidth: true
            values: page.wakeWords
            placeholder: "例如：费加罗"
            addLabel: "添加中文唤醒词"
            emptyText: "（空：中文无法唤醒）"
            onEdited: (values) => page.setWakeWords(values)
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            MButton {
                text: "恢复默认"
                icon: "refresh"
                onClicked: page.setWakeWords(page.chineseDefaults.slice(0))
            }
            MApplyStatus { paths: ["asr.wakeWords"] }
            Item { Layout.fillWidth: true }
            Text {
                text: "共 " + page.wakeWords.length + " 条"
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }

        Rectangle {
            Layout.fillWidth: true
            height: 1
            color: Theme.separator
            opacity: 0.55
        }

        MRow {
            label: "英文唤醒"
            subtitle: "asr.wakeWordsEn · 模型自带 en.phone 音素，Figaro / Hey Figaro 都能唤醒"
            RowLayout {
                spacing: 8
                MApplyStatus { paths: ["asr.wakeWordsEn"] }
                MToggle {
                    checked: page.englishEnabled
                    onToggled: (value) => page.setEnglishEnabled(value)
                }
            }
        }
        MChipEditor {
            Layout.fillWidth: true
            visible: page.englishEnabled
            values: page.wakeWordsEn
            placeholder: "例如：figaro / hey figaro"
            addLabel: "添加英文唤醒词"
            emptyText: "（空：英文无法唤醒）"
            onEdited: (values) => page.setWakeWordsEn(values)
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            visible: page.englishEnabled
            MButton {
                text: "恢复默认英文"
                icon: "refresh"
                onClicked: page.setWakeWordsEn(page.englishDefaults.slice(0))
            }
            MApplyStatus { paths: ["asr.wakeWordsEn"] }
            Item { Layout.fillWidth: true }
            Text {
                text: "共 " + page.wakeWordsEn.length + " 条"
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
        Text {
            Layout.fillWidth: true
            text: "中文按拼音生成关键词（含「费加/菲加」两字短前缀：召回 8/8 的代价是近音句偶发命中）；"
                + "英文按 6 个 FIGARO + 3 个 HEY_FIGARO 发音变体匹配，实测英文原生音色 12/12、中文口音英文 8/8。"
                + "词表改动需要重启 daemon 才会重建 KWS 关键词文件。"
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WordWrap
        }
    }

    // ------------------------------------------------------------ 唤醒测试
    MCard {
        title: "唤醒测试"
        subtitle: "说 3~5 次「费加罗」，观察实时 KWS 分数、命中次数与延迟"
        contentSpacing: 14

        Rectangle {
            visible: Ipc.unsupported("test.wake.arm")
            Layout.fillWidth: true
            implicitHeight: 40
            radius: 8
            color: Qt.rgba(1.0, 0.84, 0.04, 0.10)
            RowLayout {
                anchors.fill: parent
                anchors.margins: 9
                spacing: 8
                MIcon { kind: "warning"; size: 15; color: Theme.yellow }
                Text {
                    Layout.fillWidth: true
                    text: "当前 daemon 不支持此功能（test.wake.arm 未响应）。"
                    color: Theme.yellow
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            MButton {
                text: page.testMode === "wake" ? "停止测试" : "开始 15 秒测试"
                icon: page.testMode === "wake" ? "stop" : "record"
                primary: page.testMode !== "wake"
                enabled: Ipc.connected && page.wakeSupported && (page.testMode === "" || page.testMode === "wake")
                onClicked: page.testMode === "wake" ? page.stopWakeTest() : page.startWakeTest()
            }
            MPill {
                text: page.testMode === "wake" ? "测试中" : (page.wakeDone ? "已结束" : "未开始")
                tone: page.testMode === "wake" ? Theme.accent : (page.wakeDone ? Theme.green : Theme.textDim)
            }
            Text {
                id: countdownText
                text: page.testMode === "wake" ? page.countdown + " s" : ""
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
            Item { Layout.fillWidth: true }
            Text {
                text: "KWS 分数 " + (Ipc.wakeScore > 0 ? Ipc.wakeScore.toFixed(2) : "—")
                color: Ipc.wakeScore > 0.8 ? Theme.red : Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fs
                font.weight: Font.DemiBold
            }
        }

        Item {
            Layout.fillWidth: true
            Layout.preferredHeight: 22
            Rectangle {
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                height: 8
                radius: 4
                color: Theme.insetBg
                Rectangle {
                    width: parent.width * Math.max(0, Math.min(1, Ipc.wakeScore))
                    height: parent.height
                    radius: 4
                    color: Ipc.wakeScore > 0.8 ? Theme.red : (Ipc.wakeScore > 0.5 ? Theme.yellow : Theme.green)
                    Behavior on width { NumberAnimation { duration: 80 } }
                }
                Rectangle {
                    x: parent.width * 0.8
                    width: 2
                    height: parent.height + 6
                    y: -3
                    radius: 1
                    color: Theme.orange
                }
            }
        }

        MSparkline {
            Layout.fillWidth: true
            Layout.preferredHeight: 64
            scores: Ipc.wakeScores
            threshold: 0.8
            lineColor: Theme.accent
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 12
            MStat {
                label: "命中次数"
                value: page.wakeHitsShown()
                tone: Theme.green
            }
            MStat {
                label: "平均命中延迟"
                value: page.averageLatency()
                tone: Theme.accent
            }
            MStat {
                label: "最高分"
                value: page.maxScoreShown()
                tone: Theme.text
            }
            MStat {
                label: "漏检"
                value: page.wakeMissesShown()
                tone: Theme.orange
                hint: "窗口内 0 命中视为可疑"
            }
        }

        Text {
            Layout.fillWidth: true
            text: page.wakeDone
                ? "上一次测试：" + (page.wakeEndInfo.hits || 0) + " 次命中 / "
                    + (page.wakeEndInfo.falseAlarms || 0) + " 次误触发 / 最高分 "
                    + (page.wakeEndInfo.maxScore !== undefined ? page.wakeEndInfo.maxScore : page.maxScore())
                    + " · " + Ipc.fmtDuration(page.wakeEndInfo.ms || page.wakeEndInfo.durationMs || 0)
                : "提示：分数条越过橙色阈值（0.80）通常意味着 KWS 认为听到了唤醒词。"
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: Text.WordWrap
        }
    }

    // ------------------------------------------------------ 环境音抑制测试
    MCard {
        title: "环境音抑制测试"
        subtitle: "播放音乐/背景噪音，统计误唤醒次数——任何命中都算误触发"
        contentSpacing: 14

        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            MButton {
                text: page.testMode === "ambient" ? "停止统计" : "开始统计"
                icon: page.testMode === "ambient" ? "stop" : "record"
                primary: page.testMode !== "ambient"
                enabled: Ipc.connected && page.wakeSupported && (page.testMode === "" || page.testMode === "ambient")
                onClicked: page.testMode === "ambient" ? page.stopAmbientTest() : page.startAmbientTest()
            }
            MSegmented {
                options: ["30 秒", "1 分钟", "2 分钟"]
                currentIndex: page.ambientDurationIndex
                onActivated: (index, value) => page.ambientDurationIndex = index
            }
            MButton {
                text: page.noisePlaying ? "停止白噪音" : "播放白噪音"
                icon: page.noisePlaying ? "stop" : "speaker"
                onClicked: page.setNoisePlayback(!page.noisePlaying)
            }
            Item { Layout.fillWidth: true }
            MButton {
                text: "导出 CSV"
                icon: "export"
                enabled: page.ambientRows.length > 0 || page.lastCsvPath.length > 0
                onClicked: page.exportAmbientCsv()
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 12
            MStat {
                label: "误唤醒"
                value: String(page.testMode === "ambient" ? page.ambientRows.length
                    : (page.wakeEndInfo.noise ? (page.wakeEndInfo.falseAlarms || 0) : page.ambientRows.length))
                tone: page.ambientRows.length > 0 ? Theme.red : Theme.green
                unit: "次"
            }
            MStat {
                label: "事件记录"
                value: String(page.ambientRows.length)
                tone: Theme.text
                unit: "条"
            }
            MStat {
                label: "误唤醒率"
                value: page.ambientRate()
                unit: "次/分"
                tone: page.ambientRows.length > 0 ? Theme.orange : Theme.green
            }
            MStat {
                label: "测试时长"
                value: page.testMode === "ambient" ? page.countdown : Ipc.fmtDuration(page.ambientElapsedMs)
                unit: page.testMode === "ambient" ? "s 剩余" : ""
                tone: Theme.textDim
            }
            MStat {
                label: "最高分"
                value: page.maxScore()
                tone: Theme.orange
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 196
            radius: 8
            color: Theme.insetBg
            clip: true

            Column {
                anchors.fill: parent
                anchors.margins: 8
                spacing: 0

                RowLayout {
                    width: parent.width
                    height: 24
                    spacing: 0
                    Text {
                        text: "时间"
                        Layout.preferredWidth: 90
                        color: Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsTiny
                    }
                    Text {
                        text: "分数"
                        Layout.preferredWidth: 70
                        color: Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsTiny
                    }
                    Text {
                        text: "KWS 命中"
                        Layout.preferredWidth: 90
                        color: Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsTiny
                    }
                    Text {
                        text: "误触发"
                        Layout.preferredWidth: 80
                        color: Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsTiny
                    }
                    Text {
                        text: "延迟"
                        Layout.fillWidth: true
                        color: Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsTiny
                    }
                }
                Rectangle {
                    width: parent.width
                    height: 1
                    color: Theme.separator
                    opacity: 0.6
                }

                ListView {
                    id: rowsList
                    width: parent.width
                    height: Math.min(158, page.ambientRows.length * 26)
                    model: page.ambientRows
                    boundsBehavior: Flickable.StopAtBounds
                    clip: true

                    delegate: Item {
                        required property var modelData
                        width: rowsList.width
                        height: 26

                        RowLayout {
                            anchors.fill: parent
                            spacing: 0
                            Text {
                                text: Ipc.fmtClock(modelData.t)
                                Layout.preferredWidth: 90
                                color: Theme.textDim
                                font.family: Theme.fontSans
                                font.pixelSize: Theme.fsSmall
                            }
                            Text {
                                text: Number(modelData.score).toFixed(2)
                                Layout.preferredWidth: 70
                                color: modelData.score > 0.8 ? Theme.red : Theme.text
                                font.family: Theme.fontSans
                                font.pixelSize: Theme.fsSmall
                            }
                            Text {
                                text: "是"
                                Layout.preferredWidth: 90
                                color: Theme.text
                                font.family: Theme.fontSans
                                font.pixelSize: Theme.fsSmall
                            }
                            Text {
                                text: "是"
                                Layout.preferredWidth: 80
                                color: Theme.red
                                font.family: Theme.fontSans
                                font.pixelSize: Theme.fsSmall
                                font.weight: Font.DemiBold
                            }
                            Text {
                                text: (modelData.latencyMs || 0) + " ms"
                                Layout.fillWidth: true
                                color: Theme.textFaint
                                font.family: Theme.fontSans
                                font.pixelSize: Theme.fsSmall
                            }
                        }
                        Rectangle {
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.bottom: parent.bottom
                            height: 1
                            color: Theme.separator
                            opacity: 0.3
                        }
                    }
                }

                Text {
                    visible: page.ambientRows.length === 0
                    width: parent.width
                    height: 40
                    verticalAlignment: Text.AlignVCenter
                    horizontalAlignment: Text.AlignHCenter
                    text: page.testMode === "ambient"
                        ? "监听中… 播放音乐或白噪音，命中会实时出现在这里"
                        : "还没有数据。点「开始统计」并播放背景声音。"
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                }
            }
        }

        Text {
            Layout.fillWidth: true
            text: page.lastCsvPath.length > 0
                ? "CSV 已导出：" + page.lastCsvPath
                : "没有音频设备时，「播放白噪音」会自动降级——用手机或音乐软件放歌同样有效。"
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WordWrap
        }
    }
}
