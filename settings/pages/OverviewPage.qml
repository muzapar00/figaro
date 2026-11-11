import QtQuick
import QtQuick.Layouts
import ".."
import "../components"

MPageScroll {
    id: page

    signal startWizard()

    readonly property var diag: Ipc.diagnostics || ({})
    readonly property bool hasDiag: Ipc.diagnosticsLoaded && Ipc.supported("diagnostics")
    readonly property var asrInfo: (page.diag.asr || ({}))
    readonly property var ttsInfo: (page.diag.tts || ({}))
    readonly property var ackInfo: (page.diag.ack || ({}))
    readonly property var micInfo: (page.diag.mic || ({}))
    readonly property var latency: (page.diag.latency || ({}))

    function asrModelText() {
        if (page.asrInfo.model !== undefined && page.asrInfo.model !== null)
            return String(page.asrInfo.model);
        const mi = page.asrInfo.modelInfo || ({});
        const parts = [];
        if (mi.offline) parts.push(I18n.t("离线 ") + String(mi.offline));
        if (mi.streaming) parts.push(I18n.t("流式"));
        if (mi.kws) parts.push("KWS");
        if (parts.length === 0) return "—";
        return parts.join(" · ");
    }

    // The real daemon (src/agent/settings.js) reports latency under different
    // names than the older fake; read both, prefer the documented diagnostics.
    function positiveNumber(value) {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : undefined;
    }
    function wakeToAckMs() {
        return page.positiveNumber(page.latency.wakeToAckMs)
            ?? page.positiveNumber(page.latency.ackLastFirstWriteMs)
            ?? page.positiveNumber(page.latency.ackLastPlayDurationMs);
    }
    function ttsFirstMs() {
        return page.positiveNumber(page.latency.ttsFirstAudioMs)
            ?? page.positiveNumber(page.latency.ttsRequestToFirstAudioMs)
            ?? page.positiveNumber(page.latency.ttsFirstByteMs);
    }
    function asrFinalMs() {
        return page.positiveNumber(page.latency.asrLastFinalMs)
            ?? page.positiveNumber(page.latency.asrFinalMs);
    }

    function stateText(s) {
        switch (s) {
        case "listening": return I18n.t("倾听中");
        case "thinking": return I18n.t("思考中");
        case "speaking": return I18n.t("播报中");
        default: return I18n.t("空闲");
        }
    }

    function snapshot() {
        return {
            title: I18n.t("概览"),
            diagnosticsLoaded: Ipc.diagnosticsLoaded,
            diagnosticsSupported: Ipc.supported("diagnostics"),
            version: page.diag.version || "",
            uptimeMs: page.diag.uptimeMs || 0,
            latency: page.latency,
            asrAvailable: page.asrInfo.available === undefined ? null : !!page.asrInfo.available,
            ttsAvailable: page.ttsInfo.available === undefined ? null : !!page.ttsInfo.available,
            ackEnabled: page.ackInfo.enabled === undefined ? null : !!page.ackInfo.enabled,
        };
    }

    MPageHeader {
        title: I18n.t("概览")
        subtitle: I18n.t("费加罗语音助手 · 运行状态与语音能力")
        icon: "overview"
    }

    // Unsupported daemon banner (§3.1 not implemented on this build).
    MCard {
        visible: Ipc.unsupported("diagnostics") || Ipc.unsupported("config.get")
        Rectangle {
            Layout.fillWidth: true
            radius: 8
            color: Qt.rgba(1.0, 0.84, 0.04, 0.10)
            border.width: 0.5
            border.color: Qt.rgba(1.0, 0.84, 0.04, 0.35)
            implicitHeight: notice.implicitHeight + 20
            RowLayout {
                id: notice
                anchors.fill: parent
                anchors.margins: 10
                spacing: 8
                MIcon { kind: "warning"; size: 16; color: Theme.yellow }
                Text {
                    Layout.fillWidth: true
                    text: I18n.t("当前 daemon 不支持 §3.1 诊断接口（diagnostics / config.get 未响应）。")
                        + I18n.t("下面的状态来自 §3 基础协议，调参与自测功能不可用。")
                    color: Theme.yellow
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    wrapMode: Text.WordWrap
                    lineHeight: 1.25
                }
            }
        }
    }

    // ------------------------------------------------------ 引导测试入口
    MCard {
        Rectangle {
            Layout.fillWidth: true
            implicitHeight: 84
            radius: 10
            color: Qt.rgba(0.04, 0.52, 1.0, 0.14)
            border.width: 0.5
            border.color: Qt.rgba(0.04, 0.52, 1.0, 0.35)

            RowLayout {
                anchors.fill: parent
                anchors.margins: 14
                spacing: 12
                Rectangle {
                    width: 40
                    height: 40
                    radius: 12
                    color: Theme.accent
                    MIcon { anchors.centerIn: parent; kind: "wand"; size: 20; color: "#ffffff" }
                }
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2
                    Text {
                        Layout.fillWidth: true
                        text: I18n.t("第一次用？跟着引导走一遍")
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 15
                        font.weight: Font.DemiBold
                    }
                    Text {
                        Layout.fillWidth: true
                        text: I18n.t("5 步测完麦克风、增益、唤醒、转写和扬声器，每步都有提示。")
                        color: Theme.textDim
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsSmall
                        wrapMode: Text.WordWrap
                    }
                }
                MButton {
                    text: I18n.t("开始引导测试 →")
                    icon: "play"
                    primary: true
                    onClicked: page.startWizard()
                }
            }
        }
    }

    // ------------------------------------------------------------ 服务状态
    MCard {
        title: I18n.t("服务状态")

        MRow {
            label: I18n.t("连接")
            MPill {
                text: Ipc.connected ? I18n.t("已连接") : I18n.t("未连接")
                tone: Ipc.connected ? Theme.green : Theme.red
            }
        }
        MRow {
            label: I18n.t("状态机")
            property string state: Ipc.daemonState
            MPill {
                text: page.stateText(Ipc.daemonState)
                tone: Ipc.daemonState === "idle" ? Theme.textDim : Theme.accent
            }
        }
        MRow {
            label: I18n.t("端点")
            subtitle: Ipc.socketPath + (Ipc.usingTestSocket ? I18n.t("（测试 socket）") : I18n.t("（生产 socket）"))
            controlMinWidth: 0
            Text {
                text: Ipc.requestCount + I18n.t(" 请求 / ") + Ipc.responseCount + I18n.t(" 响应")
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
        MRow {
            label: I18n.t("版本")
            showSeparator: false
            Text {
                text: page.diag.version !== undefined ? String(page.diag.version) : "—"
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
    }

    // -------------------------------------------------------------- 延迟指标
    MCard {
        title: I18n.t("延迟指标")
        subtitle: page.hasDiag ? I18n.t("来自 daemon diagnostics") : I18n.t("等待 daemon 的 diagnostics 响应")

        RowLayout {
            Layout.fillWidth: true
            spacing: 12

            MStat {
                label: I18n.t("唤醒 → 应答")
                value: page.wakeToAckMs() !== undefined ? String(page.wakeToAckMs()) : "—"
                unit: "ms"
                tone: Theme.green
                hint: I18n.t("唤醒词命中到 ack 出声")
            }
            MStat {
                label: I18n.t("TTS 首字")
                value: page.ttsFirstMs() !== undefined ? String(page.ttsFirstMs()) : "—"
                unit: "ms"
                tone: Theme.accent
                hint: I18n.t("请求 → 第一声")
            }
            MStat {
                label: I18n.t("ASR 最终")
                value: page.asrFinalMs() !== undefined ? String(page.asrFinalMs()) : "—"
                unit: "ms"
                tone: Theme.text
                hint: I18n.t("一句话转写耗时")
            }
            MStat {
                label: I18n.t("流式 partial")
                value: page.latency.asrPartialMs !== undefined ? String(page.latency.asrPartialMs) : "—"
                unit: "ms"
                tone: Theme.text
                hint: I18n.t("首个中间结果")
            }
        }
    }

    // -------------------------------------------------------------- 语音能力
    MCard {
        title: I18n.t("语音能力")

        MRow {
            label: I18n.t("ASR 听写")
            MPill {
                text: page.asrInfo.available === undefined ? "—" : (page.asrInfo.available ? I18n.t("可用") : I18n.t("不可用"))
                tone: page.asrInfo.available ? Theme.green : Theme.red
            }
        }
        MRow {
            label: I18n.t("ASR 模型")
            Text {
                text: page.asrModelText()
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
        MRow {
            label: I18n.t("TTS 播报")
            MPill {
                text: page.ttsInfo.available === undefined ? "—" : (page.ttsInfo.available ? I18n.t("可用") : I18n.t("不可用"))
                tone: page.ttsInfo.available ? Theme.green : Theme.red
            }
        }
        MRow {
            label: I18n.t("音色 / 输出")
            Text {
                text: (page.ttsInfo.voiceId !== undefined ? String(page.ttsInfo.voiceId) : "—")
                    + (page.ttsInfo.sink ? "  ·  " + String(page.ttsInfo.sink) : "")
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
        MRow {
            label: I18n.t("唤醒应答 (ack)")
            showSeparator: false
            MPill {
                text: page.ackInfo.enabled === undefined ? "—" : (page.ackInfo.enabled ? I18n.t("已开启") : I18n.t("已关闭"))
                tone: page.ackInfo.enabled ? Theme.green : Theme.textDim
            }
        }
    }

    // -------------------------------------------------------------- 最近错误
    MCard {
        title: I18n.t("最近错误")

        Text {
            visible: Ipc.recentErrors.length === 0
            Layout.fillWidth: true
            text: I18n.t("暂无错误。")
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
        }

        Repeater {
            model: Math.min(Ipc.recentErrors.length, 5)

            RowLayout {
                Layout.fillWidth: true
                spacing: 10

                Text {
                    text: Ipc.fmtClock(Ipc.recentErrors[index].t)
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    Layout.alignment: Qt.AlignTop
                }
                MIcon {
                    kind: "warning"
                    size: 13
                    color: Theme.orange
                    Layout.alignment: Qt.AlignTop
                }
                Text {
                    Layout.fillWidth: true
                    text: Ipc.recentErrors[index].message
                    color: Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    wrapMode: Text.WordWrap
                }
            }
        }
    }

    // ---------------------------------------------------------------- 路径
    MCard {
        title: I18n.t("运行环境")

        MRow {
            label: I18n.t("配置文件")
            Text {
                text: page.diag.configPath !== undefined ? String(page.diag.configPath) : Ipc.configPath
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
        MRow {
            label: I18n.t("日志")
            Text {
                text: page.diag.logPath !== undefined ? String(page.diag.logPath) : "journalctl --user -u figaro"
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
        MRow {
            label: I18n.t("运行时长")
            showSeparator: false
            Text {
                text: page.diag.uptimeMs !== undefined ? Ipc.fmtDuration(page.diag.uptimeMs) : "—"
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
    }
}
