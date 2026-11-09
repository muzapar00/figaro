import QtQuick
import qs.figaro

// The caption, as a physical part of the assistant rather than a floating label.
//
// It is tied to the ball in three ways: it hangs from the ball by a short neck
// so it reads as one object, it is tinted with the ball's current state colour,
// and it enters/grows/settles on the same springs as the ball. Long text is not
// truncated: the card grows in height (animated) and the whole reply is shown.
Item {
    id: caption

    property string text: ""
    property string state: "idle"
    property real level: 0

    readonly property color tint: FigaroStyle.colorFor(state)
    readonly property bool hasText: text.length > 0

    // The neck is the visual joint between ball and card.
    readonly property real neckHeight: 10
    readonly property real maxCardWidth: 480

    implicitWidth: card.width
    implicitHeight: neckHeight + card.height
    visible: opacity > 0.01 || card.width > 1
    opacity: hasText ? 1 : 0
    Behavior on opacity {
        NumberAnimation { duration: FigaroStyle.fadeMs; easing.type: Easing.OutCubic }
    }

    // Neck: a short rounded bar in the ball's colour, so the card does not look
    // detached. It also carries the level glow while the assistant speaks.
    Rectangle {
        id: neck
        anchors.horizontalCenter: parent.horizontalCenter
        width: 26 + caption.level * 10
        height: caption.neckHeight
        radius: width / 2
        color: Qt.rgba(caption.tint.r, caption.tint.g, caption.tint.b,
                       caption.hasText ? 0.35 + caption.level * 0.35 : 0)
        Behavior on width {
            NumberAnimation { duration: 120; easing.type: Easing.OutCubic }
        }
    }

    Rectangle {
        id: card
        anchors.top: neck.bottom
        anchors.topMargin: -4
        anchors.horizontalCenter: parent.horizontalCenter

        // Fixed maximum width, animated height: long replies wrap instead of
        // being elided, and growing is a smooth spring rather than a jump.
        width: Math.min(caption.maxCardWidth, Math.max(120, label.contentWidth + 34))
        height: label.implicitHeight + 20
        radius: height / 2

        color: Qt.rgba(0.04, 0.05, 0.10, 0.52)
        border.width: 1
        border.color: Qt.rgba(caption.tint.r, caption.tint.g, caption.tint.b,
                              0.18 + caption.level * 0.30)

        Behavior on width {
            NumberAnimation { duration: FigaroStyle.captionSpringMs; easing.type: Easing.OutBack; easing.overshoot: 1.2 }
        }
        Behavior on height {
            NumberAnimation { duration: FigaroStyle.captionSpringMs; easing.type: Easing.OutBack; easing.overshoot: 1.15 }
        }
        Behavior on radius {
            NumberAnimation { duration: FigaroStyle.captionSpringMs }
        }

        Text {
            id: label
            anchors.centerIn: parent
            // Fixed layout width: the wrap, and therefore the height, must not
            // depend on the card width the card is itself sized from.
            width: caption.maxCardWidth - 34
            text: caption.text
            color: "#f2f4ff"
            font.pixelSize: 14
            font.weight: Font.Medium
            wrapMode: Text.Wrap
            horizontalAlignment: Text.AlignHCenter
            // No maximumLineCount and no elide: show the whole reply.
        }
    }
}
