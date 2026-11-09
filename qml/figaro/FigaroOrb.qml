import QtQuick
import Quickshell

// The visual sphere: one shader pass for the liquid body, plus ring/dot layers
// for the "I am listening" / "I am thinking" cues.
//
// Motion follows the Apple HIG rules we already use elsewhere in this desktop:
// motion that follows input (the mic level) is direct and unsprung, while
// state changes (idle -> listening -> thinking) use short springs with a
// little overshoot so the orb feels like a physical object.
Item {
    id: orb

    property string state: "idle"
    property real level: 0            // 0..1, raw from the daemon
    property real diameter: 200

    readonly property bool listening: state === "listening"
    readonly property bool thinking: state === "thinking"
    readonly property bool speaking: state === "speaking"

    // Smoothed level: fast attack, slower release. Raw 15 Hz mic levels look
    // like a volume meter if they drive the shader directly.
    property real env: 0
    readonly property real energy: thinking ? 0.95 : speaking ? 0.72 + env * 0.28 : 0.48 + env * 0.52
    readonly property real hue: thinking ? 0.76 : speaking ? 0.56 : 0.30

    implicitWidth: diameter
    implicitHeight: diameter

    FrameAnimation {
        id: frame
        running: orb.visible && orb.state !== "idle"
        onTriggered: {
            const dt = Math.min(frame.frameTime, 50) / 1000;
            const target = orb.state === "idle" ? 0 : orb.level;
            const rate = target > orb.env ? 17 : 5.5;
            orb.env += (target - orb.env) * (1 - Math.exp(-dt * rate));
        }
    }

    ShaderEffect {
        id: body
        // The shader draws a halo outside the nominal diameter, so the item is
        // larger than the sphere itself.
        width: orb.diameter * 2.1
        height: width
        anchors.centerIn: parent

        vertexShader: "shaders/figaro_orb.vert.qsb"
        fragmentShader: "shaders/figaro_orb.frag.qsb"

        property real uTime: frame.elapsedTime
        property real uLevel: orb.env
        property real uEnergy: orb.energy
        property real uOpacity: 1.0
        property real uWidth: width
        property real uHeight: height
        property real uThinking: orb.thinking ? 1.0 : 0.0
        property real uHue: orb.hue
    }

    // Listening: two rings that expand out of the sphere, like sonar. Their
    // brightness rides the mic envelope so silence looks calm.
    Item {
        anchors.fill: parent
        visible: orb.listening
        opacity: orb.listening ? 1 : 0
        Behavior on opacity {
            NumberAnimation {
                duration: 180
                easing.type: Easing.OutCubic
            }
        }

        property real pulse: 0
        NumberAnimation on pulse {
            from: 0
            to: 1
            duration: 2100
            loops: Animation.Infinite
            running: orb.listening
        }

        Repeater {
            model: 2
            Rectangle {
                required property int index
                readonly property real phase: (parent.pulse + index * 0.5) % 1.0
                width: orb.diameter
                height: width
                radius: width / 2
                anchors.centerIn: parent
                color: "transparent"
                border.width: 1.5
                border.color: Qt.rgba(0.66, 0.74, 1.0, 0.55)
                scale: 0.86 + phase * 0.72
                opacity: (1 - phase) * (0.22 + 0.62 * orb.env)
            }
        }
    }

    // Thinking: a slow orbiting constellation of dots.
    Item {
        id: spinner
        width: orb.diameter * 1.02
        height: width
        anchors.centerIn: parent
        visible: orb.thinking
        opacity: orb.thinking ? 1 : 0
        Behavior on opacity {
            NumberAnimation {
                duration: 220
                easing.type: Easing.OutCubic
            }
        }

        RotationAnimation on rotation {
            from: 0
            to: 360
            duration: 2600
            loops: Animation.Infinite
            running: orb.thinking
        }

        Repeater {
            model: 6
            Rectangle {
                required property int index
                readonly property real angle: index / 6 * Math.PI * 2
                readonly property real orbitRadius: spinner.width * 0.5 - 6
                width: 5
                height: 5
                radius: 2.5
                color: "#cdd8ff"
                x: spinner.width / 2 + Math.cos(angle) * orbitRadius - width / 2
                y: spinner.width / 2 + Math.sin(angle) * orbitRadius - height / 2
                opacity: 0.18 + 0.82 * (index / 6)
                scale: 0.8 + 0.4 * (index / 6)
            }
        }
    }
}
