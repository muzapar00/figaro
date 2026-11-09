import QtQuick
import Quickshell

// The assistant's face: one soft ball of light plus a single level ring.
//
// Deliberately three moving elements at most (ball, ring, caption). Earlier
// iterations added sonar rings, an orbiting dot constellation and a separate
// waveform, which made it impossible to read the state at a glance — the
// opposite of what the Apple HIG motion guidance asks for.
Item {
    id: orb

    property string state: "idle"
    property real level: 0
    property real diameter: 168

    readonly property bool listening: state === "listening"
    readonly property bool thinking: state === "thinking"
    readonly property bool speaking: state === "speaking"

    // Envelope: fast attack, slower release, so the ball tracks a voice without
    // looking like a VU meter.
    property real env: 0
    readonly property real energy: thinking ? 0.85 : speaking ? 0.7 + env * 0.3 : 0.45 + env * 0.4
    readonly property real hue: thinking ? 0.62 : speaking ? 0.52 : 0.30

    implicitWidth: diameter
    implicitHeight: diameter

    // Breathing only while thinking: a slow, readable "I am working" cue that
    // does not pull the eye away from whatever the person is doing.
    property real breath: 0
    SequentialAnimation on breath {
        running: orb.thinking
        loops: Animation.Infinite
        NumberAnimation {
            from: 0
            to: 1
            duration: 1600
            easing.type: Easing.InOutSine
        }
        NumberAnimation {
            from: 1
            to: 0
            duration: 1600
            easing.type: Easing.InOutSine
        }
    }

    FrameAnimation {
        id: frame
        running: orb.visible && orb.state !== "idle"
        onTriggered: {
            const dt = Math.min(frame.frameTime, 50) / 1000;
            const target = orb.state === "idle" ? 0 : orb.level;
            const rate = target > orb.env ? 15 : 5.0;
            orb.env += (target - orb.env) * (1 - Math.exp(-dt * rate));
        }
    }

    Item {
        id: body
        anchors.centerIn: parent
        width: orb.diameter
        height: width
        scale: orb.thinking ? 1.0 + orb.breath * 0.022 : 1.0

        ShaderEffect {
            id: fx
            width: orb.diameter * 1.9
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

        // One ring, one job: show that the microphone is hearing something.
        // It only appears while listening; there is nothing to orbit or stack.
        Rectangle {
            id: ring
            anchors.centerIn: parent
            readonly property real live: orb.listening ? orb.env : 0
            width: orb.diameter * (0.98 + live * 0.16)
            height: width
            radius: width / 2
            color: "transparent"
            border.width: 1.2
            border.color: Qt.rgba(0.62, 0.72, 1.0, 0.20 + live * 0.55)
            opacity: orb.listening ? 0.9 : 0
            Behavior on opacity {
                NumberAnimation {
                    duration: 180
                    easing.type: Easing.OutCubic
                }
            }
        }
    }
}
