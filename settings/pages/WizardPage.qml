import QtQuick
import QtQuick.Layouts
import ".."
import "../components"

// 新手引导：9 步，一步只讲一件事，大字 + 大按钮。
// ① 认识费加罗 ② 隐私 ③ 语言 ④ 地区 ⑤ 长期记忆 ⑥ 模型服务(LLM)
// ⑦ 语音服务(MiniMax) ⑧ 自检 ⑨ 完成
MPageScroll {
    id: page

    signal goOverview()
    signal infoRequested(string title, string body, string linkLabel, string linkUrl)

    readonly property int totalSteps: 9
    readonly property var stepIcons: ["overview", "key", "text", "wake", "folder", "chat", "speaker", "mic", "check"]
    readonly property var stepTitles: [
        I18n.t("认识费加罗"), I18n.t("隐私说明"), I18n.t("选择语言"), I18n.t("选择地区"), I18n.t("长期记忆"),
        I18n.t("模型服务"), I18n.t("语音服务"), I18n.t("快速自检"), I18n.t("完成"),
    ]
    readonly property var stepSubtitles: [
        I18n.t("一个住在本机的语音助手"),
        I18n.t("先说明白数据去哪里"),
        I18n.t("界面语言随时可以改"),
        I18n.t("模型下载走哪个源"),
        I18n.t("默认关闭，可再打开"),
        I18n.t("费加罗的「大脑」"),
        I18n.t("费加罗的「嗓子」"),
        I18n.t("麦克风 / 热键 / 声纹"),
        I18n.t("已经准备好了"),
    ]

    property int step: 0
    property var results: ["pending", "pending", "pending", "pending", "pending", "pending", "pending", "pending", "pending"]
    property string statusText: ""
    property real stepStartedAt: 0

    // ---- drafts (seeded from config, committed when leaving a step) --------
    property string regionDraft: ""
    property bool memoryDraft: false
    property string llmProviderDraft: "deepseek"
    property string llmBaseDraft: ""
    property string llmModelDraft: ""
    property string llmKeyDraft: ""
    property string ttsKeyDraft: ""

    // ---- self test ---------------------------------------------------------
    property real noiseRms: -1
    property string hotkeyText: "-"
    property string hotkeyStateText: "-"
    property string voiceprintText: "-"
    property bool micPassed: false

    readonly property bool runningMic: results[7] === "running"
    readonly property bool allDone: {
        for (let i = 0; i < page.results.length; i++)
            if (page.results[i] !== "pass" && page.results[i] !== "skipped") return false;
        return true;
    }

    readonly property var llmProviders: [
        { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash",
          keyUrl: "https://platform.deepseek.com/api_keys" },
        { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini",
          keyUrl: "https://platform.openai.com/api-keys" },
        { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.0-flash",
          keyUrl: "https://aistudio.google.com/app/apikey" },
        { id: "custom", label: I18n.t("自定义"), baseUrl: "", model: "", keyUrl: "" },
    ]

    readonly property var regions: [
        { id: "mainland", label: I18n.t("中国大陆"), desc: I18n.t("模型下载走国内镜像（ModelScope / hf-mirror / ghproxy），速度更快") },
        { id: "hmt", label: I18n.t("中国港澳台"), desc: I18n.t("走 GitHub / Hugging Face 直连或就近镜像") },
        { id: "overseas", label: I18n.t("海外及其他"), desc: I18n.t("走 GitHub / Hugging Face 官方直连") },
    ]

    readonly property var diag: Ipc.diagnostics || ({})
    readonly property var diagAsr: diag.asr || ({})

    function syncFromConfig() {
        page.regionDraft = String(Ipc.cfg("models.region", "") || "");
        page.memoryDraft = Ipc.cfg("rag.autoIngest", false) === true;
        page.llmProviderDraft = String(Ipc.cfg("llm.provider", "deepseek") || "deepseek");
        if (!page.llmProviders.some((p) => p.id === page.llmProviderDraft)) page.llmProviderDraft = "custom";
        page.llmBaseDraft = String(Ipc.cfg("llm.baseUrl", "") || "");
        page.llmModelDraft = String(Ipc.cfg("llm.model", "") || "");
        page.llmKeyDraft = "";
        page.ttsKeyDraft = "";
        page.micPassed = false;
        page.noiseRms = -1;
        page.hotkeyText = String(page.diagAsr.hotkey || Ipc.cfg("asr.hotkey", "F9"));
        page.hotkeyStateText = page.diagAsr.hotkeyState && page.diagAsr.hotkeyState.state
            ? String(page.diagAsr.hotkeyState.state) : "unknown";
        const speaker = page.diagAsr.speaker;
        page.voiceprintText = speaker && speaker.state ? String(speaker.state) : "unknown";
    }

    function resetWizard() {
        if (Ipc.micRunning) Ipc.micStop();
        page.step = 0;
        page.results = ["pending", "pending", "pending", "pending", "pending", "pending", "pending", "pending", "pending"];
        page.statusText = "";
        page.syncFromConfig();
        return "wizard-reset";
    }

    function startWizard() {
        page.resetWizard();
        Ipc.refreshDiagnostics();
        return "wizard-started";
    }

    function setResult(index, value, message) {
        const next = page.results.slice(0);
        next[index] = value;
        page.results = next;
        page.statusText = message !== undefined ? message : page.statusText;
    }

    function selectRegion(id) {
        page.regionDraft = id;
        Ipc.writeField("models.region", id);
    }

    function setMemory(value) {
        page.memoryDraft = value;
        Ipc.writeField("rag.autoIngest", value);
    }

    function selectLlmProvider(id) {
        const prev = page.llmProviders.find((p) => p.id === page.llmProviderDraft);
        const next = page.llmProviders.find((p) => p.id === id);
        page.llmProviderDraft = id;
        if (page.llmBaseDraft.length === 0 || page.llmBaseDraft === (prev ? prev.baseUrl : ""))
            page.llmBaseDraft = next ? next.baseUrl : "";
        if (page.llmModelDraft.length === 0 || page.llmModelDraft === (prev ? prev.model : ""))
            page.llmModelDraft = next ? next.model : "";
    }

    function commitCurrentStep() {
        const index = page.step;
        if (index <= 2 || index === 8) {
            if (page.results[index] === "pending" || page.results[index] === "running") page.setResult(index, "pass", "");
        } else if (index === 3) { // region: selection applies immediately, but also allow default
            if (page.results[3] === "pending") page.setResult(3, "pass", "");
        } else if (index === 4) {
            page.setResult(4, "pass", page.memoryDraft ? I18n.t("已开启") : I18n.t("保持关闭"));
        } else if (index === 5) {
            const entries = [{ path: "llm.provider", value: page.llmProviderDraft }];
            if (page.llmBaseDraft.trim().length > 0) entries.push({ path: "llm.baseUrl", value: page.llmBaseDraft.trim() });
            if (page.llmModelDraft.trim().length > 0) entries.push({ path: "llm.model", value: page.llmModelDraft.trim() });
            if (page.llmKeyDraft.trim().length > 0) entries.push({ path: "llm.apiKey", value: page.llmKeyDraft.trim() });
            Ipc.writeFields(entries);
            page.setResult(5, page.llmKeyDraft.trim().length > 0 ? "pass" : "skipped",
                page.llmKeyDraft.trim().length > 0 ? I18n.t("已保存 Key") : I18n.t("稍后再填"));
            page.llmKeyDraft = "";
            if (llmKeyField) llmKeyField.text = "";
        } else if (index === 6) {
            if (page.ttsKeyDraft.trim().length > 0) {
                Ipc.writeField("minimax.apiKey", page.ttsKeyDraft.trim());
                page.setResult(6, "pass", "");
            } else {
                page.setResult(6, "skipped", "");
            }
            page.ttsKeyDraft = "";
            if (ttsKeyField) ttsKeyField.text = "";
        }
    }

    function nextStep() {
        if (page.step >= page.totalSteps - 1) {
            page.step = page.totalSteps;
            page.statusText = "";
            return "wizard-finished";
        }
        page.commitCurrentStep();
        page.step += 1;
        page.statusText = "";
        return "wizard-step-" + page.step;
    }

    function prevStep() {
        if (page.step <= 0) return "wizard-first";
        page.step -= 1;
        return "wizard-step-" + page.step;
    }

    function skipStep() {
        if (page.step >= page.totalSteps) return "finished";
        if (page.step === 7 && Ipc.micRunning) Ipc.micStop();
        page.setResult(page.step, "skipped", "");
        page.nextStep();
        return "wizard-skipped";
    }

    function runSelfTest() {
        page.setResult(7, "running", "");
        page.noiseRms = -1;
        page.micPassed = false;
        // micStart() resets the sample/end counters synchronously, so stamp the
        // start time *before* calling it (otherwise the stray reset edge looks
        // like a finished 3 s window with zero samples).
        page.stepStartedAt = Date.now();
        Ipc.micStart(3000);
        return "wizard-mic-started";
    }

    function markSelfTest() {
        if (page.results[7] !== "running") page.setResult(7, "pass", "");
        return "wizard-selftest-passed";
    }

    function finishWizard() {
        page.commitCurrentStep();
        page.step = page.totalSteps;
        return "wizard-finished";
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
        case "pass": return I18n.t("完成");
        case "fail": return I18n.t("未完成");
        case "running": return I18n.t("进行中…");
        case "skipped": return I18n.t("已跳过");
        default: return I18n.t("未开始");
        }
    }
    function hotkeyLabel() {
        switch (page.hotkeyStateText) {
        case "bound": case "active": return I18n.t("已绑定（") + page.hotkeyText + "）";
        case "unavailable": return I18n.t("不可用（portal 未授权）");
        case "unknown": default: return I18n.t("状态未知");
        }
    }
    function voiceprintLabel() {
        switch (page.voiceprintText) {
        case "ready": return I18n.t("已开启，声纹已注册");
        case "not-enrolled": return I18n.t("已开启，但还没录制声纹");
        case "model-missing": return I18n.t("缺少声纹模型");
        case "disabled": return I18n.t("关闭（可选）");
        default: return I18n.t("未提供（旧 daemon）");
        }
    }
    function summaryRows() {
        return [
            { label: I18n.t("界面语言"), value: I18n.language },
            { label: I18n.t("模型下载地区"), value: page.regionLabel(page.regionDraft) },
            { label: I18n.t("长期记忆"), value: page.memoryDraft ? I18n.t("开启") : I18n.t("关闭") },
            { label: I18n.t("模型服务"), value: page.providerLabel(page.llmProviderDraft) },
            { label: I18n.t("语音服务"), value: Ipc.secretStored("minimax.apiKey") ? I18n.t("MiniMax（Key 已保存）") : I18n.t("稍后配置") },
            { label: I18n.t("自检"), value: page.results[7] === "pass" ? I18n.t("通过") : I18n.t("已跳过") },
        ];
    }
    function regionLabel(id) {
        for (let i = 0; i < page.regions.length; i++) if (page.regions[i].id === id) return page.regions[i].label;
        return id.length > 0 ? id : I18n.t("未选择（自动）");
    }
    function providerLabel(id) {
        for (let i = 0; i < page.llmProviders.length; i++) if (page.llmProviders[i].id === id) return page.llmProviders[i].label;
        return id;
    }
    function openMemoryInfo() {
        page.infoRequested(
            I18n.t("长期记忆与隐私"),
            I18n.t("开启后，费加罗会把对话摘要 / 索引内容发送给你选择的 LLM 和 Embedding 服务商（默认 DeepSeek / MiniMax），用于日后回忆。关闭则只在你说「记住…」时保存。我们没有任何服务器，数据只经过你配置的服务商；记忆数据存在本机，可随时删除 ~/.local/share/figaro/lightrag/data。"),
            "", "");
        return "memory-info";
    }

    function fillLlmDemo() {
        page.selectLlmProvider("openai");
        page.llmBaseDraft = "https://api.openai.com/v1";
        page.llmModelDraft = "gpt-4o-mini";
        page.llmKeyDraft = "sk-test-llm-placeholder";
        llmKeyField.text = page.llmKeyDraft;
        return "wizard-llm-filled";
    }

    function gotoStep(index) {
        page.step = Math.max(0, Math.min(page.totalSteps, Number(index)));
        return "wizard-step-" + page.step;
    }

    function snapshot() {
        return {
            title: I18n.t("新手引导"),
            step: page.step,
            totalSteps: page.totalSteps,
            results: page.results,
            allPassed: page.allDone,
            statusText: page.statusText,
            language: I18n.language,
            region: page.regionDraft,
            memory: page.memoryDraft,
            llmProvider: page.llmProviderDraft,
            llmBaseUrl: page.llmBaseDraft,
            llmModel: page.llmModelDraft,
            llmKeyDraftEmpty: page.llmKeyDraft.length === 0,
            ttsKeyDraftEmpty: page.ttsKeyDraft.length === 0,
            noiseRms: page.noiseRms,
            micPassed: page.micPassed,
            hotkey: page.hotkeyText,
            hotkeyState: page.hotkeyStateText,
            voiceprint: page.voiceprintText,
        };
    }

    Connections {
        target: Ipc
        function onMicEndSeqChanged() {
            if (page.results[7] !== "running") return;
            if (Date.now() - page.stepStartedAt < 1500) return;
            const samples = Ipc.micSamples || [];
            if (samples.length < 10) {
                page.setResult(7, "fail", I18n.t("没有采到足够的麦克风样本"));
                return;
            }
            let sum = 0;
            for (let i = 0; i < samples.length; i++) sum += samples[i];
            page.noiseRms = sum / samples.length;
            page.micPassed = page.noiseRms <= 0.08;
            page.hotkeyText = String(page.diagAsr.hotkey || Ipc.cfg("asr.hotkey", "F9"));
            page.hotkeyStateText = page.diagAsr.hotkeyState && page.diagAsr.hotkeyState.state
                ? String(page.diagAsr.hotkeyState.state) : "unknown";
            page.setResult(7, page.micPassed ? "pass" : "fail",
                page.micPassed ? I18n.t("麦克风正常，环境底噪 ") + page.noiseRms.toFixed(3) : I18n.t("环境有点吵，安静一点再测"));
        }
        function onDiagnosticsLoadedChanged() {
            if (!Ipc.diagnosticsLoaded) return;
            page.hotkeyText = String(page.diagAsr.hotkey || Ipc.cfg("asr.hotkey", "F9"));
            page.hotkeyStateText = page.diagAsr.hotkeyState && page.diagAsr.hotkeyState.state
                ? String(page.diagAsr.hotkeyState.state) : "unknown";
            const speaker = page.diagAsr.speaker;
            page.voiceprintText = speaker && speaker.state ? String(speaker.state) : "unknown";
        }
        function onConfigLoadedChanged() {
            if (Ipc.configLoaded) page.syncFromConfig();
        }
    }

    Component.onCompleted: {
        page.syncFromConfig();
        Ipc.refreshDiagnostics();
    }

    MPageHeader {
        title: I18n.t("新手引导")
        subtitle: I18n.t("9 个步骤，大约 3 分钟；每步都能跳过，之后可在设置里改")
        icon: "wand"
    }

    // ---- progress ----------------------------------------------------------
    MCard {
        RowLayout {
            Layout.fillWidth: true
            spacing: 4
            Repeater {
                model: page.totalSteps
                Item {
                    required property int index
                    Layout.fillWidth: true
                    implicitHeight: 46
                    Rectangle {
                        anchors.horizontalCenter: parent.horizontalCenter
                        y: 2
                        width: 30
                        height: 30
                        radius: 15
                        color: page.results[index] === "pass" ? Theme.green
                            : page.results[index] === "fail" ? Theme.red
                            : page.results[index] === "running" ? Theme.accent
                            : page.results[index] === "skipped" ? Theme.orange
                            : (page.step === index ? Theme.accent : Theme.insetBg)
                        border.width: page.step === index ? 2 : 0
                        border.color: Theme.text
                        Text {
                            anchors.centerIn: parent
                            text: page.results[index] === "pass" ? "✓"
                                : page.results[index] === "skipped" ? "–" : String(index + 1)
                            color: "#ffffff"
                            font.family: Theme.fontSans
                            font.pixelSize: Theme.fsSmall
                            font.weight: Font.DemiBold
                        }
                    }

                }
            }
        }
        Text {
            Layout.fillWidth: true
            text: page.step >= page.totalSteps
                ? I18n.t("全部完成")
                : I18n.t("第 ") + (page.step + 1) + " / " + page.totalSteps + I18n.t(" 步 · ") + page.stepTitles[page.step] + " —— " + page.stepSubtitles[page.step]
            color: Theme.textDim
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
        }
    }

    // ---- current step ------------------------------------------------------
    MCard {
        visible: page.step < page.totalSteps
        title: page.step < page.totalSteps ? page.stepTitles[page.step] : ""
        subtitle: page.step < page.totalSteps ? page.stepSubtitles[page.step] : ""

        // ============ welcome ============
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 10
            visible: page.step === 0
            Text {
                Layout.fillWidth: true
                text: I18n.t("费加罗是一个住在本机的语音助手：喊一声「费加罗」，它就会听你说话、帮你做事。")
                color: Theme.text
                font.family: Theme.fontSans
                font.pixelSize: 20
                font.weight: Font.DemiBold
                wrapMode: Text.WordWrap
                lineHeight: 1.3
            }
            Text {
                Layout.fillWidth: true
                text: I18n.t("唤醒词识别、语音转文字都在你的电脑上完成，不需要联网。")
                    + I18n.t("为了让对话更聪明、声音更好听，需要你选择两个在线服务商并填上自己的 API Key。")
                    + I18n.t("接下来几分钟，我们一步步把它配好。")
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: 15
                wrapMode: Text.WordWrap
                lineHeight: 1.45
            }
            RowLayout {
                spacing: 10
                Rectangle { width: 4; height: 46; radius: 2; color: Theme.accent }
                Text {
                    Layout.fillWidth: true
                    text: I18n.t("没有账号、没有订阅费：你只为自己的 API 用量付费。")
                    color: Theme.text
                    font.family: Theme.fontSans
                    font.pixelSize: 14
                }
            }
        }

        // ============ privacy ============
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 8
            visible: page.step === 1
            Repeater {
                model: [
                    { icon: "mic", text: I18n.t("唤醒和语音识别：全程在本机运行，音频不上传。") },
                    { icon: "key", text: I18n.t("API Key：只写进本机 config.json（权限 600），不上传给我们，也不写日志。") },
                    { icon: "chat", text: I18n.t("对话和语音合成：只发送给你自己配置的 LLM / TTS 服务商。") },
                    { icon: "warning", text: I18n.t("没有遥测、没有账号、没有我们的服务器；不想要了直接卸载。") },
                    { icon: "folder", text: I18n.t("长期记忆数据在 ~/.local/share/figaro/lightrag/data，随时可以删。") },
                ]
                RowLayout {
                    required property var modelData
                    Layout.fillWidth: true
                    spacing: 10
                    Rectangle {
                        width: 32; height: 32; radius: 9
                        color: Qt.rgba(0.04, 0.52, 1.0, 0.15)
                        MIcon { anchors.centerIn: parent; kind: modelData.icon; size: 16; color: Theme.accent }
                    }
                    Text {
                        Layout.fillWidth: true
                        text: modelData.text
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 15
                        wrapMode: Text.WordWrap
                    }
                }
            }
        }

        // ============ language ============
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 8
            visible: page.step === 2
            RowLayout {
                Layout.fillWidth: true
                spacing: 10
                Repeater {
                    model: [
                        { id: "zh-CN", label: I18n.t("简体中文"), sub: I18n.t("中国大陆") },
                        { id: "zh-TW", label: I18n.t("繁體中文"), sub: I18n.t("台灣 / 香港 / 澳門") },
                        { id: "en", label: "English", sub: "English" },
                    ]
                    Rectangle {
                        required property var modelData
                        Layout.fillWidth: true
                        implicitHeight: 96
                        radius: 12
                        color: I18n.language === modelData.id ? Qt.rgba(0.04, 0.52, 1.0, 0.18) : Theme.insetBg
                        border.width: I18n.language === modelData.id ? 1.5 : 0.5
                        border.color: I18n.language === modelData.id ? Theme.accent : Qt.rgba(1, 1, 1, 0.10)
                        ColumnLayout {
                            anchors.centerIn: parent
                            spacing: 4
                            Text {
                                Layout.alignment: Qt.AlignHCenter
                                text: modelData.label
                                color: Theme.text
                                font.family: Theme.fontSans
                                font.pixelSize: 18
                                font.weight: Font.DemiBold
                            }
                            Text {
                                Layout.alignment: Qt.AlignHCenter
                                text: modelData.sub
                                color: Theme.textFaint
                                font.family: Theme.fontSans
                                font.pixelSize: Theme.fsSmall
                            }
                        }
                        MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                I18n.setLanguage(modelData.id);
                                page.setResult(2, "pass", "");
                            }
                        }
                    }
                }
            }
            Text {
                Layout.fillWidth: true
                text: I18n.t("选完立即生效；之后可以在「外观 → 语言」里随时改。")
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }

        // ============ region ============
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 8
            visible: page.step === 3
            Repeater {
                model: page.regions
                Rectangle {
                    required property var modelData
                    Layout.fillWidth: true
                    implicitHeight: regionRow.implicitHeight + 22
                    radius: 10
                    color: page.regionDraft === modelData.id ? Qt.rgba(0.04, 0.52, 1.0, 0.16) : Theme.insetBg
                    border.width: page.regionDraft === modelData.id ? 1.5 : 0.5
                    border.color: page.regionDraft === modelData.id ? Theme.accent : Qt.rgba(1, 1, 1, 0.10)
                    RowLayout {
                        id: regionRow
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        anchors.margins: 11
                        spacing: 10
                        MIcon {
                            kind: "folder"; size: 18
                            color: page.regionDraft === modelData.id ? Theme.accent : Theme.textDim
                        }
                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 2
                            Text {
                                text: modelData.label
                                color: Theme.text
                                font.family: Theme.fontSans
                                font.pixelSize: 16
                                font.weight: Font.DemiBold
                            }
                            Text {
                                Layout.fillWidth: true
                                text: modelData.desc
                                color: Theme.textDim
                                font.family: Theme.fontSans
                                font.pixelSize: Theme.fsSmall
                                wrapMode: Text.WordWrap
                            }
                        }
                    }
                    MouseArea {
                        anchors.fill: parent
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                            page.selectRegion(modelData.id);
                            page.setResult(3, "pass", "");
                        }
                    }
                }
            }
            Text {
                Layout.fillWidth: true
                text: I18n.t("选择只影响「第一次下载模型」走哪个源，不影响功能；以后可以在设置里改。")
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }

        // ============ long-term memory ============
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 8
            visible: page.step === 4
            RowLayout {
                Layout.fillWidth: true
                spacing: 10
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 3
                    RowLayout {
                        spacing: 6
                        Text {
                            text: I18n.t("长期记忆（自动入库）")
                            color: Theme.text
                            font.family: Theme.fontSans
                            font.pixelSize: 18
                            font.weight: Font.DemiBold
                        }
                        MIcon {
                            kind: "info"; size: 15; color: Theme.accent
                            MouseArea {
                                anchors.fill: parent
                                cursorShape: Qt.PointingHandCursor
                                onClicked: page.openMemoryInfo()
                            }
                        }
                    }
                    Text {
                        Layout.fillWidth: true
                        text: I18n.t("默认关闭。开启后，对话摘要会发给你选的 LLM / Embedding 服务商，用于以后回忆；关闭时只有你说「记住…」才保存。")
                        color: Theme.textDim
                        font.family: Theme.fontSans
                        font.pixelSize: 14
                        wrapMode: Text.WordWrap
                        lineHeight: 1.4
                    }
                }
                MToggle {
                    checked: page.memoryDraft
                    onToggled: (value) => {
                        page.setMemory(value);
                        page.setResult(4, "pass", "");
                    }
                }
            }
            Rectangle {
                Layout.fillWidth: true
                implicitHeight: 46
                radius: 8
                color: page.memoryDraft ? Qt.rgba(1.0, 0.62, 0.04, 0.12) : Qt.rgba(1, 1, 1, 0.05)
                Text {
                    anchors.fill: parent
                    anchors.margins: 10
                    verticalAlignment: Text.AlignVCenter
                    text: page.memoryDraft
                        ? I18n.t("已开启：对话摘要会发送给你配置的服务商。我们没有任何服务器。")
                        : I18n.t("已关闭：只有你明确说「记住…」时才会保存。推荐保持关闭。")
                    color: page.memoryDraft ? Theme.orange : Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    wrapMode: Text.WordWrap
                }
            }
        }

        // ============ LLM provider ============
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 8
            visible: page.step === 5
            Text {
                Layout.fillWidth: true
                text: I18n.t("费加罗需要一个大模型来理解你说的话。我们无法直接提供高质量实时的 LLM 服务，所以需要你自己的 API Key。")
                color: Theme.text
                font.family: Theme.fontSans
                font.pixelSize: 15
                wrapMode: Text.WordWrap
                lineHeight: 1.4
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                Repeater {
                    model: page.llmProviders
                    Rectangle {
                        required property var modelData
                        Layout.fillWidth: true
                        implicitHeight: 44
                        radius: 9
                        color: page.llmProviderDraft === modelData.id ? Qt.rgba(0.04, 0.52, 1.0, 0.18) : Theme.insetBg
                        border.width: page.llmProviderDraft === modelData.id ? 1.5 : 0.5
                        border.color: page.llmProviderDraft === modelData.id ? Theme.accent : Qt.rgba(1, 1, 1, 0.10)
                        Text {
                            anchors.centerIn: parent
                            text: modelData.label
                            color: Theme.text
                            font.family: Theme.fontSans
                            font.pixelSize: 14
                            font.weight: page.llmProviderDraft === modelData.id ? Font.DemiBold : Font.Normal
                        }
                        MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: page.selectLlmProvider(modelData.id)
                        }
                    }
                }
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                MTextField {
                    id: llmKeyField
                    Layout.fillWidth: true
                    password: true
                    placeholder: I18n.t("粘贴 ") + page.providerLabel(page.llmProviderDraft) + I18n.t(" 的 API Key（也可以稍后再填）")
                    onEdited: (value) => page.llmKeyDraft = value
                }
                MButton {
                    visible: page.llmProviders.find((p) => p.id === page.llmProviderDraft) !== undefined
                        && page.llmProviders.find((p) => p.id === page.llmProviderDraft).keyUrl.length > 0
                    text: I18n.t("获取 Key →")
                    onClicked: {
                        const provider = page.llmProviders.find((p) => p.id === page.llmProviderDraft);
                        Qt.openUrlExternally(provider.keyUrl);
                    }
                }
            }
            Text {
                Layout.fillWidth: true
                text: I18n.t("Key 只保存在本机（权限 600），不会上传给我们。OpenAI / Gemini / 自定义端点同样支持；")
                    + I18n.t("自定义可填 Ollama / vLLM 等 OpenAI 兼容地址。")
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
                wrapMode: Text.WordWrap
            }
        }

        // ============ TTS provider ============
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 8
            visible: page.step === 6
            Text {
                Layout.fillWidth: true
                text: I18n.t("费加罗还需要一个「嗓子」把回复读出来。语音识别是本地的，不需要 Key；合成语音需要 TTS 服务商。")
                color: Theme.text
                font.family: Theme.fontSans
                font.pixelSize: 15
                wrapMode: Text.WordWrap
                lineHeight: 1.4
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                MTextField {
                    id: ttsKeyField
                    Layout.fillWidth: true
                    password: true
                    placeholder: I18n.t("粘贴 MiniMax API Key（也可以稍后再填）")
                    onEdited: (value) => page.ttsKeyDraft = value
                }
                MButton {
                    text: I18n.t("获取 Key →")
                    onClicked: Qt.openUrlExternally("https://platform.minimaxi.com/user-center/basic-information/interface-key")
                }
            }
            Text {
                Layout.fillWidth: true
                text: I18n.t("MiniMax 是推荐服务商，不是唯一选择。Key 只保存在本机，用于语音合成。")
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
                wrapMode: Text.WordWrap
            }
        }

        // ============ self test ============
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 8
            visible: page.step === 7
            Text {
                Layout.fillWidth: true
                text: I18n.t("最后检查一下：对着麦克风保持安静 3 秒，我们会测一下麦克风是否正常。")
                color: Theme.text
                font.family: Theme.fontSans
                font.pixelSize: 15
                wrapMode: Text.WordWrap
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                MButton {
                    text: page.results[7] === "running" ? I18n.t("测试中…") : I18n.t("测试麦克风")
                    primary: true
                    icon: "mic"
                    enabled: page.results[7] !== "running"
                    onClicked: page.runSelfTest()
                }
                MButton {
                    text: I18n.t("我按过热键了，没问题")
                    enabled: page.results[7] !== "running"
                    onClicked: page.markSelfTest()
                }
                Item { Layout.fillWidth: true }
            }
            MLevelMeter {
                Layout.fillWidth: true
                Layout.preferredHeight: 20
                level: Ipc.mic.level !== undefined ? Ipc.mic.level : 0
                peak: Ipc.mic.peak !== undefined ? Ipc.mic.peak : 0
                clipped: Ipc.micClipped
            }
            Rectangle {
                Layout.fillWidth: true
                implicitHeight: statusCol.implicitHeight + 20
                radius: 9
                color: Theme.insetBg
                ColumnLayout {
                    id: statusCol
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.margins: 10
                    spacing: 4
                    Text {
                        text: I18n.t("麦克风：") + (page.results[7] === "pass" ? I18n.t("正常")
                            : page.results[7] === "running" ? I18n.t("测试中…")
                            : page.results[7] === "fail" ? I18n.t("需要再试一次") : I18n.t("还没测试"))
                            + (page.noiseRms >= 0 ? I18n.t("（底噪 ") + page.noiseRms.toFixed(3) + "）" : "")
                        color: page.results[7] === "pass" ? Theme.green
                            : page.results[7] === "fail" ? Theme.red : Theme.textDim
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsSmall
                    }
                    Text {
                        text: I18n.t("热键：") + page.hotkeyLabel()
                        color: Theme.textDim
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsSmall
                        wrapMode: Text.WordWrap
                    }
                    Text {
                        text: I18n.t("声纹：") + page.voiceprintLabel()
                        color: Theme.textDim
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsSmall
                        wrapMode: Text.WordWrap
                    }
                }
            }
            Text {
                Layout.fillWidth: true
                text: I18n.t("热键和声纹都可以跳过：热键要在系统弹窗里允许一次；声纹在「唤醒」页随时可以录。")
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
                wrapMode: Text.WordWrap
            }
        }

        // ---- navigation ----
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            MButton {
                visible: page.step > 0
                text: I18n.t("← 上一步")
                onClicked: page.prevStep()
            }
            Item { Layout.fillWidth: true }
            MButton {
                visible: page.step < page.totalSteps - 1
                text: I18n.t("跳过这一步")
                onClicked: page.skipStep()
            }
            MButton {
                visible: page.step < page.totalSteps - 1
                text: page.step === 0 ? I18n.t("开始配置 →") : I18n.t("下一步 →")
                primary: true
                onClicked: page.nextStep()
            }
            MButton {
                visible: page.step === page.totalSteps - 1
                text: I18n.t("完成引导 ✓")
                primary: true
                onClicked: {
                    page.markSelfTest();
                    page.finishWizard();
                }
            }
        }
        Text {
            visible: page.statusText.length > 0
            Layout.fillWidth: true
            text: page.statusText
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
        }
    }

    // ---- summary -----------------------------------------------------------
    MCard {
        visible: page.step >= page.totalSteps
        title: I18n.t("全部完成 ✓")
        subtitle: I18n.t("费加罗已经准备好了；这些设置之后都能在左侧页面里修改")

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6
            Repeater {
                model: page.summaryRows()
                RowLayout {
                    required property var modelData
                    Layout.fillWidth: true
                    spacing: 10
                    Text {
                        Layout.fillWidth: true
                        text: modelData.label
                        color: Theme.textDim
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fs
                    }
                    Text {
                        text: modelData.value
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fs
                        font.weight: Font.DemiBold
                    }
                }
            }
        }
        Text {
            Layout.fillWidth: true
            text: page.memoryDraft
                ? I18n.t("长期记忆已开启：对话摘要会发给你选择的 LLM / Embedding 服务商；我们没有任何服务器。")
                : I18n.t("长期记忆保持关闭：只有你说「记住…」时才会保存。")
            color: page.memoryDraft ? Theme.orange : Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: Text.WordWrap
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            MButton {
                text: I18n.t("重新走一遍")
                icon: "refresh"
                onClicked: page.resetWizard()
            }
            MButton {
                text: I18n.t("进入费加罗")
                primary: true
                onClicked: page.goOverview()
            }
            Item { Layout.fillWidth: true }
        }
    }
}
