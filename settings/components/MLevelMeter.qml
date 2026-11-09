import QtQuick
import ".."

// Segmented microphone level meter. Green -> yellow -> red, with a peak marker.
// Everything is plain rectangles so it also renders with QT_QUICK_BACKEND=software.
Item {
    id: root

    property real level: 0
    property real peak: 0
    property bool clipped: false
    property int segments: 28
    property int segmentGap: 2

    implicitHeight: 18

    Row {
        id: blocks
        anchors.fill: parent
        spacing: root.segmentGap

        Repeater {
            model: root.segments

            Rectangle {
                width: Math.max(1, (root.width - (root.segments - 1) * root.segmentGap) / root.segments)
                height: root.height
                radius: 1.5
                readonly property real fraction: (index + 0.5) / root.segments
                readonly property bool lit: root.level >= fraction
                color: {
                    if (root.clipped && lit) return Theme.red;
                    if (fraction > 0.86) return Theme.red;
                    if (fraction > 0.66) return Theme.yellow;
                    return Theme.green;
                }
                opacity: lit ? 1.0 : 0.12
                Behavior on opacity {
                    NumberAnimation { duration: 60 }
                }
            }
        }
    }

    // Peak marker: a thin bright notch so fast transients are visible.
    Rectangle {
        width: 2
        height: parent.height + 2
        y: -1
        radius: 1
        color: root.clipped ? Theme.red : "#ffffff"
        opacity: root.peak > 0.02 ? 0.9 : 0
        x: Math.max(0, Math.min(root.width - width, root.peak * root.width - 1))
        Behavior on x {
            NumberAnimation { duration: 80 }
        }
    }
}
