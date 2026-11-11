import Quickshell
import Quickshell.Io
import QtQuick
import "."

// Standalone Quickshell configuration: `qs -c figaro-settings`.
// A normal, draggable toplevel window (FloatingWindow, not layer-shell) so it
// behaves like any other application — macOS System Settings style.
ShellRoot {
    id: root

    FloatingWindow {
        id: win
        visible: true
        title: I18n.t("费加罗")
        color: Theme.contentBg
        implicitWidth: Theme.windowW
        implicitHeight: Theme.windowH
        minimumSize: Qt.size(720, 500)

        App {
            id: app
            anchors.fill: parent
            targetWindow: win
        }
    }

    // The window draws its own macOS title bar, so ask KWin (through a runtime
    // KWin script, nothing is installed or persisted) to drop server-side
    // decorations. Best effort: if KWin scripting is unavailable the GUI still
    // works, it just keeps the native title bar. Set FIGARO_SETTINGS_NOBORDER=0
    // to opt out.
    Process {
        id: noBorderProcess
        running: false
        command: ["sh", "-c",
            "script=\"$1\"; " +
            "qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript figaro-settings-noborder >/dev/null 2>&1 || true; " +
            "id=$(qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript \"$script\" figaro-settings-noborder 2>/dev/null) || exit 1; " +
            "qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start >/dev/null 2>&1 || exit 2; " +
            "echo \"[figaro-settings] kwin decoration strip loaded (id $id)\"",
            "sh", Quickshell.shellPath("kwin-noborder.js")]
        stdout: StdioCollector {
            onStreamFinished: {
                if (this.text.length > 0) console.info(this.text.trim());
            }
        }
        onExited: (exitCode, exitStatus) => {
            if (exitCode !== 0)
                console.warn("[figaro-settings] could not strip compositor decorations (exit " + exitCode + "); the native title bar will stay");
        }
    }

    Component.onCompleted: {
        if (Quickshell.env("FIGARO_SETTINGS_NOBORDER") !== "0") noBorderProcess.running = true;
        console.info("[figaro-settings] window ready: " + Theme.windowW + "x" + Theme.windowH
            + ", socket " + Ipc.socketPath);
    }

    // Automation hooks for the self-test harness (settings/test/shoot.sh).
    IpcHandler {
        target: "figaro-settings"

        function page(name: string): string {
            app.showPage(name);
            return app.pageKey;
        }
        function act(name: string): string {
            return app.runAction(name);
        }
        function shot(path: string): string {
            return app.saveShot(path);
        }
        function status(): string {
            return JSON.stringify(app.statusSnapshot());
        }
        // Test harness: write one dotted config path, e.g.
        //   qs ipc call figaro-settings write asr.bargeIn.minRms 0.06
        // Values containing commas/quotes would be split by `qs ipc call`, so
        // the harness also accepts base64-encoded JSON:
        //   qs ipc call figaro-settings writeB64 asr.wakeWords RW...
        function write(path: string, valueJson: string): string {
            return app.writeFieldForTest(path, valueJson, false);
        }
        function writeB64(path: string, valueB64: string): string {
            return app.writeFieldForTest(path, valueB64, true);
        }
        function quit(): void {
            Qt.quit();
        }
        // The harness uses grabToImage(); if the compositor stopped exposing the
        // window (occluded/minimized/other desktop) the grab never completes.
        // Hiding+showing forces a fresh map so the next shot works.
        function resurface(): string {
            win.visible = false;
            win.visible = true;
            return "resurfaced";
        }
    }
}
