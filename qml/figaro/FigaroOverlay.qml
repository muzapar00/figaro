import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.figaro

// A transparent layer-shell overlay that appears only while Figaro is awake.
// It never takes keyboard focus, and its input region is masked to the sphere
// so the rest of the strip stays click-through.
PanelWindow {
    id: win

    screen: Quickshell.screens.length > 0 ? Quickshell.screens[0] : null
    anchors {
        bottom: true
        left: true
        right: true
    }
    margins {
        bottom: 84
    }
    implicitHeight: 440
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

    // Keep the window alive long enough to play the exit animation.
    Timer {
        id: hideTimer
        interval: 240
        onTriggered: win.shown = false
    }

    Item {
        id: content
        anchors.fill: parent
        opacity: 1
        scale: 1

        // Entering: a short spring with a little overshoot, i.e. the orb pops
        // into existence. Leaving: plain ease-out, quick, no bounce — a bounce
        // on dismissal reads as "it came back", the opposite of calm.
        states: State {
            name: "hidden"
            when: !win.shown
            PropertyChanges {
                target: content
                opacity: 0
                scale: 0.76
            }
        }

        transitions: [
            Transition {
                from: "hidden"
                to: ""
                animations: [
                    SpringAnimation {
                        target: content
                        property: "scale"
                        to: 1
                        spring: 3.9
                        damping: 0.66
                        mass: 1.0
                        epsilon: 0.001
                    },
                    NumberAnimation {
                        target: content
                        property: "opacity"
                        to: 1
                        duration: 170
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
                        property: "scale"
                        to: 0.76
                        duration: 150
                        easing.type: Easing.OutCubic
                    },
                    NumberAnimation {
                        target: content
                        property: "opacity"
                        to: 0
                        duration: 140
                        easing.type: Easing.OutCubic
                    }
                ]
            }
        ]

        Item {
            id: stack
            width: 560
            height: 400
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.bottom: parent.bottom

            FigaroOrb {
                id: orb
                anchors.horizontalCenter: parent.horizontalCenter
                anchors.top: parent.top
                anchors.topMargin: 20
                diameter: 196
                state: FigaroIpc.state
                level: FigaroIpc.level

                MouseArea {
                    anchors.fill: parent
                    // The sphere doubles as the stop button: Siri behaves the
                    // same way, and it is the one place users already point at.
                    onClicked: FigaroIpc.cancel()
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                }
            }

            Column {
                id: captions
                anchors.horizontalCenter: parent.horizontalCenter
                anchors.top: orb.bottom
                anchors.topMargin: 2
                width: 470
                spacing: 6

                Text {
                    id: line
                    width: parent.width
                    visible: FigaroIpc.partial.length > 0
                    text: FigaroIpc.partial
                    color: "#f2f4ff"
                    font.pixelSize: 15
                    font.weight: Font.Medium
                    horizontalAlignment: Text.AlignHCenter
                    wrapMode: Text.Wrap
                    maximumLineCount: 2
                    elide: Text.ElideRight
                    // Soft shadow instead of an outline: over a bright wallpaper
                    // outlined text looks cheap.
                    style: Text.Raised
                    styleColor: Qt.rgba(0, 0, 0, 0.45)
                }

                Text {
                    id: tool
                    width: parent.width
                    visible: FigaroIpc.toolLabel.length > 0 && FigaroIpc.state === "thinking"
                    text: FigaroIpc.toolLabel
                    color: "#c3ccf2"
                    font.pixelSize: 12
                    horizontalAlignment: Text.AlignHCenter
                    elide: Text.ElideRight
                    opacity: 0.75
                    style: Text.Raised
                    styleColor: Qt.rgba(0, 0, 0, 0.4)
                }
            }
        }
    }

    // Only the sphere is clickable; everything else in the strip passes through
    // to whatever is underneath.
    mask: Region {
        item: orb
        shape: RegionShape.Ellipse
    }
}
