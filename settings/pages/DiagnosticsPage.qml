import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import ".."
import "../components"

MPageScroll {
    id: page

    property bool confirmRestart: false
    property string lastExportPath: ""
    property string logCopyState: ""
    property int logCopyLines: 0

    readonly property var diag: Ipc.diagnostics || ({})

    function timestamp() {
        const d = new Date();
        const p = n => (n < 10 ? "0" + n : "" + n);
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-"
            + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }

    function requestRestart() {
        if (!Ipc.connected) return "not-connected";
        page.confirmRestart = true;
        confirmTimer.restart();
        return "confirm-required";
    }

    function confirmRestartNow() {
        page.confirmRestart = false;
        Ipc.restartService();
        return "restart-requested";
    }

    function exportReport() {
        const payload = {
            generatedAt: new Date().toISOString(),
            generator: "figaro-settings GUI",
            socket: Ipc.socketPath,
            usingTestSocket: Ipc.usingTestSocket,
            connected: Ipc.connected,
            daemonState: Ipc.daemonState,
            capabilities: Ipc.capabilities,
            config: Ipc.config,
            diagnostics: Ipc.diagnostics,
            recentErrors: Ipc.recentErrors,
            selftests: {
                wake: null,
                mic: null,
                asr: null,
                tts: null,
            },
            windowSize: [Math.round(page.width), Math.round(page.height)],
        };
        const path = Ipc.homeDir + "/figaro-diagnostics-" + page.timestamp() + ".json";
        reportFile.path = path;
        reportFile.setText(JSON.stringify(payload, null, 2) + "\n");
        page.lastExportPath = path;
        return path;
    }

    function copyLogs() {
        page.logCopyState = "copying";
        logProcess.running = false;
        logProcess.running = true;
        return "copy-logs-requested";
    }

    function snapshot() {
        return {
            title: I18n.t("诊断"),
            confirmRestart: page.confirmRestart,
            restartState: Ipc.restartState,
            lastExportPath: page.lastExportPath,
            logCopyState: page.logCopyState,
            logCopyLines: page.logCopyLines,
            configPath: page.diag.configPath !== undefined ? page.diag.configPath : Ipc.configPath,
            version: page.diag.version !== undefined ? page.diag.version : "",
            uptimeMs: page.diag.uptimeMs !== undefined ? page.diag.uptimeMs : 0,
        };
    }

    Timer {
        id: confirmTimer
        interval: 5000
        repeat: false
        onTriggered: page.confirmRestart = false
    }

    FileView {
        id: reportFile
        path: ""
        blockWrites: true
        printErrors: false
    }

    Process {
        id: logProcess
        running: false
        command: ["journalctl", "--user", "-u", "figaro", "-n", "300", "--no-pager"]
        stdout: StdioCollector {
            onStreamFinished: {
                const text = this.text || "";
                const lines = text.length > 0 ? text.trim().split("\n").length : 0;
                page.logCopyLines = lines;
                if (lines > 0) {
                    Quickshell.clipboardText = text;
                    page.logCopyState = "copied:" + lines;
                } else {
                    page.logCopyState = "empty";
                }
            }
        }
        onExited: (code, status) => {
            if (code !== 0 && page.logCopyState === "copying") page.logCopyState = "failed";
        }
    }

    MPageHeader {
        title: I18n.t("诊断")
        subtitle: I18n.t("配置、日志、服务维护与诊断报告")
        icon: "diagnostics"
    }

    MCard {
        title: I18n.t("运行环境")

        MRow {
            label: I18n.t("配置文件")
            subtitle: page.diag.configPath !== undefined ? String(page.diag.configPath) : Ipc.configPath
            controlMinWidth: 60
            MButton {
                text: I18n.t("复制路径")
                onClicked: Quickshell.clipboardText = page.diag.configPath !== undefined ? String(page.diag.configPath) : Ipc.configPath;
            }
        }
        MRow {
            label: "Socket"
            subtitle: Ipc.socketPath
            MPill {
                text: Ipc.usingTestSocket ? I18n.t("测试 socket") : I18n.t("生产 socket")
                tone: Ipc.usingTestSocket ? Theme.orange : Theme.green
            }
        }
        MRow {
            label: I18n.t("日志")
            subtitle: page.diag.logPath !== undefined ? String(page.diag.logPath) : "journalctl --user -u figaro"
            Text {
                text: "journalctl --user -u figaro -f"
                color: Theme.textFaint
                font.family: "JetBrains Mono, Inter, " + Theme.fontCJK
                font.pixelSize: Theme.fsTiny
            }
        }
        MRow {
            label: I18n.t("版本 / 运行时长")
            Text {
                text: (page.diag.version !== undefined ? String(page.diag.version) : "—")
                    + "  ·  " + (page.diag.uptimeMs !== undefined ? Ipc.fmtDuration(page.diag.uptimeMs) : "—")
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
        MRow {
            label: I18n.t("进程")
            showSeparator: false
            Text {
                text: page.diag.pid !== undefined ? "pid " + page.diag.pid : "—"
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }
    }

    MCard {
        title: I18n.t("服务维护")

        MRow {
            label: I18n.t("重启 daemon")
            subtitle: I18n.t("service.restart：会短暂中断语音功能")
            showSeparator: true
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
        MRow {
            label: I18n.t("复制日志")
            subtitle: I18n.t("最近 300 行 journalctl 日志 → 剪贴板")
            RowLayout {
                spacing: 8
                Text {
                    visible: page.logCopyState.length > 0
                    text: page.logCopyState === "copying" ? I18n.t("复制中…")
                        : page.logCopyState === "empty" ? I18n.t("日志为空")
                        : page.logCopyState === "failed" ? I18n.t("读取失败")
                        : I18n.t("已复制 ") + page.logCopyLines + I18n.t(" 行")
                    color: page.logCopyState.indexOf("copied") === 0 ? Theme.green : Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                }
                MButton {
                    text: I18n.t("复制日志")
                    icon: "text"
                    onClicked: page.copyLogs()
                }
            }
        }
        MRow {
            label: I18n.t("导出诊断报告")
            subtitle: I18n.t("config / diagnostics / 最近错误 / 自测状态 → ~/figaro-diagnostics-<时间戳>.json")
            showSeparator: false
            RowLayout {
                spacing: 8
                Text {
                    visible: page.lastExportPath.length > 0
                    text: I18n.t("已导出")
                    color: Theme.green
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                }
                MButton {
                    text: I18n.t("导出 JSON")
                    icon: "export"
                    primary: true
                    onClicked: page.exportReport()
                }
            }
        }
        Text {
            visible: page.lastExportPath.length > 0
            Layout.fillWidth: true
            text: page.lastExportPath
            color: Theme.textFaint
            font.family: "JetBrains Mono, Inter, " + Theme.fontCJK
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WrapAnywhere
        }
        Text {
            visible: Ipc.unsupported("service.restart")
            Layout.fillWidth: true
            text: I18n.t("当前 daemon 不支持此功能（service.restart 未响应）。")
            color: Theme.yellow
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
        }
    }

    MCard {
        title: I18n.t("最近错误")
        subtitle: I18n.t("daemon 的 recentErrors + 本次会话收到的 error 帧")

        Text {
            visible: Ipc.recentErrors.length === 0
            Layout.fillWidth: true
            text: I18n.t("暂无错误。")
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
        }

        Repeater {
            model: Math.min(Ipc.recentErrors.length, 12)

            RowLayout {
                Layout.fillWidth: true
                spacing: 10
                Text {
                    text: Ipc.fmtClock(Ipc.errorTime(Ipc.recentErrors[index]))
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

    MCard {
        title: I18n.t("能力探测")
        subtitle: I18n.t("§3.1 消息在本 daemon 上的支持状态（超时即视为未实现）")

        Repeater {
            model: ["config.get", "config.set", "diagnostics", "test.mic.start", "test.asr.start",
                    "test.wake.arm", "test.tts", "service.restart"]

            RowLayout {
                Layout.fillWidth: true
                spacing: 10
                MIcon {
                    kind: Ipc.supported(modelData) ? "check" : (Ipc.unsupported(modelData) ? "warning" : "dot")
                    size: 13
                    color: Ipc.supported(modelData) ? Theme.green : (Ipc.unsupported(modelData) ? Theme.orange : Theme.textFaint)
                }
                Text {
                    text: modelData
                    Layout.preferredWidth: 130
                    color: Theme.text
                    font.family: "JetBrains Mono, Inter, " + Theme.fontCJK
                    font.pixelSize: Theme.fsSmall
                }
                MPill {
                    text: Ipc.supported(modelData) ? I18n.t("支持")
                        : (Ipc.unsupported(modelData) ? I18n.t("当前 daemon 不支持此功能") : I18n.t("未探测"))
                    tone: Ipc.supported(modelData) ? Theme.green
                        : (Ipc.unsupported(modelData) ? Theme.orange : Theme.textDim)
                }
            }
        }
    }
}
