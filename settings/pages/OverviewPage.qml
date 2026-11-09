import QtQuick
import QtQuick.Layouts
import ".."
import "../components"

MPageScroll {
    id: page

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
        if (mi.offline) parts.push("离线 " + String(mi.offline));
        if (mi.streaming) parts.push("流式");
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
        case "listening": return "倾听中";
        case "thinking": return "思考中";
        case "speaking": return "播报中";
        default: return "空闲";
        }
    }

    function snapshot() {
        return {
            title: "概览",
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
        title: "概览"
        subtitle: "费加罗语音助手 · 运行状态与语音能力"
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
                    text: "当前 daemon 不支持 §3.1 诊断接口（diagnostics / config.get 未响应）。"
                        + "下面的状态来自 §3 基础协议，调参与自测功能不可用。"
                    color: Theme.yellow
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    wrapMode: Text.WordWrap
                    lineHeight: 1.25
                }
            }
        }
    }

    // ------------------------------------------------------------ 服务状态
    MCard {
        title: "服务状态"

        MRow {
            label: "连接"
            MPill {
                text: Ipc.connected ? "已连接" : "未连接"
                tone: Ipc.connected ? Theme.green : Theme.red
            }
        }
        MRow {
            label: "状态机"
            property string state: Ipc.daemonState
            MPill {
                text: page.stateText(Ipc.daemonState)
                tone: Ipc.daemonState === "idle" ? Theme.textDim : Theme.accent
            }
        }
        MRow {
            label: "端点"
            subtitle: Ipc.socketPath + (Ipc.usingTestSocket ? "（测试 socket）" : "（生产 socket）")
            controlMinWidth: 0
            Text {
                text: Ipc.requestCount + " 请求 / " + Ipc.responseCount + " 响应"
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
        MRow {
            label: "版本"
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
        title: "延迟指标"
        subtitle: page.hasDiag ? "来自 daemon diagnostics" : "等待 daemon 的 diagnostics 响应"

        RowLayout {
            Layout.fillWidth: true
            spacing: 12

            MStat {
                label: "唤醒 → 应答"
                value: page.wakeToAckMs() !== undefined ? String(page.wakeToAckMs()) : "—"
                unit: "ms"
                tone: Theme.green
                hint: "唤醒词命中到 ack 出声"
            }
            MStat {
                label: "TTS 首字"
                value: page.ttsFirstMs() !== undefined ? String(page.ttsFirstMs()) : "—"
                unit: "ms"
                tone: Theme.accent
                hint: "请求 → 第一声"
            }
            MStat {
                label: "ASR 最终"
                value: page.asrFinalMs() !== undefined ? String(page.asrFinalMs()) : "—"
                unit: "ms"
                tone: Theme.text
                hint: "一句话转写耗时"
            }
            MStat {
                label: "流式 partial"
                value: page.latency.asrPartialMs !== undefined ? String(page.latency.asrPartialMs) : "—"
                unit: "ms"
                tone: Theme.text
                hint: "首个中间结果"
            }
        }
    }

    // -------------------------------------------------------------- 语音能力
    MCard {
        title: "语音能力"

        MRow {
            label: "ASR 听写"
            MPill {
                text: page.asrInfo.available === undefined ? "—" : (page.asrInfo.available ? "可用" : "不可用")
                tone: page.asrInfo.available ? Theme.green : Theme.red
            }
        }
        MRow {
            label: "ASR 模型"
            Text {
                text: page.asrModelText()
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
        MRow {
            label: "TTS 播报"
            MPill {
                text: page.ttsInfo.available === undefined ? "—" : (page.ttsInfo.available ? "可用" : "不可用")
                tone: page.ttsInfo.available ? Theme.green : Theme.red
            }
        }
        MRow {
            label: "音色 / 输出"
            Text {
                text: (page.ttsInfo.voiceId !== undefined ? String(page.ttsInfo.voiceId) : "—")
                    + (page.ttsInfo.sink ? "  ·  " + String(page.ttsInfo.sink) : "")
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
        MRow {
            label: "唤醒应答 (ack)"
            showSeparator: false
            MPill {
                text: page.ackInfo.enabled === undefined ? "—" : (page.ackInfo.enabled ? "已开启" : "已关闭")
                tone: page.ackInfo.enabled ? Theme.green : Theme.textDim
            }
        }
    }

    // -------------------------------------------------------------- 最近错误
    MCard {
        title: "最近错误"

        Text {
            visible: Ipc.recentErrors.length === 0
            Layout.fillWidth: true
            text: "暂无错误。"
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
        title: "运行环境"

        MRow {
            label: "配置文件"
            Text {
                text: page.diag.configPath !== undefined ? String(page.diag.configPath) : Ipc.configPath
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
        MRow {
            label: "日志"
            Text {
                text: page.diag.logPath !== undefined ? String(page.diag.logPath) : "journalctl --user -u figaro"
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
        MRow {
            label: "运行时长"
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
