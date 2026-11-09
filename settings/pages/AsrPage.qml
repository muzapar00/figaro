import QtQuick
import QtQuick.Layouts
import Quickshell.Io
import ".."
import "../components"

MPageScroll {
    id: page

    readonly property string referenceText: "费加罗，帮我打开设置面板，把灵敏度调到低档"
    readonly property var result: (Ipc.asrResult || ({}))
    readonly property bool asrSupported: !Ipc.unsupported("test.asr.start")

    // ---- ASR model directory (null = repo bundled bilingual model) --------
    property string modelDirDraft: ""
    property string modelCheckText: ""
    property bool modelCheckRunning: false
    readonly property string effectiveModelDir: String(Ipc.cfg("asr.modelDir", "") || "")
    readonly property bool modelDirCustom: page.effectiveModelDir.length > 0

    function applyModelDir() {
        const value = page.modelDirDraft.trim();
        page.modelCheckText = "";
        if (value.length === 0) {
            Ipc.writeField("asr.modelDir", null);
            page.modelCheckText = "已恢复为仓库自带模型";
            return "model-dir-default";
        }
        page.modelCheckRunning = true;
        modelCheck.exec(["sh", "-c",
            'd="$1"; for f in encoder.onnx decoder.onnx joiner.onnx tokens.txt; do '
            + '[ -e "$d/$f" ] || { echo "missing: $f"; exit 3; }; done; echo ok',
            "sh", value]);
        return "model-dir-checking";
    }

    function resetModelDir() {
        page.modelDirDraft = "";
        page.modelCheckText = "";
        if (modelDirField) modelDirField.text = "";
        Ipc.writeField("asr.modelDir", null);
        return "model-dir-default";
    }

    // ---- accuracy helpers --------------------------------------------------
    function normalize(text) {
        if (!text) return "";
        return String(text).replace(/[\\s，。！？、,.!?;；:：""''（）()《》<>\\-—…·]/g, "");
    }

    function editDistance(a, b) {
        const m = a.length;
        const n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;
        let prev = new Array(n + 1);
        let cur = new Array(n + 1);
        for (let j = 0; j <= n; j++) prev[j] = j;
        for (let i = 1; i <= m; i++) {
            cur[0] = i;
            for (let j = 1; j <= n; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            }
            const tmp = prev;
            prev = cur;
            cur = tmp;
        }
        return prev[n];
    }

    function accuracy(text) {
        const ref = page.normalize(page.referenceText);
        const hyp = page.normalize(text);
        if (ref.length === 0) return 0;
        const dist = page.editDistance(ref, hyp);
        return Math.max(0, Math.min(1, 1 - dist / ref.length));
    }

    function accuracyText(text) {
        if (!text) return "—";
        return (page.accuracy(text) * 100).toFixed(1) + "%";
    }

    function accuracyTone(text) {
        if (!text) return Theme.textDim;
        const a = page.accuracy(text);
        if (a >= 0.9) return Theme.green;
        if (a >= 0.7) return Theme.yellow;
        return Theme.red;
    }

    function startRecognitionTest() {
        Ipc.asrStart();
        return "asr-test-started";
    }

    function stopRecognitionTest() {
        Ipc.asrStop();
        return "asr-test-stopped";
    }

    function snapshot() {
        return {
            title: "识别",
            running: Ipc.asrRunning,
            partials: Ipc.asrPartials.length,
            lastPartial: Ipc.asrPartials.length > 0 ? Ipc.asrPartials[Ipc.asrPartials.length - 1].text : "",
            final: page.result.text !== undefined ? page.result.text : "",
            streamingFinal: page.result.streamingText !== undefined ? page.result.streamingText : "",
            ms: page.result.ms !== undefined ? page.result.ms : null,
            audioMs: page.result.audioMs !== undefined ? page.result.audioMs : null,
            accuracy: page.result.text !== undefined ? Math.round(page.accuracy(page.result.text) * 1000) / 1000 : null,
        };
    }

    Process {
        id: modelCheck
        running: false
        stdout: StdioCollector {
            onStreamFinished: modelCheck.checkOutput = this.text
        }
        property string checkOutput: ""
        onExited: (code, status) => {
            page.modelCheckRunning = false;
            if (code === 0) {
                page.modelCheckText = "目录校验通过（encoder/decoder/joiner/tokens 都在）";
                Ipc.writeField("asr.modelDir", page.modelDirDraft.trim());
            } else {
                page.modelCheckText = "目录里缺少模型文件："
                    + (modelCheck.checkOutput.length > 0 ? modelCheck.checkOutput.trim() : "encoder/decoder/joiner/tokens");
            }
        }
    }

    Connections {
        target: Ipc
        function onConfigChanged() {
            if (page.modelDirDraft.length === 0) page.modelDirDraft = page.effectiveModelDir;
        }
    }

    Component.onCompleted: page.modelDirDraft = page.effectiveModelDir

    MPageHeader {
        title: "识别"
        subtitle: "录音 → 转写自测：流式 partial vs 最终 final、耗时与字级正确率"
        icon: "text"
    }

    MCard {
        title: "参考文本"
        subtitle: "请用正常语速朗读下面这句话"

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: refText.implicitHeight + 24
            radius: 8
            color: Theme.insetBg
            Text {
                id: refText
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.margins: 12
                text: page.referenceText
                color: Theme.text
                font.family: Theme.fontSans
                font.pixelSize: 16
                wrapMode: Text.WordWrap
                lineHeight: 1.3
            }
        }

        Text {
            Layout.fillWidth: true
            text: "参考文本共 " + page.normalize(page.referenceText).length
                + " 个字（不含标点）。字级正确率 = 1 − 编辑距离 / 参考字数。"
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WordWrap
        }
    }

    MCard {
        title: "录音 → 转写"
        subtitle: "test.asr.start：过程中推流式 partial，结束后返回两个模型的最终结果"

        Rectangle {
            visible: !page.asrSupported
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
                    text: "当前 daemon 不支持此功能（test.asr.start 未响应）。"
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
                text: Ipc.asrRunning ? "停止录音" : "开始录音转写"
                icon: Ipc.asrRunning ? "stop" : "record"
                primary: !Ipc.asrRunning
                enabled: Ipc.connected && page.asrSupported
                onClicked: Ipc.asrRunning ? page.stopRecognitionTest() : page.startRecognitionTest()
            }
            MPill {
                text: Ipc.asrRunning ? "录音中…" : (page.result.text !== undefined ? "已完成" : "未开始")
                tone: Ipc.asrRunning ? Theme.red : (page.result.text !== undefined ? Theme.green : Theme.textDim)
            }
            MPill {
                visible: page.result.reason !== undefined && page.result.reason !== "end"
                text: "结束原因：" + String(page.result.reason)
                tone: Theme.orange
            }
            Item { Layout.fillWidth: true }
            Text {
                text: Ipc.asrPartials.length + " 个 partial"
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }

        // live streaming partials
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 112
            radius: 8
            color: Theme.insetBg
            clip: true

            Column {
                anchors.fill: parent
                anchors.margins: 10
                spacing: 3

                Text {
                    text: "流式 partial（实时）"
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsTiny
                }
                ListView {
                    id: partialList
                    width: parent.width
                    height: 78
                    model: Ipc.asrPartials
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds
                    onCountChanged: positionViewAtEnd()

                    delegate: Row {
                        required property var modelData
                        width: partialList.width
                        spacing: 8
                        Text {
                            text: Ipc.fmtClock(modelData.t)
                            color: Theme.textFaint
                            font.family: Theme.fontSans
                            font.pixelSize: Theme.fsTiny
                            width: 54
                        }
                        Text {
                            text: modelData.text
                            color: Theme.text
                            font.family: Theme.fontSans
                            font.pixelSize: Theme.fsSmall
                            elide: Text.ElideRight
                            width: partialList.width - 62
                        }
                    }
                }
                Text {
                    visible: Ipc.asrPartials.length === 0
                    text: Ipc.asrRunning ? "等待第一个 partial…" : "还没有 partial。开始测试后这里会逐字出现。"
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                }
            }
        }

        // final results: streaming model vs final model
        RowLayout {
            Layout.fillWidth: true
            spacing: 10

            Rectangle {
                Layout.fillWidth: true
                implicitHeight: 96
                radius: 8
                color: Theme.insetBg
                Column {
                    anchors.fill: parent
                    anchors.margins: 10
                    spacing: 4
                    Text {
                        text: "流式模型最终文本"
                        color: Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsTiny
                    }
                    Text {
                        width: parent.width
                        text: page.result.streamingText !== undefined && page.result.streamingText.length > 0
                            ? page.result.streamingText : "—"
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fs
                        wrapMode: Text.WordWrap
                    }
                    Text {
                        text: "字级正确率 " + page.accuracyText(page.result.streamingText)
                        color: page.accuracyTone(page.result.streamingText)
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsSmall
                        font.weight: Font.DemiBold
                    }
                }
            }
            Rectangle {
                Layout.fillWidth: true
                implicitHeight: 96
                radius: 8
                color: Theme.insetBg
                Column {
                    anchors.fill: parent
                    anchors.margins: 10
                    spacing: 4
                    Text {
                        text: "最终转写（离线模型）"
                        color: Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsTiny
                    }
                    Text {
                        width: parent.width
                        text: page.result.text !== undefined && page.result.text.length > 0 ? page.result.text : "—"
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fs
                        wrapMode: Text.WordWrap
                    }
                    Text {
                        text: "字级正确率 " + page.accuracyText(page.result.text)
                        color: page.accuracyTone(page.result.text)
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsSmall
                        font.weight: Font.DemiBold
                    }
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 12
            MStat {
                label: "音频时长"
                value: page.result.audioMs !== undefined ? String(page.result.audioMs) : "—"
                unit: "ms"
                tone: Theme.text
            }
            MStat {
                label: "识别耗时"
                value: page.result.ms !== undefined ? String(page.result.ms) : "—"
                unit: "ms"
                tone: page.result.ms !== undefined && page.result.ms < 1000 ? Theme.green : Theme.orange
                hint: "最终转写耗时"
            }
            MStat {
                label: "实时率"
                value: page.result.ms !== undefined && page.result.audioMs
                    ? (page.result.ms / page.result.audioMs).toFixed(2) : "—"
                unit: "×"
                tone: Theme.text
                hint: "耗时 / 音频时长"
            }
            MStat {
                label: "首 partial 延迟"
                value: Ipc.asrPartials.length > 0 && Ipc.asrStartedAt > 0
                    ? String(Math.max(0, Ipc.asrPartials[0].t - Ipc.asrStartedAt)) : "—"
                unit: "ms"
                tone: Ipc.asrPartials.length > 0 ? Theme.green : Theme.textDim
                hint: Ipc.asrPartials.length > 0 ? "开始 → 首个流式结果" : "未收到流式结果"
            }
        }

        Text {
            Layout.fillWidth: true
            text: "参考：本机 paraformer-zh 离线模型实测 CER ≈ 6.5%、单句中位延迟 ≈ 93 ms；"
                + "流式模型（SenseVoice-small）延迟更低但准确率略差。"
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WordWrap
        }
    }

    // ---------------------------------------------------------- 模型路径
    MCard {
        title: "语音识别模型"
        subtitle: "asr.modelDir · 默认使用仓库自带的中英双语 KWS 模型；也可指定自定义模型目录（需重启 daemon 生效）"

        MRow {
            label: "当前模型"
            subtitle: "默认：仓库自带（中英双语 zh-en）"
            showSeparator: true
            MPill {
                text: page.modelDirCustom ? "自定义目录" : "仓库自带（中英双语）"
                tone: page.modelDirCustom ? Theme.accent : Theme.green
            }
        }
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6

            Text {
                Layout.fillWidth: true
                text: "模型目录"
                color: Theme.text
                font.family: Theme.fontSans
                font.pixelSize: Theme.fs
            }
            Text {
                Layout.fillWidth: true
                text: "填绝对路径；目录中需包含 encoder.onnx / decoder.onnx / joiner.onnx / tokens.txt（留空 = 恢复默认）"
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
                wrapMode: Text.WordWrap
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                MTextField {
                    id: modelDirField
                    Layout.fillWidth: true
                    text: page.modelDirDraft
                    placeholder: "留空 = 仓库自带模型"
                    onTextChanged: page.modelDirDraft = text
                    onAccepted: page.applyModelDir()
                }
                MButton {
                    text: page.modelCheckRunning ? "校验中…" : "应用"
                    primary: true
                    enabled: !page.modelCheckRunning
                    onClicked: page.applyModelDir()
                }
                MButton {
                    text: "恢复默认"
                    icon: "refresh"
                    enabled: page.modelDirCustom || page.modelDirDraft.length > 0
                    onClicked: page.resetModelDir()
                }
                MApplyStatus { paths: ["asr.modelDir"] }
            }
        }
        Text {
            visible: page.modelCheckText.length > 0
            Layout.fillWidth: true
            text: page.modelCheckText
            color: page.modelCheckText.indexOf("通过") >= 0 || page.modelCheckText.indexOf("恢复") >= 0
                ? Theme.green : Theme.orange
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: Text.WordWrap
        }
        Text {
            Layout.fillWidth: true
            text: "说明：语音识别完全在本地运行，不需要 API Key；自定义目录需要包含完整的 sherpa-onnx KWS 模型文件，"
                + "写入后重启 daemon 才会加载。"
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WordWrap
        }
    }

}
