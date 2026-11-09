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
        right: true
    }
    margins {
        top: 6
    }
    implicitHeight: 470
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
                hideTimer.restart();
            }
        }
    }

    Component.onCompleted: {
        if (FigaroIpc.active)
            win.shown = true;
    }

    Timer {
        id: hideTimer
        interval: 220
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
                        spring: FigaroStyle.appearSpring
                        damping: FigaroStyle.appearDamping
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
                        duration: 190
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

        FigaroOrb {
            id: orb
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.top: parent.top
            anchors.topMargin: 2
            diameter: 128
            state: FigaroIpc.visualState
            level: FigaroIpc.level

            MouseArea {
                anchors.fill: parent
                // One button, two meanings, like Siri's orb: tap while idle to
                // start listening, tap while busy to make it stop.
                onClicked: {
                    if (FigaroIpc.state === "idle") FigaroIpc.send({ type: "wake" });
                    else FigaroIpc.cancel();
                }
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
            }
        }

        // The caption hangs off the ball: the neck starts where the ball's glow
        // fades, so the two are visually one object.
        FigaroCaption {
            id: caption
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.top: orb.top
            anchors.topMargin: orb.haloPadding + orb.diameter - 2
            text: FigaroIpc.partial
            state: FigaroIpc.visualState
            level: FigaroIpc.level
        }
    }

    // Only the ball is clickable.
    mask: Region {
        item: orb
        shape: RegionShape.Ellipse
    }
}
