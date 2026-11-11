import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.figaro

// A transparent layer-shell surface that exists only while Figaro is awake.
//
// One ball, one caption, one motion language (FigaroStyle). The window is
// masked to the ball so the rest of the strip stays click-through, and it never
// takes keyboard focus.
//
// Layout note: the orb's canvas is deliberately kept *inside* the window. If it
// is allowed to cross the surface edge, the software renderer paints a 1px
// opaque black row along that edge - the "black line" that used to run across
// the top of the screen.
PanelWindow {
    id: win

    screen: Quickshell.screens.length > 0 ? Quickshell.screens[0] : null
    anchors {
        top: true
        left: true
    }
    // Layer shell has no horizontal centre anchor, so the surface is kept as
    // narrow as the widest pill and pushed to the centre with a left margin.
    // A full-width transparent surface costs several times more to composite on
    // the software renderer (measured: 72% of a core vs ~20%).
    // Preferences are pushed by the daemon (settings -> config -> IPC).
    readonly property real uiScale: FigaroIpc.uiScale
    readonly property string shape: FigaroIpc.uiShape
    readonly property bool motionOn: FigaroIpc.uiMotion !== "off"
    readonly property bool showCaption: shape !== "orb"
    readonly property string captionText: (FigaroIpc.visualState === "thinking" || FigaroIpc.visualState === "speaking")
        ? FigaroIpc.partial : ""
    readonly property color stateColor: FigaroStyle.colorFor(FigaroIpc.visualState)

    implicitWidth: Math.round(baseWidth * uiScale)
    property int baseWidth: 820
    margins {
        top: 6
        left: Math.round((win.screen ? win.screen.width - win.implicitWidth : 0) / 2)
    }
    implicitHeight: Math.round(400 * uiScale)
    exclusiveZone: 0
    color: "transparent"

    WlrLayershell.layer: WlrLayershell.Overlay
    WlrLayershell.keyboardFocus: WlrLayershell.None
    WlrLayershell.namespace: "figaro-overlay"

    property bool shown: false
    visible: shown

    Connections {
        target: FigaroIpc
        function onActiveChanged() {
            if (FigaroIpc.active) {
                win.shown = true;
                hideTimer.stop();
            } else if (win.shown) {
                win.hideRequestedAt = Date.now();
                hideTimer.restart();
            }
        }
    }

    Component.onCompleted: {
        if (FigaroIpc.active)
            win.shown = true;
        // One line in the journal so field reports can tell which desktop the
        // overlay is on and whether real compositor glass is in play.
        console.log("[figaro] desktop=" + (FigaroStyle.desktopName || "unknown")
            + " session=" + (FigaroStyle.sessionType || "unknown")
            + " glass=" + (FigaroStyle.useCompositorGlass ? "kos" : "translucent-fallback"));
    }

    // Leaving is a sequence: the pill first collapses back into the ball (a real
    // spring, visible), and only then does the window withdraw upwards. The
    // timer is a safety net for the case where the capsule is already a ball.
    Timer {
        id: hideTimer
        interval: 60
        repeat: true
        onTriggered: {
            if (shell.collapsed) {
                hideTimer.stop();
                // A short beat so the ball is registered before it withdraws;
                // without it the collapse and the exit read as one blurred move.
                settleBeat.start();
            } else if (Date.now() - win.hideRequestedAt > 1400) {
                // Safety: never keep the window around if the retraction stalls.
                hideTimer.stop();
                win.shown = false;
            }
        }
    }

    property real hideRequestedAt: 0

    Timer {
        id: settleBeat
        interval: 110
        onTriggered: win.shown = false
    }

    Item {
        id: content
        anchors.fill: parent
        y: win.shown ? 0 : -content.height - 24
        opacity: win.shown ? 1 : 0
        // One behaviour drives the whole entry/exit: the assembly drops in from
        // above the edge and leaves the same way. With ui.motion off the
        // behaviour is disabled, so state changes are instant.
        Behavior on y {
            enabled: win.motionOn
            SpringAnimation {
                spring: FigaroStyle.reduceMotion ? 5.5 : FigaroStyle.appearSpring
                damping: FigaroStyle.reduceMotion ? 1.0 : FigaroStyle.appearDamping
                mass: 1.0
                epsilon: 0.001
            }
        }
        Behavior on opacity {
            enabled: win.motionOn
            NumberAnimation { duration: 150; easing.type: Easing.OutCubic }
        }

        // One assembly that morphs: a ball while it listens, a pill while it
        // answers (ball on the left, reply on the right).
        FigaroCapsule {
            id: shell
            // In line mode the line replaces the ball entirely.
            visible: win.shape !== "line"
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.top: parent.top
            anchors.topMargin: 2
            state: FigaroIpc.visualState
            level: FigaroIpc.level
            uiScale: win.uiScale
            allowMorph: win.shape === "orb"
            motionEnabled: win.motionOn
            // The user asked for text only in the answering shape; while
            // listening the pill is just a ball.
            text: (FigaroIpc.visualState === "speaking" || FigaroIpc.visualState === "thinking")
                ? FigaroIpc.partial : ""
        }

        // ------------------------------------------------------- caption modes ---
        // "ball" and "line" keep the same state colours and level response, but the
        // answer text sits underneath instead of inside a pill, and "line" replaces
        // the ball with a horizontal level line.

        // ball mode: the same ball, with the caption floating under it
        Rectangle {
            id: ballCaption
            visible: win.shape === "ball" && win.captionText.length > 0
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.top: shell.bottom
            anchors.topMargin: Math.round(8 * win.uiScale)
            width: Math.min(ballCaptionLabel.implicitWidth + 28 * win.uiScale, Math.round(720 * win.uiScale))
            height: ballCaptionLabel.implicitHeight + Math.round(14 * win.uiScale)
            radius: height / 2
            color: Qt.rgba(win.stateColor.r, win.stateColor.g, win.stateColor.b, 0.16)
            border.width: 1
            border.color: Qt.rgba(1, 1, 1, 0.10)

            Text {
                id: ballCaptionLabel
                anchors.centerIn: parent
                width: Math.min(implicitWidth, Math.round(692 * win.uiScale))
                text: win.captionText
                wrapMode: Text.Wrap
                horizontalAlignment: Text.AlignHCenter
                color: "#f4f4f8"
                    font.pixelSize: 14 * win.uiScale
            }
        }

        // line mode: hide the ball, draw a level line, caption underneath
        Item {
            id: lineMode
            visible: win.shape === "line"
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.top: parent.top
            anchors.topMargin: Math.round(40 * win.uiScale)
            width: Math.round(560 * win.uiScale)
            height: Math.round(170 * win.uiScale)

            Rectangle {
                id: lineCore
                anchors.horizontalCenter: parent.horizontalCenter
                y: Math.round(10 * win.uiScale)
                width: Math.round((240 + 260 * Math.min(1, FigaroIpc.level)) * win.uiScale)
                height: Math.max(4, Math.round(9 * win.uiScale))
                radius: height / 2
                color: win.stateColor
                opacity: 0.95
                Behavior on width {
                    enabled: win.motionOn
                    NumberAnimation { duration: 90; easing.type: Easing.OutCubic }
                }
            }

            Rectangle {
                // soft halo behind the line
                anchors.horizontalCenter: lineCore.horizontalCenter
                y: lineCore.y - Math.round(7 * win.uiScale)
                width: lineCore.width + Math.round(28 * win.uiScale)
                height: Math.max(10, Math.round(23 * win.uiScale))
                radius: height / 2
                color: win.stateColor
                opacity: 0.18
            }

            Rectangle {
                id: lineCaption
                visible: win.captionText.length > 0
                anchors.horizontalCenter: parent.horizontalCenter
                anchors.top: lineCore.bottom
                anchors.topMargin: Math.round(16 * win.uiScale)
                width: Math.min(lineCaptionLabel.implicitWidth + Math.round(32 * win.uiScale), parent.width)
                height: lineCaptionLabel.implicitHeight + Math.round(16 * win.uiScale)
                radius: height / 2
                color: Qt.rgba(0.02, 0.03, 0.06, 0.38)

                Text {
                    id: lineCaptionLabel
                    anchors.centerIn: parent
                    width: Math.min(implicitWidth, Math.round(520 * win.uiScale))
                    text: win.captionText
                    wrapMode: Text.Wrap
                    horizontalAlignment: Text.AlignHCenter
                    color: "#f4f4f8"
                            font.pixelSize: 14 * win.uiScale
                }
            }
        }
    }

    // Only the visible assembly is clickable (tap = cancel).
    mask: Region {
        item: win.shape === "line" ? lineMode : shell.hitItem
        shape: RegionShape.Rect
    }
}
