import QtQuick
import qs.figaro
// KOS's compositor glass: the same native declaration the shell's dock and bar
// use for their liquid-glass finish. KWin paints refraction, glints and noise
// for the declared shape; the client paints no material of its own.
import Kos.SurfaceShape 1.0

// The assistant as one morphed object.
//
//   idle / waking / listening / finalizing - a ball
//   thinking / speaking with text           - the ball stretches into a pill:
//                                             the ball shrinks to the left end,
//                                             the reply fills the right
//
// Apple's motion guideline asks for one purposeful movement rather than several
// competing ones, and for feedback that follows expectations. So every geometry
// here is derived from a single animated value, `morphProgress`: the pill's
// width and height, its corner radius, the ball's scale and slide, and the text
// slide are all the same curve. It reads as one elastic object being pulled into
// a new shape, not as a pill appearing next to a ball.
//
// Under reduce motion the same progress is critically damped, so shapes still
// change but never bounce, and text simply cross-fades.
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
    readonly property bool reduce: FigaroStyle.reduceMotion

    // The one value everything else is derived from.
    property real morphProgress: morph ? 1 : 0
    Behavior on morphProgress {
        SpringAnimation {
            spring: shell.reduce ? 5.5 : 3.2
            damping: shell.reduce ? 1.0 : 0.46
            mass: 1.0
            epsilon: 0.001
        }
    }

    readonly property real ballDiameter: 128
    readonly property real ballScale: 1.0 - (1.0 - 0.62) * Math.max(0, Math.min(1, morphProgress))
    readonly property real ballBox: ballDiameter * ballScale

    readonly property real padH: 14
    readonly property real padV: 12
    readonly property real gap: 12
    readonly property real maxTextW: 400

    Text {
        id: measure
        visible: false
        text: shell.text
        font.pixelSize: 14
        font.weight: Font.Medium
        wrapMode: Text.NoWrap
    }

    readonly property real targetTextW: Math.min(measure.implicitWidth, maxTextW)
    readonly property real targetCapsuleW: padH * 2 + ballBox + gap + targetTextW
    readonly property real targetCapsuleH: Math.max(ballBox + padV * 2, label.implicitHeight + padV * 2)

    readonly property real capsuleW: ballDiameter + (targetCapsuleW - ballDiameter) * Math.max(0, Math.min(1, morphProgress))
    readonly property real capsuleH: ballDiameter + (targetCapsuleH - ballDiameter) * Math.max(0, Math.min(1, morphProgress))

    readonly property color tint: FigaroStyle.colorFor(visualState)

    // Jelly impulse: when the pill starts stretching, the body squashes for a
    // moment and springs back. One value, driven by a short spring, so the ball
    // and the pill squash together instead of each doing its own thing.
    property real jelly: 0
    onMorphChanged: jellyAnim.restart()
    SequentialAnimation {
        id: jellyAnim
        running: false
        NumberAnimation {
            target: shell; property: "jelly"; to: 1
            duration: 120; easing.type: Easing.OutCubic
        }
        NumberAnimation {
            target: shell; property: "jelly"; to: 0
            duration: 260; easing.type: Easing.OutCubic
        }
    }
    readonly property real jellyScaleX: 1 + jelly * 0.035
    readonly property real jellyScaleY: 1 - jelly * 0.045

    implicitWidth: 760
    implicitHeight: 240

    // Declare the pill's shape to KWin's glass effect: this is the same
    // declaration the KOS dock and bar use, and it is what makes the capsule
    // liquid glass rather than a translucent rectangle. The compositor owns
    // blur, refraction and the rim light for the declared shape; the client
    // paints only a legibility veil.
    property var glassShape: SurfaceShape {
        target: shell.morphProgress > 0.02 ? capsule : null
        blurSigma: 26
        effectType: SurfaceShape.Liquid
        material: SurfaceShape.Regular
        // KOS tints its glass the same way: a fixed dark tint keeps white text
        // readable while the compositor's blur and rim light still show through.
        tintMode: SurfaceShape.Fixed
        tintColor: "black"
        tintOpacity: 0.46
        radius: capsule.height / 2
        exponent: 2.0
        enabled: shell.morphProgress > 0.02
    }

    // The pill. At progress 0 this rectangle is exactly the ball's circle, so
    // the same item is the ball and the pill at once.
    Rectangle {
        id: capsule
        anchors.centerIn: parent
        transform: Scale {
            origin.x: capsule.width / 2
            origin.y: capsule.height / 2
            xScale: shell.reduce ? 1 : shell.jellyScaleX
            yScale: shell.reduce ? 1 : shell.jellyScaleY
        }
        width: shell.capsuleW
        height: shell.capsuleH
        radius: height / 2
        // The compositor owns the glass finish and its tint; keep this
        // transparent so nothing fights the refraction.
        color: "transparent"
        // KWin draws the rim; keep only a faint state-tinted inner edge so the
        // assistant still reads blue / violet / magenta through the glass.
        border.width: shell.morphProgress > 0.05 ? 1 : 0
        border.color: Qt.rgba(shell.tint.r, shell.tint.g, shell.tint.b,
                              0.30 + shell.level * 0.35)
        Behavior on color { ColorAnimation { duration: FigaroStyle.crossfadeMs; easing.type: Easing.OutCubic } }
    }

    FigaroOrb {
        id: ball
        diameter: shell.ballDiameter
        // The ball is being pulled by the pill, so it follows a slightly softer
        // spring: it lags a few frames behind, which reads as weight.
        Behavior on x { SpringAnimation { spring: 2.5; damping: 0.40; mass: 1.0 } }
        Behavior on y { SpringAnimation { spring: 2.5; damping: 0.40; mass: 1.0 } }
        state: shell.visualState
        level: shell.level

        // Position by the *visible* ball centre: the canvas item is larger than
        // the ball because it also carries the halo.
        readonly property real centerX: capsule.x + shell.padH * shell.morphProgress + shell.ballBox / 2
            + (1 - shell.morphProgress) * (shell.width / 2 - capsule.x - shell.padH / 2 - shell.ballBox / 2)
        readonly property real centerY: capsule.y + capsule.height / 2
        x: centerX - width / 2
        y: centerY - height / 2
        scale: shell.ballScale
    }

    // The reply. Text is being read, so its motion is precise: it slides on the
    // same progress curve but never overshoots, and it fades rather than scaling.
    Text {
        id: label
        text: shell.text
        font.pixelSize: 14
        font.weight: Font.Medium
        color: "#f2f4ff"
        wrapMode: Text.Wrap
        width: shell.targetTextW
        x: capsule.x + shell.padH + shell.ballBox + shell.gap * shell.morphProgress
        y: capsule.y + (capsule.height - height) / 2
        opacity: Math.min(1, shell.morphProgress * 1.2)
        horizontalAlignment: Text.AlignLeft
        Behavior on opacity { NumberAnimation { duration: FigaroStyle.textFadeMs; easing.type: Easing.OutCubic } }
        Behavior on y { NumberAnimation { duration: FigaroStyle.textSlideMs; easing.type: Easing.OutCubic } }
        // A 3 px rise while fading in: enough to feel intentional, small enough
        // that it never moves text the eye is already reading.
        transform: Translate { y: (1 - Math.min(1, shell.morphProgress)) * 3 }
    }

    // Click target: the ball, or the whole pill once it exists. Exposed so the
    // window masks its input region to exactly this area.
    readonly property Item hitItem: hit

    MouseArea {
        id: hit
        x: capsule.x
        y: capsule.y
        width: capsule.width
        height: capsule.height
        onClicked: {
            if (shell.state === "idle") FigaroIpc.send({ type: "wake" });
            else FigaroIpc.cancel();
        }
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
    }
}
