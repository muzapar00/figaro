pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io

// Mirrors the Figaro daemon socket (see docs/ipc.md §3) into QML properties.
// Owns no visuals: it only parses NDJSON and exposes the latest state.
Singleton {
    id: root

    // FIGARO_SOCKET lets a development harness point the overlay at a fake
    // daemon. Never share the production socket path with test tooling: two
    // daemons on one path silently disconnect each other's clients.
    readonly property string socketPath: Quickshell.env("FIGARO_SOCKET")
        || ((Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/figaro/sock")

    property bool connected: false
    property string state: "idle"   // idle | listening | thinking | speaking
    property real level: 0          // 0..1
    property string partial: ""     // ASR interim / streamed reply text
    property string reply: ""
    property string toolLabel: ""

    readonly property bool active: state !== "idle"

    Socket {
        id: sock
        path: root.socketPath
        connected: true
        parser: SplitParser {
            onRead: line => root.handleLine(line)
        }
        onConnectionStateChanged: root.connected = sock.connected
    }

    // Reconnect forever: the daemon is a user service and may restart under us.
    Timer {
        interval: 1200
        repeat: true
        running: true
        onTriggered: {
            if (!root.connected) {
                sock.connected = false;
                sock.connected = true;
            } else {
                root.send({ type: "ping" });
            }
        }
    }

    onConnectedChanged: {
        if (root.connected) {
            root.send({ type: "subscribe" });
        } else {
            root.state = "idle";
            root.level = 0;
            root.partial = "";
            root.toolLabel = "";
        }
    }

    function send(obj) {
        sock.write(JSON.stringify(obj) + "\n");
        sock.flush();
    }

    function cancel() {
        root.send({ type: "cancel" });
    }

    function handleLine(line) {
        var msg;
        try {
            msg = JSON.parse(line);
        } catch (e) {
            return;
        }
        if (!msg || typeof msg.type !== "string")
            return;

        switch (msg.type) {
        case "state":
            root.state = msg.state || "idle";
            if (root.state !== "listening")
                root.level = 0;
            if (root.state === "thinking") {
                root.reply = "";
                root.partial = "";
            }
            if (root.state === "idle") {
                root.partial = "";
                root.toolLabel = "";
            }
            break;
        case "level":
            root.level = Math.max(0, Math.min(1, Number(msg.value) || 0));
            break;
        case "partial":
            root.partial = msg.text || "";
            break;
        case "reply":
            root.reply = msg.text || "";
            root.partial = msg.text || "";
            break;
        case "tool":
            root.toolLabel = msg.status === "start" ? (msg.summary || msg.name || "") : "";
            break;
        case "error":
            console.warn("[figaro] daemon error: " + msg.message);
            break;
        }
    }
}
