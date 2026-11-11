import QtQuick
import QtQuick.Layouts
import ".."
import "../components"

// 模型服务：通用 LLM 服务商（DeepSeek / OpenAI / Gemini / OpenAI 兼容 Custom）。
// 只写 config.llm.*，不直接发网络请求；「测试连接」走 daemon 的 llm.test IPC。
MPageScroll {
    id: page

    signal infoRequested(string title, string body, string linkLabel, string linkUrl)

    // ---- provider presets (baseUrl/model defaults follow the official docs) --
    readonly property var providers: [
        { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash",
          keyUrl: "https://platform.deepseek.com/api_keys", desc: I18n.t("性价比高、中文好，费加罗的默认选择"),
          logo: "../assets/providers/deepseek.svg", fallback: "D", fallbackColor: "#4D6BFE" },
        { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini",
          keyUrl: "https://platform.openai.com/api-keys", desc: I18n.t("生态成熟、工具调用稳定"),
          logo: "", fallback: "O", fallbackColor: "#10A37F" },
        { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.0-flash",
          keyUrl: "https://aistudio.google.com/app/apikey", desc: I18n.t("响应快、有免费额度"),
          logo: "../assets/providers/googlegemini.svg", fallback: "G", fallbackColor: "#8E75B2" },
        { id: "custom", label: I18n.t("自定义"), baseUrl: "", model: "",
          keyUrl: "", desc: I18n.t("任意 OpenAI 兼容端点，如 Ollama / vLLM / 第三方中转"),
          logo: "", fallback: "C", fallbackColor: "#5E5CE6" },
    ]

    property string providerDraft: "deepseek"
    property string baseUrlDraft: ""
    property string modelDraft: ""
    property string apiKeyDraft: ""
    property string reasoningDraft: "none"
    property real temperatureDraft: 0.6
    property string localHint: ""
    property bool demoMode: false

    readonly property var savedUrl: String(Ipc.cfg("llm.baseUrl", "") || "")
    readonly property var savedModel: String(Ipc.cfg("llm.model", "") || "")
    readonly property bool keyStored: Ipc.secretStored("llm.apiKey")
    readonly property var testResult: Ipc.llmTestResult || ({})
    readonly property bool testOk: page.testResult.ok === true
    readonly property string testMessage: page.testResult.message || ""

    function providerIndex(id) {
        for (let i = 0; i < page.providers.length; i++)
            if (page.providers[i].id === id) return i;
        return 0;
    }
    function openLlmInfo() {
        page.infoRequested(
            I18n.t("推荐服务商"),
            I18n.t("我们无法直接提供高质量的实时 LLM 服务，需要你自己向服务商申请 API Key。")
                + I18n.t("Key 只保存在本机 config.json（权限 600），不会上传给我们，也不会写进日志。")
                + I18n.t("DeepSeek / OpenAI / Gemini 是推荐服务商，不是唯一选择；")
                + I18n.t("「自定义」可以填 Ollama / vLLM 等 OpenAI 兼容端点。"),
            "",
            "");
        return "llm-info";
    }

    function openProviderInfo(id) {
        const info = page.providerInfo(id);
        page.infoRequested(
            info.label + I18n.t(" · 推荐服务商"),
            I18n.t("我们无法直接提供高质量的实时 LLM 服务，需要你自己向服务商申请 API Key。")
                + I18n.t("Key 只保存在本机 config.json（权限 600），不会上传给我们，也不会写进日志。")
                + I18n.t("DeepSeek / OpenAI / Gemini 是推荐服务商，不是唯一选择；")
                + I18n.t("「自定义」可以填 Ollama / vLLM 等 OpenAI 兼容端点。"),
            I18n.t("打开 ") + info.label + I18n.t(" 官网"),
            info.keyUrl);
        return "llm-info-" + id;
    }

    function providerInfo(id) {
        for (let i = 0; i < page.providers.length; i++)
            if (page.providers[i].id === id) return page.providers[i];
        return page.providers[0];
    }

    function syncFromConfig() {
        const provider = String(Ipc.cfg("llm.provider", "deepseek") || "deepseek");
        page.providerDraft = page.providers.some((p) => p.id === provider) ? provider : "custom";
        page.baseUrlDraft = String(Ipc.cfg("llm.baseUrl", "") || "");
        page.modelDraft = String(Ipc.cfg("llm.model", "") || "");
        page.reasoningDraft = String(Ipc.cfg("llm.reasoningEffort", "none") || "none");
        page.temperatureDraft = Number(Ipc.cfg("llm.temperature", 0.6));
        page.apiKeyDraft = "";
        if (apiKeyField) apiKeyField.text = "";
    }

    function pickProvider(id) {
        const previous = page.providerInfo(page.providerDraft);
        page.providerDraft = id;
        const next = page.providerInfo(id);
        // Only replace fields that still hold the previous provider's preset (or
        // are empty), so a hand-edited baseUrl/model is never clobbered.
        if (page.baseUrlDraft.length === 0 || page.baseUrlDraft === previous.baseUrl)
            page.baseUrlDraft = next.baseUrl;
        if (page.modelDraft.length === 0 || page.modelDraft === previous.model)
            page.modelDraft = next.model;
        page.localHint = "";
    }

    function useProvider(id) {
        page.pickProvider(id);
        page.save();
        return "llm-provider-" + id;
    }

    function save() {
        const entries = [];
        const demo = page.demoMode;
        page.demoMode = false;
        if (demo || page.providerDraft !== String(Ipc.cfg("llm.provider", "deepseek") || "deepseek"))
            entries.push({ path: "llm.provider", value: page.providerDraft });
        if (demo || page.baseUrlDraft.trim() !== String(Ipc.cfg("llm.baseUrl", "") || ""))
            entries.push({ path: "llm.baseUrl", value: page.baseUrlDraft.trim() });
        if (demo || page.modelDraft.trim() !== String(Ipc.cfg("llm.model", "") || ""))
            entries.push({ path: "llm.model", value: page.modelDraft.trim() });
        const token = page.apiKeyDraft.trim();
        if (token.length > 0) {
            entries.push({ path: "llm.apiKey", value: token });
            page.apiKeyDraft = "";
            apiKeyField.text = "";
        }
        if (entries.length === 0) {
            page.localHint = I18n.t("没有修改需要保存");
            return "llm-noop";
        }
        Ipc.writeFields(entries, {
            onDone: function(msg) {
                if (msg && msg.ok !== false) page.localHint = I18n.t("已保存，重启费加罗后生效");
            },
        });
        return "llm-save-requested";
    }

    function testConnection() {
        Ipc.llmTest({
            provider: page.providerDraft,
            baseUrl: page.baseUrlDraft.trim(),
            model: page.modelDraft.trim(),
            apiKey: page.apiKeyDraft.trim().length > 0 ? page.apiKeyDraft.trim() : "***",
        });
        return "llm-test-requested";
    }

    // Harness helper: fill plausible OpenAI values without touching the daemon.
    function demoWrite() {
        page.providerDraft = "openai";
        page.baseUrlDraft = "https://api.openai.com/v1";
        page.modelDraft = "gpt-4o-mini";
        page.apiKeyDraft = "sk-test-llm-placeholder";
        baseUrlField.text = page.baseUrlDraft;
        modelField.text = page.modelDraft;
        apiKeyField.text = page.apiKeyDraft;
        page.localHint = I18n.t("测试值已填入（仅假 daemon）");
        return "llm-demo-filled";
    }

    function snapshot() {
        return {
            title: I18n.t("模型服务"),
            provider: page.providerDraft,
            baseUrl: page.baseUrlDraft,
            model: page.modelDraft,
            apiKeyDraftEmpty: page.apiKeyDraft.length === 0,
            keyStored: page.keyStored,
            localHint: page.localHint,
            recommendLine: I18n.t("我们推荐以下服务商，如果您支持开源，请选择中国的深度求索"),
            providerLinks: page.providers.map((p) => ({ name: p.label, url: p.keyUrl, logo: p.logo, fallback: p.fallback })),
            test: {
                running: Ipc.llmTestRunning,
                ok: page.testResult.ok === true,
                status: page.testResult.status !== undefined ? page.testResult.status : null,
                message: page.testMessage,
                provider: page.testResult.provider !== undefined ? page.testResult.provider : null,
            },
        };
    }

    Connections {
        target: Ipc
        function onConfigLoadedChanged() {
            if (Ipc.configLoaded) page.syncFromConfig();
        }
        function onLlmTestResultChanged() {
            // The result stays visible; nothing to do.
        }
    }
    Component.onCompleted: page.syncFromConfig()

    MPageHeader {
        title: I18n.t("模型服务")
        subtitle: I18n.t("选择费加罗的「大脑」：对话、推理和工具调用都由你选的服务商完成")
        icon: "chat"
    }

    MCard {
        title: I18n.t("服务商")
        subtitle: I18n.t("写入 config.llm.*（旧 deepseek.* 保持不变；llm.apiKey 为空时自动沿用旧 key）")

        MRow {
            label: I18n.t("服务商")
            subtitle: I18n.t("DeepSeek / OpenAI / Gemini / 自定义 OpenAI 兼容")
            showSeparator: true
            MSegmented {
                options: page.providers.map((p) => ({ value: p.id, label: p.label }))
                currentIndex: page.providerIndex(page.providerDraft)
                onActivated: (index, value) => page.pickProvider(value)
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 5
            Text {
                Layout.fillWidth: true
                text: I18n.t("API 地址（baseUrl）")
                color: Theme.text
                font.family: Theme.fontSans
                font.pixelSize: Theme.fs
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                MTextField {
                    id: baseUrlField
                    Layout.fillWidth: true
                    text: page.baseUrlDraft
                    placeholder: page.providerDraft === "custom" ? "http://127.0.0.1:11434/v1（Ollama）" : page.providerInfo(page.providerDraft).baseUrl
                    onEdited: (value) => page.baseUrlDraft = value
                }
                MApplyStatus { paths: ["llm.baseUrl"] }
            }
        }
        MRow {
            label: I18n.t("模型名")
            subtitle: I18n.t("服务商的模型 ID，例如 deepseek-flash / gpt-4o-mini / gemini-2.0-flash")
            RowLayout {
                spacing: 8
                MTextField {
                    id: modelField
                    inputWidth: 240
                    text: page.modelDraft
                    placeholder: page.providerInfo(page.providerDraft).model
                    onEdited: (value) => page.modelDraft = value
                }
                MApplyStatus { paths: ["llm.model"] }
            }
        }
        MRow {
            label: "API Key"
            subtitleWrap: true
            subtitle: I18n.t("只写不读，保存在本机 config.json（权限 600）；当前：") + (page.keyStored ? I18n.t("已保存（掩码）") : I18n.t("未设置"))
                + (Ipc.secretStored("deepseek.apiKey") ? I18n.t(" · 旧 DeepSeek key 仍在，可作为回退") : "")
            showSeparator: false
            RowLayout {
                spacing: 8
                MTextField {
                    id: apiKeyField
                    inputWidth: 260
                    password: true
                    placeholder: Ipc.secretPlaceholder("llm.apiKey", I18n.t("粘贴服务商 API Key"))
                    onEdited: (value) => page.apiKeyDraft = value
                    onAccepted: page.save()
                }
                MApplyStatus { paths: ["llm.apiKey"] }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            MButton {
                text: I18n.t("保存")
                primary: true
                icon: "check"
                onClicked: page.save()
            }
            MButton {
                text: Ipc.llmTestRunning ? I18n.t("测试中…") : I18n.t("测试连接")
                icon: "play"
                enabled: Ipc.connected && !Ipc.llmTestRunning
                onClicked: page.testConnection()
            }
            Item { Layout.fillWidth: true }
            MPill {
                visible: page.testMessage.length > 0
                text: page.testOk ? I18n.t("连接成功") : I18n.t("连接失败")
                tone: page.testOk ? Theme.green : Theme.red
            }
        }
        Text {
            visible: page.testMessage.length > 0
            Layout.fillWidth: true
            text: page.testMessage
            color: page.testOk ? Theme.green : Theme.red
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: Text.WordWrap
        }
        Text {
            visible: page.localHint.length > 0
            Layout.fillWidth: true
            text: page.localHint
            color: Theme.textDim
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: Text.WordWrap
        }
        Text {
            Layout.fillWidth: true
            text: I18n.t("说明：测试连接只探测服务商是否可达/Key 是否有效，不会真正发对话；检测通过后仍需重启费加罗让 daemon 使用新配置。")
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WordWrap
        }
    }

    // ------------------------------------------------ 推荐服务商（紧凑按钮）
    MCard {
        title: I18n.t("推荐服务商")
        subtitle: I18n.t("下列服务商可以直接填 API Key 使用；也可以选「自定义」接本地或第三方端点")

        Text {
            Layout.fillWidth: true
            text: I18n.t("我们推荐以下服务商，如果您支持开源，请选择中国的深度求索")
            color: Theme.textDim
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: Text.WordWrap
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            Repeater {
                model: page.providers.filter((p) => p.id !== "custom")
                MProviderButton {
                    required property var modelData
                    label: modelData.label
                    logoSource: modelData.logo
                    fallbackText: modelData.fallback
                    fallbackColor: modelData.fallbackColor
                    onClicked: Qt.openUrlExternally(modelData.keyUrl)
                }
            }
            MIcon {
                kind: "info"
                size: 16
                color: Theme.accent
                MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: page.openLlmInfo()
                }
            }
            Item { Layout.fillWidth: true }
            Text {
                text: I18n.t("自定义：baseUrl 填到 /v1 即可")
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsTiny
            }
        }
        Text {
            Layout.fillWidth: true
            text: I18n.t("推荐服务商，非唯一选择；Custom 可填本地/第三方 OpenAI 兼容端点（如 Ollama / vLLM）。")
                + I18n.t("所有 Key 只存在本机，换服务商不会影响唤醒词、语音识别等本地功能。")
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WordWrap
        }
    }

    MAdvancedCard {
        title: I18n.t("高级 · 推理参数")
        subtitle: I18n.t("一般不用改：reasoningEffort 与 temperature（写入 llm.*，需重启）")

        MRow {
            label: I18n.t("推理强度")
            subtitle: I18n.t("reasoningEffort：none / low / medium / high（仅部分服务商支持）")
            RowLayout {
                spacing: 8
                MSegmented {
                    options: ["none", "low", "medium", "high"]
                    currentIndex: Math.max(0, ["none", "low", "medium", "high"].indexOf(page.reasoningDraft))
                    onActivated: (index, value) => {
                        page.reasoningDraft = value;
                        Ipc.writeField("llm.reasoningEffort", value);
                    }
                }
                MApplyStatus { paths: ["llm.reasoningEffort"] }
            }
        }
        MRow {
            label: "temperature"
            subtitle: I18n.t("0–2，越低越稳定；0.6 适合日常对话")
            showSeparator: false
            RowLayout {
                spacing: 8
                Text {
                    text: page.temperatureDraft.toFixed(2)
                    color: Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    Layout.preferredWidth: 34
                    horizontalAlignment: Text.AlignRight
                }
                MSlider {
                    Layout.preferredWidth: 150
                    from: 0
                    to: 2
                    value: page.temperatureDraft
                    markers: [0.6]
                    onMoved: (v) => {
                        const rounded = Math.round(v * 100) / 100;
                        page.temperatureDraft = rounded;
                        Ipc.writeField("llm.temperature", rounded);
                    }
                }
                MApplyStatus { paths: ["llm.temperature"] }
            }
        }
    }
}
