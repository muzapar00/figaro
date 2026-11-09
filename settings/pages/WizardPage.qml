import QtQuick
import QtQuick.Layouts
import ".."
import "../components"

// 引导式测试向导：嫌界面太复杂的用户只走这 5 步。
// ① 环境安静 ② 麦克风增益 ③ 唤醒词 ④ 一句话转写 ⑤ 音色试听
MPageScroll {
    id: page

    signal goOverview()

    readonly property int totalSteps: 5
    readonly property var stepTitles: ["安静检查", "麦克风增益", "唤醒词", "一句话转写", "音色试听"]
    readonly property var stepIcons: ["mic", "sliders", "wake", "text", "speaker"]
    readonly property var stepHints: [
        "先确认房间安静：保持 3 秒不出声，我们会测一下环境底噪。",
        "让麦克风音量合适：点一下自动校准，3 秒内保持安静即可。",
        "对着麦克风说「费加罗」，命中一次就通过。",
        "随便说一句话，看看流式转写和最终结果。",
        "播放一句费加罗的声音，确认扬声器正常。",
    ]

    property int step: 0                     // 0..4, 5 = 完成
    property var results: ["pending", "pending", "pending", "pending", "pending"]
    property string statusText: "准备好了就开始。"
    property real stepStartedAt: 0
    property real noiseRms: -1
    property int suggestedGain: -1
    property real wakeLatency: -1
    property real wakeScore: -1
    property string asrFinalText: ""
    property real asrAccuracy: -1

    readonly property bool running: results[page.step] === "running"
    readonly property bool allPassed: {
        for (let i = 0; i < page.results.length; i++)
            if (page.results[i] !== "pass" && page.results[i] !== "skipped") return false;
        return true;
    }

    function setResult(index, value, message) {
        const next = page.results.slice(0);
        next[index] = value;
        page.results = next;
        if (message !== undefined) page.statusText = message;
        if (value === "pass") page.statusText = "通过 ✓ " + page.statusText;
    }

    function resetWizard() {
        page.stopCurrentTest();
        page.step = 0;
        page.results = ["pending", "pending", "pending", "pending", "pending"];
        page.statusText = "准备好了就开始。";
        page.noiseRms = -1;
        page.suggestedGain = -1;
        page.wakeLatency = -1;
        page.wakeScore = -1;
        page.asrFinalText = "";
        page.asrAccuracy = -1;
        return "wizard-reset";
    }

    function startWizard() {
        page.resetWizard();
        return "wizard-started";
    }

    function runCurrentStep() {
        const index = page.step;
        if (index >= page.totalSteps) return "finished";
        page.stepStartedAt = Date.now();
        page.setResult(index, "running", "");
        page.statusText = "测试中…";
        if (index === 0 || index === 1) {
            Ipc.micStart(3000);
        } else if (index === 2) {
            page.wakeLatency = -1;
            page.wakeScore = -1;
            Ipc.wakeArm(12000, false);
        } else if (index === 3) {
            page.asrFinalText = "";
            page.asrAccuracy = -1;
            Ipc.asrStart();
        } else if (index === 4) {
            Ipc.ttsTest("你好，我是费加罗。", Ipc.cfg("tts.voiceId", ""));
        }
        return "wizard-step-" + index + "-running";
    }

    function stopCurrentTest() {
        if (page.step === 2 && Ipc.wakeArmed) Ipc.wakeDisarm();
        if (Ipc.micRunning) Ipc.micStop();
        if (Ipc.asrRunning) Ipc.asrStop();
    }

    function skipStep() {
        if (page.step >= page.totalSteps) return "finished";
        page.stopCurrentTest();
        page.setResult(page.step, "skipped", "已跳过。");
        if (page.step < page.totalSteps - 1) page.step += 1;
        else page.step = page.totalSteps;
        return "wizard-skipped";
    }

    function nextStep() {
        if (page.step >= page.totalSteps) return "finished";
        if (page.results[page.step] === "running") page.stopCurrentTest();
        if (page.step < page.totalSteps - 1) {
            page.step += 1;
            page.statusText = "第 " + (page.step + 1) + " 步：" + page.stepTitles[page.step];
        } else {
            page.step = page.totalSteps;
        }
        return "wizard-step-" + page.step;
    }

    function retryStep() {
        page.setResult(page.step, "pending", "");
        page.statusText = "可以再试一次。";
    }

    function finishWizardSummary() {
        page.step = page.totalSteps;
        page.statusText = page.allPassed ? "全部通过 ✓ 费加罗已经准备好了。" : "部分步骤未通过，可重来或跳过。";
    }

    function resultTone(state) {
        switch (state) {
        case "pass": return Theme.green;
        case "fail": return Theme.red;
        case "running": return Theme.accent;
        case "skipped": return Theme.orange;
        default: return Theme.textDim;
        }
    }
    function resultLabel(state) {
        switch (state) {
        case "pass": return "通过";
        case "fail": return "未通过";
        case "running": return "测试中…";
        case "skipped": return "已跳过";
        default: return "未开始";
        }
    }

    function normalise(text) {
        return String(text || "").replace(/[\s，。！？、,.!?;；:：""''（）()《》\-—…·]/g, "");
    }
    function accuracy(text) {
        const ref = page.normalise("费加罗，帮我打开设置面板，把灵敏度调到低档");
        const hyp = page.normalise(text);
        if (ref.length === 0 || hyp.length === 0) return -1;
        const m = ref.length;
        const n = hyp.length;
        let prev = [];
        let cur = [];
        for (let j = 0; j <= n; j++) prev[j] = j;
        for (let i = 1; i <= m; i++) {
            cur[0] = i;
            for (let j = 1; j <= n; j++) {
                const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
                cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            }
            const tmp = prev;
            prev = cur;
            cur = tmp;
        }
        return Math.max(0, 1 - prev[n] / ref.length);
    }

    function snapshot() {
        return {
            title: "引导测试",
            step: page.step,
            results: page.results,
            allPassed: page.allPassed,
            statusText: page.statusText,
            noiseRms: page.noiseRms,
            suggestedGain: page.suggestedGain,
            wakeLatency: page.wakeLatency,
            asrFinalText: page.asrFinalText,
            asrAccuracy: page.asrAccuracy,
            ttsMs: Ipc.ttsResult.ms !== undefined ? Ipc.ttsResult.ms : -1,
        };
    }

    Connections {
        target: Ipc
        function onMicEndSeqChanged() {
            if (page.step !== 0 && page.step !== 1) return;
            if (page.results[page.step] !== "running") return;
            // Ipc.micStart() resets the sequence counter, which fires this
            // signal immediately; ignore that stray edge and wait for our
            // real 3 s window to finish.
            if (Date.now() - page.stepStartedAt < 1500) return;
            const samples = Ipc.micSamples || [];
            if (samples.length < 10) {
                page.setResult(page.step, "fail", "没有采到足够样本，请再试一次。");
                return;
            }
            let sum = 0;
            for (let i = 0; i < samples.length; i++) sum += samples[i];
            const avg = sum / samples.length;
            if (page.step === 0) {
                page.noiseRms = avg;
                if (avg <= 0.08) page.setResult(0, "pass", "环境底噪 " + avg.toFixed(3) + "，足够安静。");
                else page.setResult(0, "fail", "底噪偏高（" + avg.toFixed(3) + "），建议先关掉音乐/风扇或降低增益。");
            } else {
                const gain = Math.max(1, Number(Ipc.cfg("asr.inputGainPercent", 40)));
                const suggested = Math.max(0, Math.min(63, Math.round(gain * (0.02 / Math.max(avg, 0.0015)))));
                page.suggestedGain = suggested;
                Ipc.writeField("asr.inputGainPercent", suggested);
                page.setResult(1, "pass", "环境 RMS " + avg.toFixed(3) + "，建议增益 " + suggested + "%（已写入）。");
            }
        }

        function onWakeHitSeqChanged() {
            if (page.step !== 2 || page.results[2] !== "running") return;
            const hits = Ipc.wakeHits || [];
            if (hits.length === 0) return;
            const hit = hits[hits.length - 1];
            page.wakeLatency = hit.latencyMs;
            page.wakeScore = hit.score;
            Ipc.wakeDisarm();
            page.setResult(2, "pass", "命中「" + Ipc.wakeKeyword + "」 · 分数 " + Number(hit.score).toFixed(2)
                + " · 延迟 " + hit.latencyMs + "ms");
        }

        function onWakeEndChanged() {
            if (page.step !== 2 || page.results[2] !== "running") return;
            const end = Ipc.wakeEnd || ({});
            // Ipc.wakeArm() resets wakeEnd to {} (which fires this signal);
            // only a real test.wake.end means the window really finished.
            if (end.type !== "test.wake.end") return;
            page.setResult(2, "fail", "这次没听到「费加罗」，靠近麦克风再说一次。");
        }

        function onAsrResultChanged() {
            if (page.step !== 3 || page.results[3] !== "running") return;
            const result = Ipc.asrResult || ({});
            if (result.text === undefined) return;
            const text = String(result.text || "");
            if (text.length === 0) {
                page.setResult(3, "fail", "没有识别出内容，请再说一句。");
                return;
            }
            page.asrFinalText = text;
            const acc = page.accuracy(text);
            page.asrAccuracy = acc;
            page.setResult(3, "pass", "识别到：" + text + (acc >= 0 ? "（字级正确率 " + (acc * 100).toFixed(1) + "%）" : ""));
        }

        function onTtsResultChanged() {
            if (page.step !== 4 || page.results[4] !== "running") return;
            const result = Ipc.ttsResult || ({});
            if (result.ms === undefined) return;
            if (result.ok === false) page.setResult(4, "fail", "试听失败：" + (result.error || "TTS 返回失败"));
            else page.setResult(4, "pass", "试听成功，首字延迟 " + result.ms + "ms。");
        }

        function onConfigChanged() {
            // nothing: wizard only reads a couple of defaults through cfg()
        }
    }

    MPageHeader {
        title: "引导测试"
        subtitle: "5 步搞定：安静检查 → 增益 → 唤醒 → 转写 → 试听"
        icon: "wand"
    }

    // ---- progress ----
    MCard {
        MRow {
            label: page.step >= page.totalSteps
                ? "全部完成"
                : "第 " + (page.step + 1) + " 步 / 共 " + page.totalSteps + " 步"
            subtitle: page.step >= page.totalSteps ? "可以重来或回到概览" : page.stepTitles[page.step]
            visible: false
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 4
            Repeater {
                model: page.totalSteps
                Item {
                    required property int index
                    Layout.fillWidth: true
                    implicitHeight: 44
                    Rectangle {
                        anchors.horizontalCenter: parent.horizontalCenter
                        y: 2
                        width: 26
                        height: 26
                        radius: 13
                        color: page.results[index] === "pass" ? Theme.green
                            : page.results[index] === "fail" ? Theme.red
                            : page.results[index] === "running" ? Theme.accent
                            : (page.step === index ? Theme.controlBgActive : Theme.insetBg)
                        border.width: page.step === index ? 2 : 0
                        border.color: Theme.accent
                        Text {
                            anchors.centerIn: parent
                            text: page.results[index] === "pass" ? "✓"
                                : page.results[index] === "fail" ? "!"
                                : String(index + 1)
                            color: "#ffffff"
                            font.family: Theme.fontSans
                            font.pixelSize: Theme.fsSmall
                            font.weight: Font.DemiBold
                        }
                    }
                    Text {
                        anchors.top: parent.top
                        anchors.topMargin: 32
                        anchors.horizontalCenter: parent.horizontalCenter
                        text: page.stepTitles[index]
                        color: page.step === index ? Theme.text : Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsTiny
                    }
                }
            }
        }
    }

    // ---- current step card ----
    MCard {
        visible: page.step < page.totalSteps
        title: page.step < page.totalSteps ? "第 " + (page.step + 1) + " 步 · " + page.stepTitles[page.step] : ""
        subtitle: page.step < page.totalSteps ? page.stepHints[page.step] : ""

        RowLayout {
            Layout.fillWidth: true
            spacing: 10
            Rectangle {
                width: 44
                height: 44
                radius: 12
                color: Qt.rgba(0.04, 0.52, 1.0, 0.18)
                MIcon {
                    anchors.centerIn: parent
                    kind: page.step < page.totalSteps ? page.stepIcons[page.step] : "check"
                    size: 22
                    color: Theme.accent
                }
            }
            Item { Layout.fillWidth: true }
            MPill {
                text: page.step < page.totalSteps ? page.resultLabel(page.results[page.step]) : "完成"
                tone: page.step < page.totalSteps ? page.resultTone(page.results[page.step]) : Theme.green
            }
        }

        // ------- step-specific live views -------
        // step 0/1: mic level
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6
            visible: page.step === 0 || page.step === 1
            MLevelMeter {
                Layout.fillWidth: true
                Layout.preferredHeight: 20
                level: Ipc.mic.level !== undefined ? Ipc.mic.level : 0
                peak: Ipc.mic.peak !== undefined ? Ipc.mic.peak : 0
                clipped: Ipc.micClipped
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 16
                Text {
                    text: "RMS " + (Ipc.mic.rms !== undefined ? Number(Ipc.mic.rms).toFixed(3) : "—")
                    color: Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                }
                Text {
                    text: page.noiseRms >= 0 ? "环境底噪 " + page.noiseRms.toFixed(3) : ""
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                }
                Text {
                    text: page.suggestedGain >= 0 ? "建议增益 " + page.suggestedGain + "%" : ""
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                }
                Item { Layout.fillWidth: true }
            }
        }

        // step 2: wake score
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6
            visible: page.step === 2
            MSparkline {
                Layout.fillWidth: true
                Layout.preferredHeight: 54
                scores: Ipc.wakeScores
                threshold: 0.8
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 16
                Text {
                    text: "KWS 分数 " + (Ipc.wakeScore > 0 ? Ipc.wakeScore.toFixed(2) : "—")
                    color: Ipc.wakeScore > 0.8 ? Theme.red : Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                }
                Text {
                    text: "命中 " + (Ipc.wakeHits ? Ipc.wakeHits.length : 0) + " 次"
                    color: Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                }
                Text {
                    text: page.wakeLatency >= 0 ? "延迟 " + Math.round(page.wakeLatency) + "ms" : ""
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                }
                Item { Layout.fillWidth: true }
            }
        }

        // step 3: streaming + final
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6
            visible: page.step === 3
            Rectangle {
                Layout.fillWidth: true
                implicitHeight: 64
                radius: 8
                color: Theme.insetBg
                clip: true
                Column {
                    anchors.fill: parent
                    anchors.margins: 8
                    spacing: 2
                    Text {
                        text: "流式 partial"
                        color: Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsTiny
                    }
                    Text {
                        width: parent.width
                        text: Ipc.asrPartials && Ipc.asrPartials.length > 0
                            ? Ipc.asrPartials[Ipc.asrPartials.length - 1].text : "（开始后这里会出现中间结果）"
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsSmall
                        elide: Text.ElideRight
                    }
                }
            }
            Rectangle {
                Layout.fillWidth: true
                implicitHeight: page.asrFinalText.length > 0 ? 52 : 0
                visible: page.asrFinalText.length > 0
                radius: 8
                color: Theme.insetBg
                Text {
                    anchors.fill: parent
                    anchors.margins: 8
                    text: page.asrFinalText
                    color: Theme.text
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    wrapMode: Text.WordWrap
                }
            }
        }

        // step 4: tts result
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 4
            visible: page.step === 4
            Text {
                text: Ipc.ttsResult.ms !== undefined
                    ? (Ipc.ttsResult.ok === false ? "试听失败：" + (Ipc.ttsResult.error || "")
                        : "试听成功 · 首字延迟 " + Ipc.ttsResult.ms + "ms")
                    : (Ipc.ttsRunning ? "正在合成并播放…" : "点下面的按钮播放一句。")
                color: Ipc.ttsResult.ok === false ? Theme.red : Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
                wrapMode: Text.WordWrap
            }
        }

        // ------- result + actions -------
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            MButton {
                text: page.results[page.step] === "running" ? "测试中…" : "开始这一步"
                icon: "play"
                primary: true
                enabled: page.results[page.step] !== "running" && Ipc.connected
                onClicked: page.runCurrentStep()
            }
            MButton {
                text: "重新测试"
                icon: "refresh"
                enabled: page.results[page.step] !== "running" && page.results[page.step] !== "pending"
                onClicked: {
                    page.retryStep();
                    page.runCurrentStep();
                }
            }
            Item { Layout.fillWidth: true }
            MButton {
                text: "跳过此步"
                enabled: page.results[page.step] !== "running"
                onClicked: page.skipStep()
            }
            MButton {
                text: page.step === page.totalSteps - 1 ? "完成" : "下一步 →"
                primary: page.results[page.step] === "pass" || page.results[page.step] === "skipped" || page.results[page.step] === "fail"
                enabled: page.results[page.step] === "pass" || page.results[page.step] === "skipped" || page.results[page.step] === "fail"
                onClicked: {
                    if (page.step === page.totalSteps - 1) page.finishWizardSummary();
                    else page.nextStep();
                }
            }
        }

        Text {
            Layout.fillWidth: true
            text: page.statusText
            color: page.results[page.step] === "fail" ? Theme.red
                : page.results[page.step] === "pass" ? Theme.green : Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: Text.WordWrap
        }
    }

    // ---- summary ----
    MCard {
        visible: page.step >= page.totalSteps
        title: page.allPassed ? "全部通过 ✓" : "引导结束"

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6
            Repeater {
                model: page.totalSteps
                RowLayout {
                    required property int index
                    Layout.fillWidth: true
                    spacing: 10
                    MIcon {
                        kind: page.results[index] === "pass" ? "check"
                            : page.results[index] === "fail" ? "close" : "minus"
                        size: 14
                        color: page.resultTone(page.results[index])
                    }
                    Text {
                        Layout.fillWidth: true
                        text: (index + 1) + ". " + page.stepTitles[index]
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsSmall
                    }
                    MPill {
                        text: page.resultLabel(page.results[index])
                        tone: page.resultTone(page.results[index])
                    }
                }
            }
        }
        Text {
            Layout.fillWidth: true
            text: page.allPassed
                ? "费加罗已经准备好了：麦克风、唤醒词、转写和扬声器都工作正常。"
                : "有步骤未通过：可以点「重来」再走一遍，或回到对应页面手动调整。"
            color: page.allPassed ? Theme.green : Theme.orange
            font.family: Theme.fontSans
            font.pixelSize: Theme.fs
            wrapMode: Text.WordWrap
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            MButton {
                text: "重来一遍"
                icon: "refresh"
                onClicked: page.startWizard()
            }
            MButton {
                text: "回到概览"
                onClicked: page.goOverview()
            }
            Item { Layout.fillWidth: true }
        }
    }
}
