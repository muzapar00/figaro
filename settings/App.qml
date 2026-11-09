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
        { key: "overview", label: "概览", icon: "overview" },
        { key: "wake", label: "唤醒", icon: "wake" },
        { key: "mic", label: "麦克风", icon: "mic" },
        { key: "voice", label: "语音", icon: "speaker" },
        { key: "asr", label: "识别", icon: "text" },
        { key: "diagnostics", label: "诊断", icon: "diagnostics" },
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

    function runAction(name) {
        // scroll:<px> lets the self-test harness park the page at an offset.
        if (name.indexOf("scroll:") === 0) return app.scrollCurrent(name.slice(7));
        switch (name) {
        case "wake-start": return wakePage.startWakeTest();
        case "wake-stop": return wakePage.stopWakeTest();
        case "ambient-start": return wakePage.startAmbientTest();
        case "ambient-stop": return wakePage.stopAmbientTest();
        case "ambient-csv": return wakePage.exportAmbientCsv();
        case "wake-noise-on": return wakePage.setNoisePlayback(true);
        case "wake-noise-off": return wakePage.setNoisePlayback(false);
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
        const pages = [overviewPage, wakePage, micPage, voicePage, asrPage, diagnosticsPage];
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
            wake: wakePage.snapshot(),
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
        title: "费加罗设置"
        subtitle: ""
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
        }
        WakePage {
            id: wakePage
            anchors.fill: parent
            visible: app.pageIndex === 1
        }
        MicPage {
            id: micPage
            anchors.fill: parent
            visible: app.pageIndex === 2
        }
        VoicePage {
            id: voicePage
            anchors.fill: parent
            visible: app.pageIndex === 3
        }
        AsrPage {
            id: asrPage
            anchors.fill: parent
            visible: app.pageIndex === 4
        }
        DiagnosticsPage {
            id: diagnosticsPage
            anchors.fill: parent
            visible: app.pageIndex === 5
        }
    }
}
