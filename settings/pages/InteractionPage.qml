import QtQuick
import QtQuick.Layouts
import ".."
import "../components"

// 交互：打断（barge-in）、回答后等待窗口、退下/取消短语。
// 每个控件改动立即通过 config.set 写回 daemon，并用 MApplyStatus 标注
// 已生效 / 需重启 / daemon 未开放（白名单缺失）。
MPageScroll {
    id: page

    readonly property var dismissDefaults: ["退下", "退下吧", "先退下", "你可以退下了", "可以退下了", "休息吧", "没事了", "结束吧", "关了"]
    readonly property var cancelDefaults: ["取消", "算了", "别说了", "停下", "停止", "不用了", "退出"]

    // ---- drafts, synced from daemon config --------------------------------
    property bool bargeEnabled: true
    property real bargeMinRms: 0.09
    property real bargeEchoFactor: 2.5
    property int bargeMinMs: 500
    property int followUpWindow: 0
    property real followUpRms: 0.012
    property int followUpMinMs: 180
    property var dismissPhrases: []
    property var cancelPhrases: []

    readonly property var bargeDiagnostics: (Ipc.diagnostics.asr && Ipc.diagnostics.asr.bargeIn) ? Ipc.diagnostics.asr.bargeIn : null
    readonly property var followUpDiagnostics: Ipc.diagnostics.interaction ? Ipc.diagnostics.interaction : null

    function syncFromConfig() {
        page.bargeEnabled = Ipc.cfg("asr.bargeIn.enabled", true) !== false;
        page.bargeMinRms = Number(Ipc.cfg("asr.bargeIn.minRms", 0.09));
        page.bargeEchoFactor = Number(Ipc.cfg("asr.bargeIn.echoFactor", 2.5));
        page.bargeMinMs = Number(Ipc.cfg("asr.bargeIn.minMs", 500));
        page.followUpWindow = Number(Ipc.cfg("interaction.followUpWindowMs", 0));
        page.followUpRms = Number(Ipc.cfg("interaction.followUpMinRms", 0.012));
        page.followUpMinMs = Number(Ipc.cfg("interaction.followUpMinMs", 180));
        const dismiss = Ipc.cfg("interaction.dismissPhrases", page.dismissDefaults);
        page.dismissPhrases = Array.isArray(dismiss) ? dismiss : page.dismissDefaults;
        const cancel = Ipc.cfg("interaction.cancelPhrases", page.cancelDefaults);
        page.cancelPhrases = Array.isArray(cancel) ? cancel : page.cancelDefaults;
    }

    // ---- immediate write-back --------------------------------------------
    function setBargeEnabled(value) {
        page.bargeEnabled = value;
        Ipc.writeField("asr.bargeIn.enabled", value);
    }
    function setBargeMinRms(value) {
        const v = Math.round(value * 200) / 200;   // 0.005 steps
        page.bargeMinRms = v;
        Ipc.writeField("asr.bargeIn.minRms", v);
    }
    function setBargeEchoFactor(value) {
        const v = Math.round(value * 10) / 10;
        page.bargeEchoFactor = v;
        Ipc.writeField("asr.bargeIn.echoFactor", v);
    }
    function setBargeMinMs(value) {
        const v = Math.round(value / 25) * 25;
        page.bargeMinMs = v;
        Ipc.writeField("asr.bargeIn.minMs", v);
    }
    function setFollowUpWindow(ms) {
        page.followUpWindow = ms;
        Ipc.writeField("interaction.followUpWindowMs", ms);
    }
    function setFollowUpRms(value) {
        const v = Math.round(value * 1000) / 1000;
        page.followUpRms = v;
        Ipc.writeField("interaction.followUpMinRms", v);
    }
    function setFollowUpMinMs(value) {
        const v = Math.round(value / 10) * 10;
        page.followUpMinMs = v;
        Ipc.writeField("interaction.followUpMinMs", v);
    }
    function setDismissPhrases(values) {
        page.dismissPhrases = values;
        Ipc.writeField("interaction.dismissPhrases", values);
    }
    function setCancelPhrases(values) {
        page.cancelPhrases = values;
        Ipc.writeField("interaction.cancelPhrases", values);
    }

    function followUpIndex() {
        const opts = [0, 3000, 5000, 7000, 10000];
        for (let i = 0; i < opts.length; i++)
            if (opts[i] === page.followUpWindow) return i;
        // A custom value from config.json: show the closest slot but keep the
        // real value in the label below.
        let best = 0;
        for (let i = 1; i < opts.length; i++)
            if (Math.abs(opts[i] - page.followUpWindow) < Math.abs(opts[best] - page.followUpWindow)) best = i;
        return best;
    }

    readonly property string followUpWindowLabel: page.followUpWindow <= 0
        ? "关闭（回答完就退回 idle）"
        : page.followUpWindow + " ms（" + (page.followUpWindow / 1000).toFixed(1) + " 秒）"

    // Harness hook: write a distinctive set of values so shoot.sh can verify
    // both the GUI status chips and the daemon's config file.
    function demoWrite() {
        Ipc.writeFields([
            { path: "asr.bargeIn.enabled", value: true },
            { path: "asr.bargeIn.minRms", value: 0.06 },
            { path: "asr.bargeIn.echoFactor", value: 3.0 },
            { path: "asr.bargeIn.minMs", value: 600 },
            { path: "interaction.followUpWindowMs", value: 7000 },
            { path: "interaction.followUpMinRms", value: 0.012 },
            { path: "interaction.followUpMinMs", value: 180 },
            { path: "interaction.dismissPhrases", value: ["退下", "先退下", "休息吧", "没事了", "关了", "告退"] },
        ]);
        return "interaction-demo-written";
    }

    function snapshot() {
        return {
            title: "交互",
            bargeEnabled: page.bargeEnabled,
            bargeMinRms: page.bargeMinRms,
            bargeEchoFactor: page.bargeEchoFactor,
            bargeMinMs: page.bargeMinMs,
            followUpWindow: page.followUpWindow,
            followUpRms: page.followUpRms,
            followUpMinMs: page.followUpMinMs,
            dismissPhrases: page.dismissPhrases,
            cancelPhrases: page.cancelPhrases,
        };
    }

    Connections {
        target: Ipc
        function onConfigChanged() { page.syncFromConfig(); }
    }

    Component.onCompleted: page.syncFromConfig()

    MPageHeader {
        title: "交互"
        subtitle: "打断播报、回答后等待窗口、退下/取消短语 —— 改动即时写回 daemon"
        icon: "chat"
    }

    // ------------------------------------------------------------ 打断播报
    MCard {
        title: "打断播报（barge-in）"
        subtitle: "说话即可打断 Figaro 的播报。声音要同时超过绝对响度门槛和 TTS 回声基线的倍数，并持续足够久。"

        MRow {
            label: "允许打断"
            subtitle: "asr.bargeIn.enabled · TTS 播放期间检测用户开口"
            RowLayout {
                spacing: 8
                MApplyStatus { paths: ["asr.bargeIn.enabled"] }
                MToggle {
                    checked: page.bargeEnabled
                    onToggled: (value) => page.setBargeEnabled(value)
                }
            }
        }
        MRow {
            label: "响度门槛"
            subtitleWrap: true
            subtitle: "asr.bargeIn.minRms（0.02–0.20）· 实测：房间底噪 ≈ 0.0023、最轻音节 ≈ 0.012、正常说话中位 RMS ≈ 0.036；门槛越低越容易打断，也越容易被环境噪声误触发"
            RowLayout {
                spacing: 8
                Text {
                    text: page.bargeMinRms.toFixed(3)
                    color: Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    Layout.preferredWidth: 42
                    horizontalAlignment: Text.AlignRight
                }
                MSlider {
                    Layout.preferredWidth: 170
                    from: 0.02
                    to: 0.20
                    value: page.bargeMinRms
                    markers: [0.036, 0.06, 0.09]
                    onMoved: (v) => page.setBargeMinRms(v)
                }
                MApplyStatus { paths: ["asr.bargeIn.minRms"] }
            }
        }
        MRow {
            label: "回声倍数"
            subtitleWrap: true
            subtitle: "asr.bargeIn.echoFactor（1.0–5.0）· 要求响度 ≥ 播放时的回声水平 × 该倍数，防止把自己的声音当打断"
            RowLayout {
                spacing: 8
                Text {
                    text: page.bargeEchoFactor.toFixed(1) + "×"
                    color: Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    Layout.preferredWidth: 42
                    horizontalAlignment: Text.AlignRight
                }
                MSlider {
                    Layout.preferredWidth: 170
                    from: 1.0
                    to: 5.0
                    value: page.bargeEchoFactor
                    markers: [2.5]
                    onMoved: (v) => page.setBargeEchoFactor(v)
                }
                MApplyStatus { paths: ["asr.bargeIn.echoFactor"] }
            }
        }
        MRow {
            label: "持续时间"
            subtitle: "asr.bargeIn.minMs（100–1000ms）· 声音连续超过门槛多久才算打断"
            showSeparator: false
            RowLayout {
                spacing: 8
                Text {
                    text: page.bargeMinMs + " ms"
                    color: Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    Layout.preferredWidth: 52
                    horizontalAlignment: Text.AlignRight
                }
                MSlider {
                    Layout.preferredWidth: 170
                    from: 100
                    to: 1000
                    value: page.bargeMinMs
                    markers: [500]
                    onMoved: (v) => page.setBargeMinMs(v)
                }
                MApplyStatus { paths: ["asr.bargeIn.minMs"] }
            }
        }
        MApplyStatus {
            Layout.fillWidth: true
            paths: ["asr.bargeIn.enabled", "asr.bargeIn.minRms", "asr.bargeIn.echoFactor", "asr.bargeIn.minMs"]
        }
        Text {
            Layout.fillWidth: true
            text: page.bargeDiagnostics
                ? "daemon 回读：enabled=" + (page.bargeDiagnostics.enabled ? "true" : "false")
                    + " · minRms=" + Number(page.bargeDiagnostics.minRms).toFixed(3)
                    + " · echoFactor=" + Number(page.bargeDiagnostics.echoFactor).toFixed(1)
                    + " · minMs=" + page.bargeDiagnostics.minMs
                : "调参建议：打断不灵 → 降低门槛/持续时间；被环境声误打断 → 提高门槛或回声倍数。"
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WordWrap
        }
    }

    // -------------------------------------------------------- 回答后等待
    MCard {
        title: "回答后等待"
        subtitle: "说完回答后先别急着退出：这段时间内再开口可以直接续问；0 = 说完就退回 idle。"

        MRow {
            label: "等待窗口"
            subtitle: "interaction.followUpWindowMs · 当前 " + page.followUpWindowLabel
            RowLayout {
                spacing: 8
                MSegmented {
                    Layout.preferredWidth: 300
                    options: ["关闭", "3 秒", "5 秒", "7 秒", "10 秒"]
                    currentIndex: page.followUpIndex()
                    onActivated: (index, value) => {
                        const opts = [0, 3000, 5000, 7000, 10000];
                        page.setFollowUpWindow(opts[index]);
                    }
                }
                MApplyStatus { paths: ["interaction.followUpWindowMs"] }
            }
        }
        MRow {
            label: "响度门槛"
            subtitleWrap: true
            subtitle: "interaction.followUpMinRms · 实测底噪 ≈ 0.0023 / 最轻音节 ≈ 0.012（默认 0.012）· 低于门槛的声音当环境噪声"
            RowLayout {
                spacing: 8
                Text {
                    text: page.followUpRms.toFixed(3)
                    color: Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    Layout.preferredWidth: 42
                    horizontalAlignment: Text.AlignRight
                }
                MSlider {
                    Layout.preferredWidth: 170
                    from: 0.004
                    to: 0.060
                    value: page.followUpRms
                    markers: [0.012, 0.036]
                    onMoved: (v) => page.setFollowUpRms(v)
                }
                MApplyStatus { paths: ["interaction.followUpMinRms"] }
            }
        }
        MRow {
            label: "最短持续"
            subtitle: "interaction.followUpMinMs（80–500ms，默认 180）· 声音要持续这么久才重新打开对话"
            showSeparator: false
            RowLayout {
                spacing: 8
                Text {
                    text: page.followUpMinMs + " ms"
                    color: Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    Layout.preferredWidth: 52
                    horizontalAlignment: Text.AlignRight
                }
                MSlider {
                    Layout.preferredWidth: 170
                    from: 80
                    to: 500
                    value: page.followUpMinMs
                    markers: [180]
                    onMoved: (v) => page.setFollowUpMinMs(v)
                }
                MApplyStatus { paths: ["interaction.followUpMinMs"] }
            }
        }
        MApplyStatus {
            Layout.fillWidth: true
            paths: ["interaction.followUpWindowMs", "interaction.followUpMinRms", "interaction.followUpMinMs"]
        }
        Text {
            Layout.fillWidth: true
            text: page.followUpDiagnostics
                ? "daemon 回读：followUpWindowMs=" + page.followUpDiagnostics.followUpWindowMs
                    + " · minRms=" + Number(page.followUpDiagnostics.followUpMinRms).toFixed(3)
                    + " · minMs=" + page.followUpDiagnostics.followUpMinMs
                : "当前生效：followUpMinRms = 0.012、followUpMinMs = 180。窗口越大越容易“接着聊”，也越容易把环境声当成回答。"
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WordWrap
        }
    }

    // ------------------------------------------------------------ 退下短语
    MCard {
        title: "退下短语"
        subtitle: "说完这些短语：先把当前这句回答说完，然后退出，不再等待后续 · interaction.dismissPhrases"

        MChipEditor {
            Layout.fillWidth: true
            values: page.dismissPhrases
            placeholder: "例如：退下"
            addLabel: "添加退下短语"
            emptyText: "（空：不会因为短语退出）"
            onEdited: (values) => page.setDismissPhrases(values)
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            MButton {
                text: "恢复默认"
                icon: "refresh"
                onClicked: page.setDismissPhrases(page.dismissDefaults.slice(0))
            }
            MApplyStatus { paths: ["interaction.dismissPhrases"] }
            Item { Layout.fillWidth: true }
            Text {
                text: "共 " + page.dismissPhrases.length + " 条"
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
    }

    // ------------------------------------------------------------ 取消短语
    MCard {
        title: "取消短语"
        subtitle: "说完这些短语：立刻停下思考/播报并回到 idle · interaction.cancelPhrases"

        MChipEditor {
            Layout.fillWidth: true
            values: page.cancelPhrases
            placeholder: "例如：取消"
            addLabel: "添加取消短语"
            emptyText: "（空：不会因为短语取消）"
            onEdited: (values) => page.setCancelPhrases(values)
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            MButton {
                text: "恢复默认"
                icon: "refresh"
                onClicked: page.setCancelPhrases(page.cancelDefaults.slice(0))
            }
            MApplyStatus { paths: ["interaction.cancelPhrases"] }
            Item { Layout.fillWidth: true }
            Text {
                text: "共 " + page.cancelPhrases.length + " 条"
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
        Text {
            Layout.fillWidth: true
            text: "短语匹配做的是规范化后的包含判断（去标点/空格）；太短的词（如「停」）容易误触发，建议保持 2 个字以上。"
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WordWrap
        }
    }
}
