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
    implicitWidth: 820
    margins {
        top: 6
        left: Math.round((win.screen ? win.screen.width - win.implicitWidth : 0) / 2)
    }
    implicitHeight: 400
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
        opacity: 1
        y: 0

        // The whole assembly (ball + caption) drops in from above the screen
        // edge on one spring, and leaves on a plain ease-out. Everything inside
        // moves with it, which is what keeps it reading as one object.
        states: State {
            name: "hidden"
            when: !win.shown
            PropertyChanges {
                target: content
                opacity: 0
                y: -content.height - 24
            }
        }

        transitions: [
            Transition {
                from: "hidden"
                to: ""
                animations: [
                    SpringAnimation {
                        target: content
                        property: "y"
                        to: 0
                        spring: FigaroStyle.reduceMotion ? 5.5 : FigaroStyle.appearSpring
                        damping: FigaroStyle.reduceMotion ? 1.0 : FigaroStyle.appearDamping
                        mass: 1.0
                        epsilon: 0.001
                    },
                    NumberAnimation {
                        target: content
                        property: "opacity"
                        to: 1
                        duration: FigaroStyle.fadeMs
                        easing.type: Easing.OutCubic
                    }
                ]
            },
            Transition {
                from: ""
                to: "hidden"
                animations: [
                    NumberAnimation {
                        target: content
                        property: "y"
                        to: -content.height - 24
                        duration: FigaroStyle.exitMs + 30
                        easing.type: Easing.InCubic
                    },
                    NumberAnimation {
                        target: content
                        property: "opacity"
                        to: 0
                        duration: 160
                        easing.type: Easing.OutCubic
                    }
                ]
            }
        ]

        // One assembly that morphs: a ball while it listens, a pill while it
        // answers (ball on the left, reply on the right).
        FigaroCapsule {
            id: shell
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.top: parent.top
            anchors.topMargin: 2
            state: FigaroIpc.visualState
            level: FigaroIpc.level
            // The user asked for text only in the answering shape; while
            // listening the pill is just a ball.
            text: (FigaroIpc.visualState === "speaking" || FigaroIpc.visualState === "thinking")
                ? FigaroIpc.partial : ""
        }
    }

    // Only the assembly is clickable (ball, or the whole pill once it exists).
    mask: Region {
        item: shell.hitItem
        shape: RegionShape.Rect
    }
}
