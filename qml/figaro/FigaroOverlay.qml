import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.figaro

// A transparent layer-shell surface that exists only while Figaro is awake.
//
// One ball, one caption. The window is masked to the ball so the rest of the
// strip stays click-through, and it never takes keyboard focus.
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
    implicitHeight: 300
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
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.top: parent.top
        width: 560
        height: 280
        y: 0
        opacity: 1

        // Appearing is a state change, so it gets a short spring; disappearing
        // is a dismissal, so it gets a plain ease-out. A bounce on dismissal
        // reads as "it came back", which is the opposite of calm.
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
                    // The ball drops in from just above the screen edge and
                    // settles with a small elastic overshoot. A spring is the
                    // right model here: it is a physical object arriving, not a
                    // UI panel expanding.
                    SpringAnimation {
                        target: content
                        property: "y"
                        to: 0
                        spring: 4.4
                        damping: 0.52
                        mass: 1.0
                        epsilon: 0.001
                    },
                    NumberAnimation {
                        target: content
                        property: "opacity"
                        to: 1
                        duration: 200
                        easing.type: Easing.OutCubic
                    }
                ]
            },
            Transition {
                from: ""
                to: "hidden"
                animations: [
                    // Leaving: straight up and out, quickly. A spring on the
                    // way out would bounce it back into view.
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
            anchors.topMargin: 0
            diameter: 150
            state: FigaroIpc.state
            level: FigaroIpc.level

            MouseArea {
                anchors.fill: parent
                // The ball is the stop button: the one place a person already
                // looks when they want the assistant to be quiet.
                onClicked: FigaroIpc.cancel()
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
            }
        }

        // Caption: what was heard, or what is being said. One line, elided —
        // a paragraph under the ball competes with it instead of supporting it.
        Text {
            id: caption
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.top: orb.bottom
            anchors.topMargin: 8
            width: Math.min(implicitWidth, 520)
            text: FigaroIpc.partial
            color: "#eef1ff"
            font.pixelSize: 14
            elide: Text.ElideRight
            horizontalAlignment: Text.AlignHCenter
            visible: text.length > 0
            style: Text.Raised
            styleColor: Qt.rgba(0, 0, 0, 0.55)
            opacity: visible ? 1 : 0
            Behavior on opacity {
                NumberAnimation {
                    duration: 160
                    easing.type: Easing.OutCubic
                }
            }
        }
    }

    // Only the ball is clickable.
    mask: Region {
        item: orb
        shape: RegionShape.Ellipse
    }
}
