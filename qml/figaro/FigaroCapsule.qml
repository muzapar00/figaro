import QtQuick
import qs.figaro

// The assistant as one morphed object.
//
//   idle / waking / listening / finalizing - a ball (FigaroOrb draws it)
//   thinking / speaking with text           - the ball stretches into a pill:
//                                             the ball shrinks to the left side
//                                             and the reply fills the right
//
// Everything below is bound, so the whole morph is a single state change: the
// capsule's rectangle and the ball's scale/offset ride the same spring, which
// is what makes it read as one elastic object being pulled into a new shape
// rather than a pill appearing next to a ball.
Item {
    id: shell

    property string state: "idle"
    property string text: ""
    property real level: 0

    readonly property string visualState: state === "waking" ? "listening"
        : state === "finalizing" ? "thinking"
        : state
    readonly property bool hasText: text.length > 0
    readonly property bool morph: hasText && (visualState === "thinking" || visualState === "speaking")

    // Ball size: full size when it is the whole object, smaller once it has to
    // share the pill with the text.
    readonly property real ballDiameter: 128
    readonly property real ballScale: morph ? 0.62 : 1.0

    readonly property real padH: 14
    readonly property real padV: 12
    readonly property real gap: 12
    readonly property real maxTextW: 400
    readonly property real ballBox: ballDiameter * ballScale

    // Natural (unwrapped) text width decides whether the pill can shrink-wrap.
    Text {
        id: measure
        visible: false
        text: shell.text
        font.pixelSize: 14
        font.weight: Font.Medium
        wrapMode: Text.NoWrap
    }

    readonly property real textW: !morph ? 0 : Math.min(measure.implicitWidth, maxTextW)
    readonly property real capsuleW: morph ? padH * 2 + ballBox + gap + textW : ballDiameter
    readonly property real capsuleH: morph
        ? Math.max(ballBox + padV * 2, label.implicitHeight + padV * 2)
        : ballDiameter

    readonly property color tint: FigaroStyle.colorFor(visualState)

    implicitWidth: 760
    implicitHeight: 240

    // The pill. When it is a ball this rectangle is exactly the ball's circle,
    // so the same item morphs between the two shapes.
    Rectangle {
        id: capsule
        anchors.centerIn: parent
        width: shell.capsuleW
        height: shell.capsuleH
        radius: height / 2
        color: Qt.rgba(0.05, 0.06, 0.12, shell.morph ? 0.58 : 0.0)
        border.width: shell.morph ? 1 : 0
        border.color: Qt.rgba(shell.tint.r, shell.tint.g, shell.tint.b,
                              shell.morph ? 0.28 + shell.level * 0.30 : 0)

        // The bounce of the whole morph lives here: width, height and radius
        // all ride the same spring, so the pill overshoots and settles as one
        // elastic body.
        Behavior on width { SpringAnimation { spring: 3.2; damping: 0.46; mass: 1.0 } }
        Behavior on height { SpringAnimation { spring: 3.2; damping: 0.46; mass: 1.0 } }
        Behavior on radius { SpringAnimation { spring: 3.2; damping: 0.46; mass: 1.0 } }
        Behavior on color { ColorAnimation { duration: 200; easing.type: Easing.OutCubic } }
        Behavior on border.width { NumberAnimation { duration: 160 } }
    }

    // The ball: same item in both shapes, it only shrinks and slides left.
    FigaroOrb {
        id: ball
        diameter: shell.ballDiameter
        state: shell.visualState
        level: shell.level

        // Position by the *visible* ball centre (the canvas item is larger than
        // the ball because it also carries the halo).
        readonly property real centerX: shell.morph
            ? capsule.x + shell.padH + shell.ballBox / 2
            : shell.width / 2
        readonly property real centerY: capsule.y + capsule.height / 2
        x: centerX - width / 2
        y: centerY - height / 2
        scale: shell.ballScale

        Behavior on x { SpringAnimation { spring: 3.2; damping: 0.46; mass: 1.0 } }
        Behavior on y { SpringAnimation { spring: 3.2; damping: 0.46; mass: 1.0 } }
        Behavior on scale { SpringAnimation { spring: 3.2; damping: 0.46; mass: 1.0 } }
    }

    // The reply, inside the pill on the right. It slides in from under the ball
    // and fades, on the same spring as everything else.
    Text {
        id: label
        text: shell.text
        font.pixelSize: 14
        font.weight: Font.Medium
        color: "#f2f4ff"
        wrapMode: Text.Wrap
        width: shell.textW
        x: capsule.x + shell.padH + shell.ballBox + (shell.morph ? shell.gap : 0)
        y: capsule.y + (capsule.height - height) / 2
        opacity: shell.morph ? 1 : 0
        horizontalAlignment: Text.AlignLeft

        Behavior on x { SpringAnimation { spring: 3.2; damping: 0.46; mass: 1.0 } }
        Behavior on y { SpringAnimation { spring: 3.2; damping: 0.46; mass: 1.0 } }
        Behavior on opacity { NumberAnimation { duration: 180; easing.type: Easing.OutCubic } }
    }

    // Click target: the ball, or the whole pill once it exists. Exposed so the
    // window can mask its input region to exactly this area.
    readonly property Item hitItem: hit

    MouseArea {
        id: hit
        x: shell.morph ? capsule.x : ball.centerX - shell.ballDiameter / 2
        y: shell.morph ? capsule.y : ball.centerY - shell.ballDiameter / 2
        width: shell.morph ? capsule.width : shell.ballDiameter
        height: shell.morph ? capsule.height : shell.ballDiameter
        onClicked: {
            if (shell.state === "idle") FigaroIpc.send({ type: "wake" });
            else FigaroIpc.cancel();
        }
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
    }
}
