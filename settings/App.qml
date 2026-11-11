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
        { key: "overview", label: I18n.t("概览"), icon: "overview", advanced: false },
        { key: "wizard", label: I18n.t("新手引导"), icon: "wand", advanced: false },
        { key: "llm", label: I18n.t("模型服务"), icon: "chat", advanced: false },
        { key: "appearance", label: I18n.t("外观"), icon: "sliders", advanced: false },
        { key: "api", label: I18n.t("连接"), icon: "key", advanced: false },
        { key: "wake", label: I18n.t("唤醒"), icon: "wake", advanced: true },
        { key: "interaction", label: I18n.t("交互"), icon: "chat", advanced: true },
        { key: "mic", label: I18n.t("麦克风"), icon: "mic", advanced: true },
        { key: "voice", label: I18n.t("语音"), icon: "speaker", advanced: true },
        { key: "asr", label: I18n.t("识别"), icon: "text", advanced: true },
        { key: "diagnostics", label: I18n.t("诊断"), icon: "diagnostics", advanced: true },
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
        commandDialog.title = I18n.t("重新录制声纹");
        commandDialog.command = "figaro enroll-voice";
        commandDialog.note = I18n.t("在安静环境里按提示录 3 句（约 10 秒），录完会自动启用声纹门控。")
            + I18n.t("录制需要麦克风，所以由 daemon 的 CLI 完成，设置窗口不能直接驱动录音。")
            + I18n.t("录完后回这里点「刷新」即可看到新的声纹状态。");
        commandDialog.show();
        return "enroll-dialog-open";
    }

    function showInfoDialog(title, body, linkLabel, linkUrl) {
        infoDialog.title = title;
        infoDialog.body = body;
        infoDialog.linkLabel = linkLabel;
        infoDialog.linkUrl = linkUrl;
        infoDialog.show();
        return "info-open";
    }

    function runAction(name) {
        // scroll:<px> lets the self-test harness park the page at an offset.
        if (name.indexOf("scroll:") === 0) return app.scrollCurrent(name.slice(7));
        if (name.indexOf("llm-provider:") === 0) return llmPage.useProvider(name.slice(13));
        if (name.indexOf("wizard-goto:") === 0) return wizardPage.gotoStep(name.slice(12));
        if (name.indexOf("wizard-region:") === 0) {
            wizardPage.selectRegion(name.slice(14));
            wizardPage.gotoStep(3);
            return "wizard-region-" + name.slice(14);
        }
        if (name.indexOf("wizard-memory:") === 0) {
            wizardPage.setMemory(name.slice(14) === "on");
            wizardPage.gotoStep(4);
            return "wizard-memory-" + name.slice(14);
        }
        if (name.indexOf("llm-info:") === 0) return llmPage.openProviderInfo(name.slice(9));
        if (name.indexOf("lang:") === 0) {
            I18n.setLanguage(name.slice(5));
            return "language-" + name.slice(5);
        }
        switch (name) {
        case "wizard-start": app.showPage("wizard"); return wizardPage.startWizard();
        case "wizard-next": return wizardPage.nextStep();
        case "wizard-prev": return wizardPage.prevStep();
        case "wizard-skip": return wizardPage.skipStep();
        case "wizard-reset": return wizardPage.resetWizard();
        case "wizard-finish": return wizardPage.finishWizard();
        case "wizard-selftest": wizardPage.gotoStep(7); return wizardPage.runSelfTest();
        case "wizard-memory-info": wizardPage.gotoStep(4); return wizardPage.openMemoryInfo();
        case "llm-info": return llmPage.openLlmInfo();
        case "voice-minimax-info": return voicePage.openMinimaxInfo();
        case "wizard-selftest-pass": wizardPage.gotoStep(7); return wizardPage.markSelfTest();
        case "wizard-llm-demo": return wizardPage.fillLlmDemo();
        case "wizard-finish-summary": return wizardPage.finishWizard();
        case "llm-demo": return llmPage.demoWrite();
        case "llm-save": return llmPage.save();
        case "llm-test": return llmPage.testConnection();

        case "info-close": infoDialog.close(); return "info-closed";
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
        const pages = [overviewPage, wizardPage, llmPage, appearancePage, apiKeysPage,
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
            llm: llmPage.snapshot(),
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
        title: I18n.t("费加罗")
        subtitle: ""
        buttonSize: Math.round(Number(Ipc.uiValue("windowButtonSize", 16)))
        modeText: Ipc.usingTestSocket ? I18n.t("测试 daemon") : ""
        statusText: Ipc.connected ? I18n.t("已连接") : I18n.t("未连接")
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
        appName: I18n.t("费加罗")
        appSubtitle: I18n.t("语音助手 · 系统设置")
        model: app.navModel
        currentIndex: app.pageIndex
        currentKey: app.pageKey
        footerText: "Figaro " + (Ipc.diagnostics.version ? String(Ipc.diagnostics.version).split(" ")[0] : "0.1.0")
            + (Ipc.usingTestSocket ? I18n.t(" · 测试模式") : "")
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
        LlmPage {
            id: llmPage
            anchors.fill: parent
            visible: app.pageIndex === 2
            onInfoRequested: (title, body, linkLabel, linkUrl) => app.showInfoDialog(title, body, linkLabel, linkUrl)
        }
        AppearancePage {
            id: appearancePage
            anchors.fill: parent
            visible: app.pageIndex === 3
        }
        ApiKeysPage {
            id: apiKeysPage
            anchors.fill: parent
            visible: app.pageIndex === 4
            onInfoRequested: (title, body, linkLabel, linkUrl) => app.showInfoDialog(title, body, linkLabel, linkUrl)
        }
        WakePage {
            id: wakePage
            anchors.fill: parent
            visible: app.pageIndex === 5
            onEnrollCommandRequested: app.showEnrollCommand()
        }
        InteractionPage {
            id: interactionPage
            anchors.fill: parent
            visible: app.pageIndex === 6
        }
        MicPage {
            id: micPage
            anchors.fill: parent
            visible: app.pageIndex === 7
        }
        VoicePage {
            id: voicePage
            anchors.fill: parent
            visible: app.pageIndex === 8
            onInfoRequested: (title, body, linkLabel, linkUrl) => app.showInfoDialog(title, body, linkLabel, linkUrl)
        }
        AsrPage {
            id: asrPage
            anchors.fill: parent
            visible: app.pageIndex === 9
        }
        DiagnosticsPage {
            id: diagnosticsPage
            anchors.fill: parent
            visible: app.pageIndex === 10
        }
    }

    MCommandDialog {
        id: commandDialog
        anchors.fill: parent
        z: 60
    }

    MInfoDialog {
        id: infoDialog
        anchors.fill: parent
        z: 61
    }
}
