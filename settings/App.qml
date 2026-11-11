import QtQuick
import QtQuick.Layouts
import "."
import "components"
import "pages"

// Window content: macOS-style title bar + sidebar + page stack.
Rectangle {
    id: app

    color: Theme.contentBg

    property var targetWindow: null
    property int pageIndex: 0
    property string pageKey: "overview"

    readonly property var navModel: [
        { key: "overview", label: "概览", icon: "overview", advanced: false },
        { key: "wizard", label: "引导测试", icon: "wand", advanced: false },
        { key: "appearance", label: "外观", icon: "sliders", advanced: false },
        { key: "api", label: "连接", icon: "key", advanced: false },
        { key: "wake", label: "唤醒", icon: "wake", advanced: true },
        { key: "interaction", label: "交互", icon: "chat", advanced: true },
        { key: "mic", label: "麦克风", icon: "mic", advanced: true },
        { key: "voice", label: "语音", icon: "speaker", advanced: true },
        { key: "asr", label: "识别", icon: "text", advanced: true },
        { key: "diagnostics", label: "诊断", icon: "diagnostics", advanced: true },
    ]

    function showPage(key) {
        for (let i = 0; i < app.navModel.length; i++) {
            if (app.navModel[i].key === key) {
                app.pageIndex = i;
                app.pageKey = key;
                return true;
            }
        }
        return false;
    }

    function saveShot(path) {
        app.grabToImage(function(result) {
            const ok = result.saveToFile(path);
            console.log("[figaro-settings] screenshot " + (ok ? "saved" : "FAILED") + ": " + path);
        });
        return path;
    }

    // Modal for CLI commands the settings window cannot run itself (voiceprint
    // enrollment drives the microphone through `figaro enroll-voice`).
    function showEnrollCommand() {
        commandDialog.title = "重新录制声纹";
        commandDialog.command = "figaro enroll-voice";
        commandDialog.note = "在安静环境里按提示录 3 句（约 10 秒），录完会自动启用声纹门控。"
            + "录制需要麦克风，所以由 daemon 的 CLI 完成，设置窗口不能直接驱动录音。"
            + "录完后回这里点「刷新」即可看到新的声纹状态。";
        commandDialog.show();
        return "enroll-dialog-open";
    }

    function runAction(name) {
        // scroll:<px> lets the self-test harness park the page at an offset.
        if (name.indexOf("scroll:") === 0) return app.scrollCurrent(name.slice(7));
        switch (name) {
        case "wizard-start": app.showPage("wizard"); return wizardPage.startWizard();
        case "wizard-run": return wizardPage.runCurrentStep();
        case "wizard-next": return wizardPage.nextStep();
        case "wizard-skip": return wizardPage.skipStep();
        case "wizard-reset": return wizardPage.resetWizard();
        case "wizard-finish": return wizardPage.finishWizardSummary();
        case "appearance-demo": return appearancePage.demoWrite();
        case "appearance-reset": return appearancePage.resetDefaults();
        case "api-demo": return apiKeysPage.demoWrite();
        case "api-home-demo": return apiKeysPage.homeDemoWrite();
        case "api-home-save": return apiKeysPage.saveHome();
        case "api-home-test": return apiKeysPage.runHomeTest();
        case "api-home-test-bad": return apiKeysPage.homeDemoFailTest();
        case "wake-enroll-dialog": return wakePage.openEnrollDialog();
        case "enroll-copy": commandDialog.copyCommand(); return "enroll-copied";
        case "dialog-close": commandDialog.close(); return "dialog-closed";
        case "wake-speaker-demo": return wakePage.speakerDemoWrite();
        case "wake-start": return wakePage.startWakeTest();
        case "wake-stop": return wakePage.stopWakeTest();
        case "ambient-start": return wakePage.startAmbientTest();
        case "ambient-stop": return wakePage.stopAmbientTest();
        case "ambient-csv": return wakePage.exportAmbientCsv();
        case "wake-noise-on": return wakePage.setNoisePlayback(true);
        case "wake-noise-off": return wakePage.setNoisePlayback(false);
        case "interaction-demo": return interactionPage.demoWrite();
        case "wake-demo": return wakePage.demoWrite();
        case "voice-demo": return voicePage.demoWrite();
        case "sfx-demo": return voicePage.demoSfxWrite();
        case "mic-monitor": return micPage.startMonitor();
        case "mic-stop": return micPage.stopMonitor();
        case "mic-noise": return micPage.measureNoiseFloor();
        case "mic-calibrate": return micPage.autoCalibrate();
        case "voice-preview": return voicePage.previewVoice();
        case "asr-start": return asrPage.startRecognitionTest();
        case "asr-stop": return asrPage.stopRecognitionTest();
        case "diag-export": return diagnosticsPage.exportReport();
        case "diag-copy-log": return diagnosticsPage.copyLogs();
        case "diag-restart": return diagnosticsPage.requestRestart();
        case "diag-restart-confirm": return diagnosticsPage.confirmRestartNow();
        case "refresh": Ipc.refreshConfig(true); Ipc.refreshDiagnostics(); return "refresh-requested";
        case "scroll-top": return app.scrollCurrent("top");
        case "scroll-bottom": return app.scrollCurrent("bottom");
        default: return "unknown-action:" + name;
        }
    }

    function currentPage() {
        const pages = [overviewPage, wizardPage, appearancePage, apiKeysPage,
                       wakePage, interactionPage, micPage, voicePage, asrPage, diagnosticsPage];
        return pages[app.pageIndex] || null;
    }

    function scrollCurrent(where) {
        const p = app.currentPage();
        if (!p) return "no-page";
        if (where === "top") p.scrollTop();
        else if (where === "bottom") p.scrollBottom();
        else p.scrollTo(Number(where) || 0);
        return "scrolled:" + where;
    }

    // Test harness helper: "asr.bargeIn.minRms" + "0.06" -> immediate write.
    // base64=true decodes the payload first so arrays/quoted strings survive
    // `qs ipc call` argument splitting.
    function writeFieldForTest(path, valueJson, base64) {
        let value;
        try {
            value = JSON.parse(base64 ? Qt.atob(valueJson) : valueJson);
        } catch (e) {
            return "bad-json";
        }
        return Ipc.writeField(path, value) + "";
    }

    function statusSnapshot() {
        const snap = {
            page: app.pageKey,
            windowWidth: Math.round(app.width),
            windowHeight: Math.round(app.height),
            socket: Ipc.socketPath,
            testSocket: Ipc.usingTestSocket,
            connected: Ipc.connected,
            daemonState: Ipc.daemonState,
            capabilities: Ipc.capabilities,
            configLoaded: Ipc.configLoaded,
            diagnosticsLoaded: Ipc.diagnosticsLoaded,
            wizard: wizardPage.snapshot(),
            appearance: appearancePage.snapshot(),
            api: apiKeysPage.snapshot(),
            ui: Ipc.uiSnapshot,
            windowButtonSize: Math.round(Number(Ipc.uiValue("windowButtonSize", 16))),
            wake: wakePage.snapshot(),
            interaction: interactionPage.snapshot(),
            fieldStatus: Ipc.fieldStatus,
            daemonDiagnostics: Ipc.diagnostics,
            mic: micPage.snapshot(),
            voice: voicePage.snapshot(),
            asr: asrPage.snapshot(),
            diagnostics: diagnosticsPage.snapshot(),
            recentErrors: Ipc.recentErrors.slice(0, 5),
        };
        return snap;
    }

    MTitleBar {
        id: titleBar
        width: parent.width
        height: Theme.titleBarH
        targetWindow: app.targetWindow
        title: "费加罗"
        subtitle: ""
        buttonSize: Math.round(Number(Ipc.uiValue("windowButtonSize", 16)))
        modeText: Ipc.usingTestSocket ? "测试 daemon" : ""
        statusText: Ipc.connected ? "已连接" : "未连接"
        statusTone: Ipc.connected ? Theme.green : Theme.red
    }

    Rectangle {
        x: 0
        y: titleBar.height
        width: parent.width
        height: 1
        color: Qt.rgba(0, 0, 0, 0.45)
        z: 5
    }

    MSidebar {
        id: sidebar
        y: titleBar.height
        width: Theme.sidebarW
        height: parent.height - titleBar.height
        appName: "费加罗"
        appSubtitle: "语音助手 · 系统设置"
        model: app.navModel
        currentIndex: app.pageIndex
        currentKey: app.pageKey
        footerText: "Figaro " + (Ipc.diagnostics.version ? String(Ipc.diagnostics.version).split(" ")[0] : "0.1.0")
            + (Ipc.usingTestSocket ? " · 测试模式" : "")
        onSelected: (index, key) => app.showPage(key)
    }

    Rectangle {
        x: sidebar.width
        y: titleBar.height
        width: 1
        height: parent.height - titleBar.height
        color: Qt.rgba(0, 0, 0, 0.28)
    }

    Item {
        id: contentArea
        x: sidebar.width + 1
        y: titleBar.height
        width: parent.width - sidebar.width - 1
        height: parent.height - titleBar.height

        Rectangle {
            anchors.fill: parent
            color: Theme.contentBg
        }

        OverviewPage {
            id: overviewPage
            anchors.fill: parent
            visible: app.pageIndex === 0
            onStartWizard: app.showPage("wizard")
        }
        WizardPage {
            id: wizardPage
            anchors.fill: parent
            visible: app.pageIndex === 1
            onGoOverview: app.showPage("overview")
        }
        AppearancePage {
            id: appearancePage
            anchors.fill: parent
            visible: app.pageIndex === 2
        }
        ApiKeysPage {
            id: apiKeysPage
            anchors.fill: parent
            visible: app.pageIndex === 3
        }
        WakePage {
            id: wakePage
            anchors.fill: parent
            visible: app.pageIndex === 4
            onEnrollCommandRequested: app.showEnrollCommand()
        }
        InteractionPage {
            id: interactionPage
            anchors.fill: parent
            visible: app.pageIndex === 5
        }
        MicPage {
            id: micPage
            anchors.fill: parent
            visible: app.pageIndex === 6
        }
        VoicePage {
            id: voicePage
            anchors.fill: parent
            visible: app.pageIndex === 7
        }
        AsrPage {
            id: asrPage
            anchors.fill: parent
            visible: app.pageIndex === 8
        }
        DiagnosticsPage {
            id: diagnosticsPage
            anchors.fill: parent
            visible: app.pageIndex === 9
        }
    }

    MCommandDialog {
        id: commandDialog
        anchors.fill: parent
        z: 60
    }
}
