import QtQuick
import QtQuick.Layouts
import ".."
import "../components"

// 连接：两个 API Key 的写入（只写不读，绝不回显完整 key）。
// deepseek.apiKey / minimax.apiKey 写入后 daemon 可能返回“需重启 daemon”，
// 因此这里带一个二次确认的重启服务按钮（复用已有 service.restart）。
MPageScroll {
    id: page

    property string deepseekDraft: ""
    property string minimaxDraft: ""
    property bool confirmRestart: false
    property string localHint: ""

    readonly property bool deepseekStored: Ipc.secretStored("deepseek.apiKey")
    readonly property bool minimaxStored: Ipc.secretStored("minimax.apiKey")

    function saveDeepseek() {
        const value = page.deepseekDraft.trim();
        if (value.length === 0) {
            page.localHint = "请先粘贴 DeepSeek API Key（sk- 开头）";
            return "empty";
        }
        Ipc.writeField("deepseek.apiKey", value);
        page.deepseekDraft = "";
        deepseekField.text = "";   // never keep the secret in a visible field
        page.localHint = "已写入 DeepSeek Key（不回显）";
        return "deepseek-written";
    }

    function saveMinimax() {
        const value = page.minimaxDraft.trim();
        if (value.length === 0) {
            page.localHint = "请先粘贴 MiniMax API Key";
            return "empty";
        }
        Ipc.writeField("minimax.apiKey", value);
        page.minimaxDraft = "";
        minimaxField.text = "";
        page.localHint = "已写入 MiniMax Key（不回显）";
        return "minimax-written";
    }

    function requestRestart() {
        page.confirmRestart = true;
        restartConfirmTimer.restart();
        return "confirm-required";
    }

    function confirmRestartNow() {
        page.confirmRestart = false;
        Ipc.restartService();
        return "restart-requested";
    }

    // Harness only (fake daemon): writes obvious placeholder keys. Never run
    // this against the production daemon/config.
    function demoWrite() {
        Ipc.writeFields([
            { path: "deepseek.apiKey", value: "sk-test-deepseek-placeholder" },
            { path: "minimax.apiKey", value: "sk-test-minimax-placeholder" },
        ]);
        page.deepseekDraft = "";
        page.minimaxDraft = "";
        deepseekField.text = "";
        minimaxField.text = "";
        page.localHint = "已写入测试占位 key（仅假 daemon）";
        return "api-demo-written";
    }

    function snapshot() {
        return {
            title: "连接",
            deepseekStored: page.deepseekStored,
            minimaxStored: page.minimaxStored,
            localHint: page.localHint,
            restartState: Ipc.restartState,
            deepseekDraftEmpty: page.deepseekDraft.length === 0,
            minimaxDraftEmpty: page.minimaxDraft.length === 0,
        };
    }

    Connections {
        target: Ipc
        function onConfigChanged() {
            // Only status flags are read; never the secret content itself.
        }
    }

    Timer {
        id: restartConfirmTimer
        interval: 5000
        repeat: false
        onTriggered: page.confirmRestart = false
    }

    MPageHeader {
        title: "连接"
        subtitle: "填写 DeepSeek 与 MiniMax 的 API Key —— 只写不读，保存后不回显"
        icon: "key"
    }

    Rectangle {
        Layout.fillWidth: true
        implicitHeight: 44
        radius: 8
        color: Qt.rgba(0.04, 0.52, 1.0, 0.10)
        border.width: 0.5
        border.color: Qt.rgba(0.04, 0.52, 1.0, 0.32)
        RowLayout {
            anchors.fill: parent
            anchors.margins: 10
            spacing: 8
            MIcon { kind: "warning"; size: 14; color: Theme.accent }
            Text {
                Layout.fillWidth: true
                text: "安全说明：本页只会把 key 写进 daemon 的 config.json，不会读取/显示/记录完整内容；"
                    + "输入框保存后立即清空。语音识别用的是本地模型，不需要任何 API Key。"
                color: Theme.text
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
                wrapMode: Text.WordWrap
                lineHeight: 1.2
            }
        }
    }

    MCard {
        title: "DeepSeek API Key"
        subtitle: "用于对话、推理与工具调用（deepseek.apiKey）"

        MRow {
            label: "API Key"
            subtitleWrap: true
            subtitle: "写入后由 daemon 读取；当前状态：" + (page.deepseekStored ? "有值（掩码）" : "未设置")
                + "。daemon 只回传 ***，因此无法显示尾号/完整 key（已反馈缺口：需要 hasKey 布尔或尾号掩码）"
            showSeparator: false
            RowLayout {
                spacing: 8
                MTextField {
                    id: deepseekField
                    inputWidth: 300
                    password: true
                    text: page.deepseekDraft
                    placeholder: Ipc.secretPlaceholder("deepseek.apiKey", "粘贴 DeepSeek API Key（sk-…）")
                    onTextChanged: page.deepseekDraft = text
                    onAccepted: page.saveDeepseek()
                }
                MButton {
                    text: "保存"
                    primary: true
                    icon: "check"
                    onClicked: page.saveDeepseek()
                }
                MApplyStatus { paths: ["deepseek.apiKey"] }
            }
        }
    }

    MCard {
        title: "MiniMax API Key"
        subtitle: "用于语音合成 TTS（minimax.apiKey）· 保存后 daemon 会尝试重建 TTS 连接"

        MRow {
            label: "API Key"
            subtitleWrap: true
            subtitle: "写入后用于语音合成；当前状态：" + (page.minimaxStored ? "有值（掩码）" : "未设置")
            showSeparator: false
            RowLayout {
                spacing: 8
                MTextField {
                    id: minimaxField
                    inputWidth: 300
                    password: true
                    text: page.minimaxDraft
                    placeholder: Ipc.secretPlaceholder("minimax.apiKey", "粘贴 MiniMax API Key")
                    onTextChanged: page.minimaxDraft = text
                    onAccepted: page.saveMinimax()
                }
                MButton {
                    text: "保存"
                    primary: true
                    icon: "check"
                    onClicked: page.saveMinimax()
                }
                MApplyStatus { paths: ["minimax.apiKey"] }
            }
        }
    }

    Text {
        visible: page.localHint.length > 0
        Layout.fillWidth: true
        text: page.localHint
        color: Theme.textDim
        font.family: Theme.fontSans
        font.pixelSize: Theme.fsSmall
    }

    MCard {
        title: "重启服务"
        subtitle: "Key 改动通常需要重启 daemon 才会被所有模块重新读取；重启会短暂中断语音功能"

        MRow {
            label: "重启 daemon"
            subtitle: "service.restart · 重启期间无法对话/唤醒"
            showSeparator: false
            RowLayout {
                spacing: 8
                MPill {
                    visible: Ipc.restartState.length > 0
                    text: {
                        switch (Ipc.restartState) {
                        case "sent": return "已发送";
                        case "accepted": return "正在重启";
                        case "restarting": return "等待重连";
                        case "done": return "已恢复";
                        case "unsupported": return "不支持";
                        default: return Ipc.restartState;
                        }
                    }
                    tone: Ipc.restartState === "done" ? Theme.green
                        : Ipc.restartState === "unsupported" ? Theme.red : Theme.orange
                }
                MButton {
                    visible: !page.confirmRestart
                    text: "重启服务"
                    icon: "refresh"
                    danger: true
                    enabled: Ipc.connected && !Ipc.unsupported("service.restart")
                    onClicked: page.requestRestart()
                }
                MButton {
                    visible: page.confirmRestart
                    text: "确认重启"
                    danger: true
                    onClicked: page.confirmRestartNow()
                }
                MButton {
                    visible: page.confirmRestart
                    text: "取消"
                    onClicked: page.confirmRestart = false
                }
            }
        }
    }

    MAdvancedCard {
        title: "高级"
        subtitle: "环境变量覆盖 / 当前保存状态"

        MRow {
            label: "环境变量优先"
            subtitleWrap: true
            subtitle: "若 daemon 以 FIGARO_DEEPSEEK_API_KEY / FIGARO_MINIMAX_API_KEY 启动，环境变量优先于这里的配置"
            showSeparator: true
            Text {
                text: "未读取环境变量"
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 12
            Text {
                text: "DeepSeek：" + (page.deepseekStored ? "已保存（掩码）" : "未设置")
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
            Text {
                text: "MiniMax：" + (page.minimaxStored ? "已保存（掩码）" : "未设置")
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
            Item { Layout.fillWidth: true }
            MButton {
                text: "清空输入框"
                icon: "close"
                onClicked: {
                    page.deepseekDraft = "";
                    page.minimaxDraft = "";
                }
            }
        }
    }
}
