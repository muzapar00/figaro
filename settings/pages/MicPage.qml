import QtQuick
import QtQuick.Layouts
import Quickshell.Io
import ".."
import "../components"

MPageScroll {
    id: page

    // ---- config drafts -----------------------------------------------------
    property string device: "default"
    property string draftDevice: "default"
    property int gainPercent: 40
    property bool gainIsAuto: false

    // ---- live meter --------------------------------------------------------
    property bool monitoring: false
    property bool measuring: false
    property bool measureAutoApply: false

    // ---- noise floor result ------------------------------------------------
    property real noiseRms: -1
    property real noisePeak: -1
    property int suggestedGain: -1
    property double measureStartedAt: 0
    property string measureError: ""

    readonly property bool micSupported: !Ipc.unsupported("test.mic.start")
    readonly property var micInfo: (Ipc.diagnostics.mic || ({}))

    function syncFromConfig() {
        const dev = Ipc.cfg("asr.device", "default");
        page.device = String(dev === null || dev === undefined || dev === "" ? "default" : dev);
        page.draftDevice = page.device;
        const gain = Ipc.cfg("asr.inputGainPercent", 40);
        page.gainIsAuto = gain === null || gain === undefined;
        page.gainPercent = page.gainIsAuto ? 40 : Number(gain);
    }

    function levelText() {
        return Ipc.micRunning || Ipc.micSampleCount > 0 ? Ipc.micSampleCount + " 帧 @20Hz" : "未开始";
    }

    function startMonitor() {
        page.monitoring = true;
        page.measuring = false;
        Ipc.micStart(10000);
        return "mic-monitor-started";
    }

    function stopMonitor() {
        page.monitoring = false;
        page.measuring = false;
        Ipc.micStop();
        return "mic-monitor-stopped";
    }

    function measureNoiseFloor() {
        page.measuring = true;
        page.measureAutoApply = false;
        page.monitoring = false;
        page.noiseRms = -1;
        page.noisePeak = -1;
        page.suggestedGain = -1;
        page.measureError = "";
        page.measureStartedAt = Date.now();
        Ipc.micStart(3000);
        return "noise-measure-started";
    }

    function autoCalibrate() {
        page.measuring = true;
        page.measureAutoApply = true;
        page.monitoring = false;
        page.noiseRms = -1;
        page.noisePeak = -1;
        page.suggestedGain = -1;
        page.measureError = "";
        page.measureStartedAt = Date.now();
        Ipc.micStart(3000);
        return "auto-calibrate-started";
    }

    function finishNoiseMeasurement() {
        if (!page.measuring) return;
        page.measuring = false;
        const samples = Ipc.micSamples || [];
        if (samples.length === 0) {
            page.measureError = "没有采到样本，请重新测量";
            return;
        }
        let sum = 0;
        let peak = 0;
        for (let i = 0; i < samples.length; i++) {
            sum += samples[i];
            peak = Math.max(peak, samples[i]);
        }
        const avg = sum / samples.length;
        page.noiseRms = avg;
        page.noisePeak = peak;
        // Aim the *noise floor* at ~2% RMS: quiet enough not to trip the KWS,
        // loud enough that a normal voice stays well above it.
        const current = Math.max(1, page.gainPercent);
        const suggested = Math.max(0, Math.min(100, Math.round(current * (0.02 / Math.max(avg, 0.0015)))));
        page.suggestedGain = suggested;
        if (page.measureAutoApply) {
            page.gainPercent = suggested;
            page.gainIsAuto = false;
            Ipc.applyPatch({ asr: { inputGainPercent: suggested } });
        }
    }

    function applyGain(value) {
        page.gainPercent = Math.round(value);
        page.gainIsAuto = false;
        Ipc.applyPatch({ asr: { inputGainPercent: page.gainPercent } });
    }

    function applySuggestedGain() {
        if (page.suggestedGain < 0) return;
        page.applyGain(page.suggestedGain);
    }

    function snapshot() {
        return {
            title: "麦克风",
            device: page.device,
            gainPercent: page.gainPercent,
            gainIsAuto: page.gainIsAuto,
            monitoring: page.monitoring,
            measuring: page.measuring,
            micSupported: page.micSupported,
            sampleCount: Ipc.micSampleCount,
            lastRms: Ipc.mic.rms !== undefined ? Ipc.mic.rms : null,
            lastPeak: Ipc.mic.peak !== undefined ? Ipc.mic.peak : null,
            clipped: Ipc.micClipped,
            noiseRms: page.noiseRms,
            suggestedGain: page.suggestedGain,
        };
    }

    Connections {
        target: Ipc
        function onConfigChanged() { page.syncFromConfig(); }
        function onCapabilitiesChanged() {
            if (Ipc.unsupported("test.mic.start")) {
                page.monitoring = false;
                page.measuring = false;
            }
            if (Ipc.unsupported("config.get")) page.syncFromConfig();
        }
        function onMicEndSeqChanged() {
            if (page.measuring) {
                // A stop() from the previous test can deliver a stray mic.end
                // right after we start measuring: ignore anything that arrives
                // well before our own 3 s window is over.
                const elapsed = Date.now() - page.measureStartedAt;
                if (elapsed < 2400) return;
                page.finishNoiseMeasurement();
                return;
            }
            if (page.monitoring && Ipc.connected) Ipc.micStart(10000);
        }
    }

    Component.onCompleted: page.syncFromConfig()

    MPageHeader {
        title: "麦克风"
        subtitle: "输入设备、实时电平、增益校准与底噪测量"
        icon: "mic"
    }

    MCard {
        title: "输入"

        MRow {
            label: "输入设备"
            subtitle: "写入 asr.device · default = 系统默认输入"
            RowLayout {
                spacing: 8
                MTextField {
                    inputWidth: 190
                    text: page.draftDevice
                    placeholder: "default"
                }
                MButton {
                    text: "应用"
                    onClicked: {
                        page.device = page.draftDevice.trim().length > 0 ? page.draftDevice.trim() : "default";
                        Ipc.applyPatch({ asr: { device: page.device } });
                    }
                }
            }
        }
        MRow {
            label: "增益"
            subtitle: page.gainIsAuto
                ? "自动校准模式（asr.inputGainPercent = null）"
                : "固定 " + page.gainPercent + "%（写 asr.inputGainPercent）"
            RowLayout {
                spacing: 8
                Text {
                    text: page.gainIsAuto ? "自动" : page.gainPercent + "%"
                    color: Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    Layout.preferredWidth: 52
                    horizontalAlignment: Text.AlignRight
                }
                MSlider {
                    Layout.preferredWidth: 150
                    from: 0
                    to: 100
                    value: page.gainPercent
                    onMoved: (v) => page.applyGain(v)
                }
            }
        }
        MRow {
            label: "自动校准"
            subtitle: "静音 3 秒测底噪，按 2% RMS 目标自动设置增益"
            showSeparator: false
            RowLayout {
                spacing: 8
                MButton {
                    text: page.measuring && page.measureAutoApply ? "校准中…" : "自动校准"
                    icon: "refresh"
                    primary: true
                    enabled: Ipc.connected && page.micSupported && !page.measuring
                    onClicked: page.autoCalibrate()
                }
                MButton {
                    text: "恢复自动"
                    enabled: Ipc.connected && !page.gainIsAuto
                    onClicked: Ipc.applyPatch({ asr: { inputGainPercent: null } })
                }
            }
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

    MCard {
        title: "实时电平"
        subtitle: "test.mic.start 的 20Hz rms/peak 流 · 削波时增益过高"

        Rectangle {
            visible: !page.micSupported
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
                    text: "当前 daemon 不支持此功能（test.mic.start 未响应）。"
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
                text: page.monitoring ? "停止监听" : "开始实时监听"
                icon: page.monitoring ? "stop" : "play"
                primary: !page.monitoring
                enabled: Ipc.connected && page.micSupported
                onClicked: page.monitoring ? page.stopMonitor() : page.startMonitor()
            }
            MPill {
                text: page.monitoring ? "监听中" : (Ipc.micSampleCount > 0 ? "已停止" : "未开始")
                tone: page.monitoring ? Theme.green : Theme.textDim
            }
            MPill {
                visible: Ipc.micClipped
                text: "削波！增益过高"
                tone: Theme.red
            }
            Item { Layout.fillWidth: true }
            Text {
                text: page.levelText()
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }

        MLevelMeter {
            Layout.fillWidth: true
            Layout.preferredHeight: 22
            level: Ipc.mic.level !== undefined ? Ipc.mic.level : 0
            peak: Ipc.mic.peak !== undefined ? Ipc.mic.peak : 0
            clipped: Ipc.micClipped
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 20
            Text {
                text: "RMS  " + (Ipc.mic.rms !== undefined ? Number(Ipc.mic.rms).toFixed(3) : "—")
                color: Theme.text
                font.family: "JetBrains Mono, Inter, " + Theme.fontCJK
                font.pixelSize: Theme.fsSmall
            }
            Text {
                text: "PEAK  " + (Ipc.mic.peak !== undefined ? Number(Ipc.mic.peak).toFixed(3) : "—")
                color: Ipc.micClipped ? Theme.red : Theme.textDim
                font.family: "JetBrains Mono, Inter, " + Theme.fontCJK
                font.pixelSize: Theme.fsSmall
            }
            Item { Layout.fillWidth: true }
            Text {
                text: "诊断增益：" + (page.micInfo.gainPercent !== undefined && page.micInfo.gainPercent !== null
                    ? page.micInfo.gainPercent + "%" : "自动")
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
    }

    MAdvancedCard {
        title: "高级 · 底噪测量"
        subtitle: "保持安静 3 秒，测出环境底噪并给出建议增益"

        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            MButton {
                text: page.measuring ? "测量中…" : "静音 3 秒测量"
                icon: "record"
                primary: true
                enabled: Ipc.connected && page.micSupported && !page.measuring
                onClicked: page.measureNoiseFloor()
            }
            MButton {
                text: "应用建议增益"
                icon: "check"
                enabled: page.suggestedGain >= 0
                onClicked: page.applySuggestedGain()
            }
            Item { Layout.fillWidth: true }
            Text {
                text: page.measuring ? "采样中，请保持安静…"
                    : page.measureError.length > 0 ? page.measureError
                    : (page.noiseRms >= 0 ? "测量完成" : "尚未测量")
                color: page.measuring ? Theme.accent : Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 12
            MStat {
                label: "环境 RMS"
                value: page.noiseRms >= 0 ? Number(page.noiseRms).toFixed(3) : "—"
                tone: Theme.text
            }
            MStat {
                label: "环境峰值"
                value: page.noisePeak >= 0 ? Number(page.noisePeak).toFixed(3) : "—"
                tone: Theme.text
            }
            MStat {
                label: "当前增益"
                value: page.gainIsAuto ? "自动" : String(page.gainPercent)
                unit: page.gainIsAuto ? "" : "%"
                tone: Theme.accent
            }
            MStat {
                label: "建议增益"
                value: page.suggestedGain >= 0 ? String(page.suggestedGain) + "%" : "—"
                tone: Theme.green
                hint: "目标：底噪 ≈ 2% RMS"
            }
        }

        Text {
            Layout.fillWidth: true
            text: "说明：底噪长期高于 5% 时唤醒词分数会被噪声抬高，容易出现误唤醒；"
                + "建议降低增益或使用带降噪的麦克风。"
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WordWrap
        }
    }
}
