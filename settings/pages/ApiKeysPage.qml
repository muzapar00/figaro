import QtQuick
import QtQuick.Layouts
import ".."
import "../components"

// 连接：两个 API Key 的写入（只写不读，绝不回显完整 key）。
// deepseek.apiKey / minimax.apiKey 写入后 daemon 可能返回“需重启 daemon”，
// 因此这里带一个二次确认的重启服务按钮（复用已有 service.restart）。
MPageScroll {
    id: page

    signal infoRequested(string title, string body, string linkLabel, string linkUrl)

    property string deepseekDraft: ""
    property string minimaxDraft: ""
    property bool confirmRestart: false
    property string localHint: ""

    readonly property bool deepseekStored: Ipc.secretStored("deepseek.apiKey")
    readonly property bool minimaxStored: Ipc.secretStored("minimax.apiKey")

    // ---- Home Assistant (home.*) ------------------------------------------
    property string haUrlDraft: ""
    property string haTokenDraft: ""
    property string haRoomDraft: ""
    property string haHint: ""
    property bool homeDemoMode: false
    readonly property bool haTokenStored: Ipc.secretStored("home.haToken")
    readonly property var homeResult: Ipc.homeTestResult || ({})
    readonly property bool homeResultOk: page.homeResult.ok === true
    readonly property string homeResultMessage: page.homeResult.message || ""
    readonly property bool homeTestBusy: Ipc.homeTestRunning

    function syncHome() {
        page.haUrlDraft = String(Ipc.cfg("home.haUrl", "") || "");
        page.haRoomDraft = String(Ipc.cfg("home.defaultRoom", "") || "");
        // The token is write-only: never copy "***" into a visible field.
        page.haTokenDraft = "";
        if (haTokenField) haTokenField.text = "";
    }

    function saveHome() {
        const url = page.haUrlDraft.trim();
        const room = page.haRoomDraft.trim();
        const token = page.haTokenDraft.trim();
        const entries = [];
        const demo = page.homeDemoMode;
        if (demo || url !== String(Ipc.cfg("home.haUrl", "") || "")) entries.push({ path: "home.haUrl", value: url });
        if (demo || room !== String(Ipc.cfg("home.defaultRoom", "") || "")) entries.push({ path: "home.defaultRoom", value: room });
        page.homeDemoMode = false;
        if (token.length > 0) {
            entries.push({ path: "home.haToken", value: token });
            page.haTokenDraft = "";
            haTokenField.text = "";
        }
        if (entries.length === 0) {
            page.haHint = I18n.t("没有修改需要保存");
            return "home-noop";
        }
        Ipc.writeFields(entries, {
            onDone: function(msg) {
                if (msg && msg.ok !== false) {
                    page.haHint = I18n.t("已保存，重启费加罗后生效（daemon 只在启动时读取 home.*）");
                }
            },
        });
        return "home-save-requested";
    }

    function runHomeTest() {
        Ipc.homeTest(page.haUrlDraft.trim(), page.haTokenDraft.trim());
        return "home-test-requested";
    }

    // Harness only: fills plausible drafts (fake daemon never talks to a real HA).
    function homeDemoWrite() {
        page.haUrlDraft = "http://homeassistant.local:8123";
        page.haRoomDraft = I18n.t("客厅");
        page.haTokenDraft = "ha-test-token";
        haUrlField.text = page.haUrlDraft;
        haRoomField.text = page.haRoomDraft;
        haTokenField.text = page.haTokenDraft;
        page.haHint = I18n.t("测试值已填入（仅假 daemon）");
        return "home-demo-filled";
    }

    function homeDemoFailTest() {
        page.haUrlDraft = "http://homeassistant.local:8123";
        haUrlField.text = page.haUrlDraft;
        Ipc.homeTest(page.haUrlDraft, "bad-token");
        return "home-test-bad-token";
    }

    function saveDeepseek() {
        const value = page.deepseekDraft.trim();
        if (value.length === 0) {
            page.localHint = I18n.t("请先粘贴 DeepSeek API Key（sk- 开头）");
            return "empty";
        }
        Ipc.writeField("deepseek.apiKey", value);
        page.deepseekDraft = "";
        deepseekField.text = "";   // never keep the secret in a visible field
        page.localHint = I18n.t("已写入 DeepSeek Key（不回显）");
        return "deepseek-written";
    }

    function saveMinimax() {
        const value = page.minimaxDraft.trim();
        if (value.length === 0) {
            page.localHint = I18n.t("请先粘贴 MiniMax API Key");
            return "empty";
        }
        Ipc.writeField("minimax.apiKey", value);
        page.minimaxDraft = "";
        minimaxField.text = "";
        page.localHint = I18n.t("已写入 MiniMax Key（不回显）");
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
        page.localHint = I18n.t("已写入测试占位 key（仅假 daemon）");
        return "api-demo-written";
    }

    function snapshot() {
        return {
            title: I18n.t("连接"),
            deepseekStored: page.deepseekStored,
            minimaxStored: page.minimaxStored,
            localHint: page.localHint,
            restartState: Ipc.restartState,
            deepseekDraftEmpty: page.deepseekDraft.length === 0,
            minimaxDraftEmpty: page.minimaxDraft.length === 0,
            haUrl: page.haUrlDraft,
            haRoom: page.haRoomDraft,
            haTokenStored: page.haTokenStored,
            haTokenDraftEmpty: page.haTokenDraft.length === 0,
            haHint: page.haHint,
            homeTest: {
                running: page.homeTestBusy,
                ok: page.homeResult.ok === true,
                status: page.homeResult.status !== undefined ? page.homeResult.status : null,
                message: page.homeResultMessage,
            },
        };
    }

    Connections {
        target: Ipc
        function onConfigChanged() {
            // Only status flags are read; never the secret content itself.
        }
        function onConfigLoadedChanged() {
            if (Ipc.configLoaded) page.syncHome();
        }
    }

    Component.onCompleted: page.syncHome()

    Timer {
        id: restartConfirmTimer
        interval: 5000
        repeat: false
        onTriggered: page.confirmRestart = false
    }

    MPageHeader {
        title: I18n.t("连接")
        subtitle: I18n.t("填写 DeepSeek 与 MiniMax 的 API Key —— 只写不读，保存后不回显")
        icon: "key"
    }

    Rectangle {
        // Height follows the wrapped text instead of a fixed 44px: the note wraps
        // to two lines at this width, and a fixed height left uneven space above
        // and below the text.
        id: safetyNote
        Layout.fillWidth: true
        implicitHeight: safetyRow.implicitHeight + 20
        radius: 8
        color: Qt.rgba(0.04, 0.52, 1.0, 0.10)
        border.width: 0.5
        border.color: Qt.rgba(0.04, 0.52, 1.0, 0.32)
        RowLayout {
            id: safetyRow
            anchors.fill: parent
            anchors.margins: 10
            spacing: 8
            MIcon {
                kind: "warning"
                size: 14
                color: Theme.accent
                Layout.alignment: Qt.AlignTop | Qt.AlignHCenter
                Layout.topMargin: 1
            }
            Text {
                Layout.alignment: Qt.AlignVCenter
                Layout.fillWidth: true
                text: I18n.t("安全说明：本页只会把 key 写进 daemon 的 config.json，不会读取/显示/记录完整内容；")
                    + I18n.t("输入框保存后立即清空。语音识别用的是本地模型，不需要任何 API Key。")
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
        subtitle: I18n.t("用于对话、推理与工具调用（deepseek.apiKey）")

        MRow {
            label: "API Key"
            subtitleWrap: true
            subtitle: I18n.t("写入后由 daemon 读取；当前状态：") + (page.deepseekStored ? I18n.t("有值（掩码）") : I18n.t("未设置"))
                + I18n.t("。daemon 只回传 ***，因此无法显示尾号/完整 key（已反馈缺口：需要 hasKey 布尔或尾号掩码）")
            showSeparator: false
            RowLayout {
                spacing: 8
                MTextField {
                    id: deepseekField
                    inputWidth: 300
                    password: true
                    text: page.deepseekDraft
                    placeholder: Ipc.secretPlaceholder("deepseek.apiKey", I18n.t("粘贴 DeepSeek API Key（sk-…）"))
                    onEdited: (value) => page.deepseekDraft = value
                    onAccepted: page.saveDeepseek()
                }
                MButton {
                    text: I18n.t("保存")
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
        subtitle: I18n.t("用于语音合成 TTS（minimax.apiKey）· 保存后 daemon 会尝试重建 TTS 连接")

        MRow {
            label: "API Key"
            subtitleWrap: true
            subtitle: I18n.t("写入后用于语音合成；当前状态：") + (page.minimaxStored ? I18n.t("有值（掩码）") : I18n.t("未设置"))
            showSeparator: false
            RowLayout {
                spacing: 8
                MTextField {
                    id: minimaxField
                    inputWidth: 300
                    password: true
                    text: page.minimaxDraft
                    placeholder: Ipc.secretPlaceholder("minimax.apiKey", I18n.t("粘贴 MiniMax API Key"))
                    onEdited: (value) => page.minimaxDraft = value
                    onAccepted: page.saveMinimax()
                }
                MButton {
                    text: I18n.t("保存")
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

    // --------------------------------------------- 家庭中枢 Home Assistant
    MCard {
        title: I18n.t("家庭中枢 Home Assistant")
        subtitle: I18n.t("用本地 Home Assistant 控制灯（home.*）· 工具只在 daemon 启动时注册，改完需重启费加罗")

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 5

            Text {
                Layout.fillWidth: true
                text: I18n.t("Home Assistant 地址")
                color: Theme.text
                font.family: Theme.fontSans
                font.pixelSize: Theme.fs
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                MTextField {
                    id: haUrlField
                    Layout.fillWidth: true
                    text: page.haUrlDraft
                    placeholder: "http://homeassistant.local:8123"
                    onEdited: (value) => page.haUrlDraft = value
                    onAccepted: page.saveHome()
                }
                MApplyStatus { paths: ["home.haUrl"] }
            }
        }

        MRow {
            label: I18n.t("长期访问令牌")
            subtitleWrap: true
            subtitle: I18n.t("home.haToken · 只写不读") + (page.haTokenStored
                ? I18n.t("（已保存，daemon 只回传掩码，不回显）") : I18n.t("（未设置）"))
            RowLayout {
                spacing: 8
                MTextField {
                    id: haTokenField
                    inputWidth: 240
                    password: true
                    placeholder: Ipc.secretPlaceholder("home.haToken", I18n.t("粘贴 Home Assistant 长期令牌"))
                    onEdited: (value) => page.haTokenDraft = value
                    onAccepted: page.saveHome()
                }
                MApplyStatus { paths: ["home.haToken"] }
            }
        }

        MRow {
            label: I18n.t("默认房间")
            subtitle: I18n.t("没说房间名时用哪个房间（可选，home.defaultRoom）")
            showSeparator: false
            RowLayout {
                spacing: 8
                MTextField {
                    id: haRoomField
                    inputWidth: 160
                    text: page.haRoomDraft
                    placeholder: I18n.t("例如 客厅")
                    onEdited: (value) => page.haRoomDraft = value
                    onAccepted: page.saveHome()
                }
                MApplyStatus { paths: ["home.defaultRoom"] }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            MButton {
                text: I18n.t("保存")
                primary: true
                icon: "check"
                onClicked: page.saveHome()
            }
            MButton {
                text: page.homeTestBusy ? I18n.t("测试中…") : I18n.t("测试连接")
                icon: "wand"
                enabled: Ipc.connected && !page.homeTestBusy
                onClicked: page.runHomeTest()
            }
            Item { Layout.fillWidth: true }
            MPill {
                visible: page.homeResultMessage.length > 0
                text: page.homeResultOk ? I18n.t("已连接") : I18n.t("连接失败")
                tone: page.homeResultOk ? Theme.green : Theme.red
            }
        }
        Text {
            visible: page.homeResultMessage.length > 0
            Layout.fillWidth: true
            text: page.homeResultMessage
            color: page.homeResultOk ? Theme.green : Theme.red
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: Text.WordWrap
        }
        Text {
            visible: page.haHint.length > 0
            Layout.fillWidth: true
            text: page.haHint
            color: Theme.textDim
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: Text.WordWrap
        }
        Text {
            Layout.fillWidth: true
            text: I18n.t("说明：令牌只写进 config.json，不会回显/记录；「测试连接」只探测 ${地址}/api/（4 秒超时），不保存配置。")
                + I18n.t("保存后需要重启费加罗，daemon 才会注册家庭控制工具。")
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WordWrap
        }
    }

    MCard {
        title: I18n.t("重启服务")
        subtitle: I18n.t("Key 改动通常需要重启 daemon 才会被所有模块重新读取；重启会短暂中断语音功能")

        MRow {
            label: I18n.t("重启 daemon")
            subtitle: I18n.t("service.restart · 重启期间无法对话/唤醒")
            showSeparator: false
            RowLayout {
                spacing: 8
                MPill {
                    visible: Ipc.restartState.length > 0
                    text: {
                        switch (Ipc.restartState) {
                        case "sent": return I18n.t("已发送");
                        case "accepted": return I18n.t("正在重启");
                        case "restarting": return I18n.t("等待重连");
                        case "done": return I18n.t("已恢复");
                        case "unsupported": return I18n.t("不支持");
                        default: return Ipc.restartState;
                        }
                    }
                    tone: Ipc.restartState === "done" ? Theme.green
                        : Ipc.restartState === "unsupported" ? Theme.red : Theme.orange
                }
                MButton {
                    visible: !page.confirmRestart
                    text: I18n.t("重启服务")
                    icon: "refresh"
                    danger: true
                    enabled: Ipc.connected && !Ipc.unsupported("service.restart")
                    onClicked: page.requestRestart()
                }
                MButton {
                    visible: page.confirmRestart
                    text: I18n.t("确认重启")
                    danger: true
                    onClicked: page.confirmRestartNow()
                }
                MButton {
                    visible: page.confirmRestart
                    text: I18n.t("取消")
                    onClicked: page.confirmRestart = false
                }
            }
        }
    }

    MAdvancedCard {
        title: I18n.t("高级")
        subtitle: I18n.t("环境变量覆盖 / 当前保存状态")

        MRow {
            label: I18n.t("环境变量优先")
            subtitleWrap: true
            subtitle: I18n.t("若 daemon 以 FIGARO_DEEPSEEK_API_KEY / FIGARO_MINIMAX_API_KEY 启动，环境变量优先于这里的配置")
            showSeparator: true
            Text {
                text: I18n.t("未读取环境变量")
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 12
            Text {
                text: "DeepSeek：" + (page.deepseekStored ? I18n.t("已保存（掩码）") : I18n.t("未设置"))
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
            Text {
                text: "MiniMax：" + (page.minimaxStored ? I18n.t("已保存（掩码）") : I18n.t("未设置"))
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
            Item { Layout.fillWidth: true }
            MButton {
                text: I18n.t("清空输入框")
                icon: "close"
                onClicked: {
                    page.deepseekDraft = "";
                    page.minimaxDraft = "";
                }
            }
        }
    }
}
