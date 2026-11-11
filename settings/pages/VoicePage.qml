import QtQuick
import QtQuick.Layouts
import Quickshell.Io
import ".."
import "../components"

MPageScroll {
    id: page

    signal infoRequested(string title, string body, string linkLabel, string linkUrl)

    property string sink: ""
    property string voiceId: ""
    property string draftSink: ""
    property bool editingSink: false
    property real speed: 1.0
    property bool ackEnabled: true
    property var ackPhrases: []
    property bool editingPhrases: false
    property string draftPhrases: ""
    property string previewText: I18n.t("你好，我是费加罗。今天想帮你做点什么？")
    property int previewSeq: 0
    property bool sfxEnabled: true
    property real sfxVolume: 0.35

    readonly property var ttsInfo: (Ipc.diagnostics.tts || ({}))
    readonly property var ackInfo: (Ipc.diagnostics.ack || ({}))
    readonly property var sinks: (Array.isArray(page.ttsInfo.sinks) ? page.ttsInfo.sinks : [])
    readonly property bool ttsSupported: !Ipc.unsupported("test.tts")
    // Voices already benchmarked on this machine (tests/tts/bench-voice.mjs).
    readonly property var voiceCandidates: [
        { id: "male-qn-jingying", label: I18n.t("精英青年音色（当前默认）") },
        { id: "male-qn-qingse", label: I18n.t("青涩青年音色") },
        { id: "Chinese (Mandarin)_Gentleman", label: I18n.t("温润男声") },
        { id: "Chinese (Mandarin)_Radio_Host", label: I18n.t("电台男主播") },
        { id: "Chinese (Mandarin)_Male_Announcer", label: I18n.t("播报男声") },
    ]

    function openMinimaxInfo() {
        page.infoRequested(
            I18n.t("MiniMax · 推荐语音服务商"),
            I18n.t("我们无法直接提供高质量的实时 TTS 服务，需要你自己向服务商申请 API Key。Key 只保存在本机 config.json（权限 600），不会上传给我们，也不会写进日志。MiniMax 是推荐服务商，不是唯一选择。"),
            I18n.t("打开 MiniMax 控制台"),
            "https://platform.minimaxi.com/user-center/basic-information/interface-key");
        return "minimax-info";
    }

    function syncFromConfig() {
        page.sink = String(Ipc.cfg("tts.sink", "") || "");
        page.draftSink = "";
        page.voiceId = String(Ipc.cfg("tts.voiceId", Ipc.cfg("minimax.voiceId", "male-qn-jingying")));
        page.speed = Number(Ipc.cfg("tts.speed", Ipc.cfg("minimax.speed", 1.0)));
        page.ackEnabled = Ipc.cfg("tts.ack.enabled", true) !== false;
        const phrases = Ipc.cfg("tts.ack.phrases", []);
        page.ackPhrases = Array.isArray(phrases) ? phrases : [];
        page.sfxEnabled = Ipc.cfg("sfx.enabled", true) !== false;
        page.sfxVolume = Number(Ipc.cfg("sfx.volume", 0.35));
    }

    // The daemon returns [{name, description, isDefault, isCurrent}]; the fake
    // daemon uses {id, label}. Accept both shapes.
    function sinkItems() {
        const items = [{ id: "", label: I18n.t("系统默认输出") }];
        for (let i = 0; i < page.sinks.length; i++) {
            const s = page.sinks[i];
            const id = String(s.name !== undefined ? s.name : (s.id !== undefined ? s.id : s));
            let label = String(s.description !== undefined && s.description.length > 0 ? s.description
                : (s.label !== undefined ? s.label : id));
            if (s.isDefault) label += I18n.t(" · 默认");
            if (s.isCurrent) label += I18n.t(" · 当前");
            items.push({ id: id, label: label });
        }
        return items;
    }

    function applySink(value) {
        page.sink = value;
        Ipc.applyPatch({ tts: { sink: value } });
    }

    function setSfxEnabled(value) {
        page.sfxEnabled = value;
        Ipc.writeField("sfx.enabled", value);
    }

    function setSfxVolume(value) {
        const v = Math.round(value * 100) / 100;
        page.sfxVolume = v;
        Ipc.writeField("sfx.volume", v);
    }

    function applySpeed(value) {
        const v = Math.round(value * 20) / 20;
        page.speed = v;
        Ipc.writeField("tts.speed", v);
    }

    function voiceLabel() {
        for (let i = 0; i < page.voiceCandidates.length; i++)
            if (page.voiceCandidates[i].id === page.voiceId) return page.voiceCandidates[i].label;
        return page.voiceId.length > 0 ? page.voiceId : I18n.t("未设置");
    }

    function setVoiceId(id) {
        page.voiceId = id;
        Ipc.writeField("tts.voiceId", id);
    }

    function previewVoice() {
        const text = page.previewText.trim().length > 0 ? page.previewText.trim() : I18n.t("你好，我是费加罗。");
        page.previewSeq += 1;
        Ipc.ttsTest(text, page.voiceId);
        return "tts-preview:" + text;
    }

    function previewAck() {
        let phrase = "我在";
        if (page.ackPhrases.length > 0)
            phrase = String(page.ackPhrases[page.previewSeq % page.ackPhrases.length]);
        Ipc.ttsTest(phrase);
        page.previewSeq += 1;
        return "tts-preview-ack:" + phrase;
    }

    function savePhrases() {
        const parts = page.draftPhrases.split(/[，,]/);
        const list = [];
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i].trim();
            if (p.length > 0) list.push(p);
        }
        page.ackPhrases = list;
        Ipc.applyPatch({ tts: { ack: { phrases: list } } });
        page.editingPhrases = false;
    }

    function demoWrite() {
        Ipc.writeField("tts.voiceId", "male-qn-qingse");
        return "voice-demo-written";
    }

    function demoSfxWrite() {
        page.sfxEnabled = true;
        page.sfxVolume = 0.5;
        Ipc.writeFields([
            { path: "sfx.enabled", value: true },
            { path: "sfx.volume", value: 0.5 },
        ]);
        return "sfx-demo-written";
    }

    function snapshot() {
        return {
            title: I18n.t("语音"),
            sink: page.sink,
            voiceId: page.voiceId,
            speed: page.speed,
            sfxEnabled: page.sfxEnabled,
            sfxVolume: page.sfxVolume,
            ackEnabled: page.ackEnabled,
            ackPhrases: page.ackPhrases,
            ttsSupported: page.ttsSupported,
            running: Ipc.ttsRunning,
            lastResult: Ipc.ttsResult,
            candidateSinks: page.sinks.length,
        };
    }

    Connections {
        target: Ipc
        function onConfigChanged() { page.syncFromConfig(); }
    }

    Component.onCompleted: page.syncFromConfig()

    MPageHeader {
        title: I18n.t("语音")
        subtitle: I18n.t("输出设备、音色试听、语速与唤醒应答")
        icon: "speaker"
    }

    MCard {
        title: I18n.t("输出设备")

        MRow {
            label: I18n.t("输出 sink")
            subtitle: I18n.t("写入 tts.sink · 空 = 系统默认输出")
            showSeparator: page.editingSink
            MDropdown {
                items: page.sinkItems()
                currentId: page.sink
                placeholder: I18n.t("选择输出设备…")
                onPicked: (id) => page.applySink(id)
            }
        }
        MRow {
            label: I18n.t("手动填写")
            subtitle: I18n.t("诊断接口没有候选 sink 时，直接输入 PipeWire/PulseAudio sink 名")
            showSeparator: false
            RowLayout {
                spacing: 8
                MTextField {
                    inputWidth: 230
                    text: page.draftSink
                    placeholder: "alsa_output.…"
                    onEdited: (value) => page.draftSink = value
                }
                MButton {
                    text: I18n.t("应用")
                    onClicked: page.applySink(page.draftSink.trim())
                }
            }
        }
        Text {
            visible: Ipc.unsupported("config.get")
            Layout.fillWidth: true
            text: I18n.t("当前 daemon 不支持 config.get：sink/语速/应答设置显示默认值，修改不会生效。")
            color: Theme.yellow
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: Text.WordWrap
        }
        Text {
            Layout.fillWidth: true
            text: I18n.t("当前：") + (page.sink.length > 0 ? page.sink : I18n.t("系统默认"))
                + (page.ttsInfo.sinkStatus ? I18n.t("  ·  sink 状态 ") + page.ttsInfo.sinkStatus : "")
                + (page.sinks.length > 0 ? I18n.t("  ·  诊断提供 ") + page.sinks.length + I18n.t(" 个候选") : "")
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: Text.WordWrap
        }
    }

    // -------------------------------------------------------------- 音色
    MCard {
        title: I18n.t("音色")
        subtitle: I18n.t("tts.voiceId · 已在本机实测过的男声候选；改动会重建 TTS 连接（热生效，约 0.2–0.4 s 首字延迟）")

        MRow {
            label: I18n.t("音色")
            subtitle: I18n.t("当前：") + page.voiceLabel() + "（" + (page.voiceId.length > 0 ? page.voiceId : I18n.t("未设置")) + "）"
            RowLayout {
                spacing: 8
                MApplyStatus { paths: ["tts.voiceId"] }
                MDropdown {
                    items: page.voiceCandidates
                    currentId: page.voiceId
                    placeholder: I18n.t("选择音色…")
                    onPicked: (id) => page.setVoiceId(id)
                }
            }
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            MButton {
                text: I18n.t("试听当前音色")
                icon: "play"
                enabled: Ipc.connected && page.ttsSupported && !Ipc.ttsRunning
                onClicked: page.previewVoice()
            }
            Text {
                Layout.fillWidth: true
                text: I18n.t("实测（speech-2.6-turbo × 5 音色）：首字延迟 189–239 ms，生成 308–379 ms，语速 4.66–5.82 字/秒")
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsTiny
                wrapMode: Text.WordWrap
            }
        }
    }

    // ---------------------------------------------- 推荐语音服务商 MiniMax
    MCard {
        title: I18n.t("推荐语音服务商")
        subtitle: I18n.t("费加罗的「嗓子」：把回复读出来需要 TTS 服务商；语音识别是本地的，不需要 Key")

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: minimaxLayout.implicitHeight + 24
            radius: 10
            color: Theme.insetBg
            border.width: 0.5
            border.color: Qt.rgba(1, 1, 1, 0.08)

            ColumnLayout {
                id: minimaxLayout
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: 12
                spacing: 6

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    Text {
                        text: "MiniMax"
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 14
                        font.weight: Font.DemiBold
                    }
                    MPill {
                        text: I18n.t("推荐服务商")
                        tone: Theme.accent
                    }
                    MIcon {
                        kind: "info"
                        size: 15
                        color: Theme.accent
                        MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: page.openMinimaxInfo()
                        }
                    }
                    Item { Layout.fillWidth: true }
                    MButton {
                        text: I18n.t("获取 API Key →")
                        onClicked: Qt.openUrlExternally("https://platform.minimaxi.com/user-center/basic-information/interface-key")
                    }
                }
                Text {
                    Layout.fillWidth: true
                    text: I18n.t("音色自然、延迟低，费加罗的默认 TTS 选择；Key 填在「连接」页的 MiniMax API Key 里。")
                    color: Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    wrapMode: Text.WordWrap
                }
            }
        }
        Text {
            Layout.fillWidth: true
            text: I18n.t("推荐服务商，非唯一选择；语音识别/唤醒词完全本地运行，不需要任何 Key。")
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WordWrap
        }
    }

    MCard {
        title: I18n.t("音色试听")
        subtitle: I18n.t("test.tts：走和回复相同的 TTS 链路与输出设备，测首字延迟")
        contentSpacing: 14

        Rectangle {
            visible: !page.ttsSupported
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
                    text: I18n.t("当前 daemon 不支持此功能（test.tts 未响应）。")
                    color: Theme.yellow
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            MTextField {
                Layout.fillWidth: true
                text: page.previewText
                placeholder: I18n.t("试听文本")
                onEdited: (value) => page.previewText = value
            }
            MButton {
                text: Ipc.ttsRunning ? I18n.t("合成中…") : I18n.t("试听")
                icon: "play"
                primary: true
                enabled: Ipc.connected && page.ttsSupported && !Ipc.ttsRunning
                onClicked: page.previewVoice()
            }
            MButton {
                text: I18n.t("试听应答")
                enabled: Ipc.connected && page.ttsSupported && !Ipc.ttsRunning
                onClicked: page.previewAck()
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 12
            MStat {
                label: I18n.t("首字延迟")
                value: Ipc.ttsResult.ms !== undefined ? String(Ipc.ttsResult.ms) : "—"
                unit: "ms"
                tone: Ipc.ttsResult.ms !== undefined && Ipc.ttsResult.ms < 500 ? Theme.green : Theme.orange
                hint: I18n.t("合成 + 交给播放器")
            }
            MStat {
                label: I18n.t("合成耗时")
                value: Ipc.ttsResult.synthMs !== undefined ? String(Ipc.ttsResult.synthMs) : "—"
                unit: "ms"
                tone: Theme.text
            }
            MStat {
                label: I18n.t("音频时长")
                value: Ipc.ttsResult.durationMs !== undefined ? String(Ipc.ttsResult.durationMs) : "—"
                unit: "ms"
                tone: Theme.text
                hint: Ipc.ttsResult.sampleRate !== undefined ? Ipc.ttsResult.sampleRate + " Hz" : ""
            }
            MStat {
                label: I18n.t("结果")
                value: Ipc.ttsResult.ok === undefined ? "—" : (Ipc.ttsResult.ok ? I18n.t("成功") : I18n.t("失败"))
                tone: Ipc.ttsResult.ok === false ? Theme.red : (Ipc.ttsResult.ok ? Theme.green : Theme.textDim)
                hint: Ipc.ttsResult.error !== undefined ? String(Ipc.ttsResult.error) : ""
            }
        }
    }

    // -------------------------------------------------------------- 音效
    MCard {
        title: I18n.t("音效")
        subtitle: I18n.t("界面提示音（唤醒 / 采集结束 / 回答结束 / 退下 / 错误）· sfx.* · 音效比语音低 4–6 dB，不会盖住说话")

        MRow {
            label: I18n.t("音效开关")
            subtitle: I18n.t("sfx.enabled · 5 个短音，走和语音同一个输出 sink")
            RowLayout {
                spacing: 8
                MApplyStatus { paths: ["sfx.enabled"] }
                MToggle {
                    checked: page.sfxEnabled
                    onToggled: (value) => page.setSfxEnabled(value)
                }
            }
        }
        MRow {
            label: I18n.t("音效音量")
            subtitle: I18n.t("sfx.volume · 0–1（默认 0.35，比语音低 4–6 dB）")
            showSeparator: false
            RowLayout {
                spacing: 8
                Text {
                    text: Math.round(page.sfxVolume * 100) + "%"
                    color: Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    Layout.preferredWidth: 44
                    horizontalAlignment: Text.AlignRight
                }
                MSlider {
                    Layout.preferredWidth: 170
                    from: 0
                    to: 1
                    value: page.sfxVolume
                    markers: [0.35]
                    onMoved: (v) => page.setSfxVolume(v)
                }
                MApplyStatus { paths: ["sfx.volume"] }
            }
        }
        Text {
            Layout.fillWidth: true
            text: I18n.t("说明：音效与语音共用同一个 sink，做成短促的一声（约 100–300 ms）；音量刻意压低，")
                + I18n.t("不会盖住正在说的话。改动立即生效，无需重启 daemon。")
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WordWrap
        }
    }

    MAdvancedCard {
        title: I18n.t("高级 · 语速")
        subtitle: I18n.t("写入 tts.speed（MiniMax 语速倍率）")

        MRow {
            label: I18n.t("语速")
            subtitle: I18n.t("0.6× 更慢 · 1.0× 正常 · 1.8× 更快")
            showSeparator: false
            RowLayout {
                spacing: 8
                Text {
                    text: page.speed.toFixed(2) + "×"
                    color: Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    Layout.preferredWidth: 52
                    horizontalAlignment: Text.AlignRight
                }
                MSlider {
                    Layout.preferredWidth: 170
                    from: 0.6
                    to: 1.8
                    value: page.speed
                    markers: [1.0]
                    onMoved: (v) => page.applySpeed(v)
                }
                MApplyStatus { paths: ["tts.speed"] }
            }
        }
    }

    MAdvancedCard {
        title: I18n.t("高级 · 唤醒应答")
        subtitle: I18n.t("唤醒后立刻播报的短语（tts.ack.*），把“听到了”的反馈压到最短")

        MRow {
            label: I18n.t("开启应答")
            subtitle: I18n.t("写入 tts.ack.enabled")
            MToggle {
                checked: page.ackEnabled
                onToggled: (value) => {
                    page.ackEnabled = value;
                    Ipc.applyPatch({ tts: { ack: { enabled: value } } });
                }
            }
        }
        MRow {
            label: I18n.t("应答短语")
            subtitle: page.editingPhrases ? I18n.t("逗号分隔") : (page.ackPhrases.length > 0 ? page.ackPhrases.join(" / ") : I18n.t("未设置"))
            visible: !page.editingPhrases
            MButton {
                text: I18n.t("编辑短语")
                icon: "sliders"
                onClicked: {
                    page.editingPhrases = true;
                    page.draftPhrases = page.ackPhrases.join(", ");
                }
            }
        }
        Item {
            visible: page.editingPhrases
            Layout.fillWidth: true
            Layout.preferredHeight: 40
            RowLayout {
                anchors.fill: parent
                spacing: 8
                MTextField {
                    Layout.fillWidth: true
                    text: page.draftPhrases
                    placeholder: I18n.t("我在, 在的, 请指示")
                }
                MButton {
                    text: I18n.t("保存")
                    primary: true
                    onClicked: page.savePhrases()
                }
                MButton {
                    text: I18n.t("取消")
                    onClicked: page.editingPhrases = false;
                }
            }
        }
        MRow {
            label: I18n.t("应答超时")
            subtitle: I18n.t("超过该时间没合成出来就跳过应答 · tts.ack.timeoutMs")
            showSeparator: false
            Text {
                text: String(Ipc.cfg("tts.ack.timeoutMs", 800)) + " ms"
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
        Text {
            visible: Ipc.configErrors.length > 0
            Layout.fillWidth: true
            text: I18n.t("daemon 拒绝：") + Ipc.configErrors.join("；")
            color: Theme.orange
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: Text.WordWrap
        }
    }
}
