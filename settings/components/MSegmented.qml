import QtQuick
import QtQuick.Layouts
import ".."

// macOS segmented control: inset capsule track, raised selected segment.
Item {
    id: root

    property var options: []          // ["low", "medium", "high"] or [{value, label}]
    property int currentIndex: 0
    property bool interactive: true

    signal activated(int index, string value)

    implicitWidth: Math.max(120, row.implicitWidth + 4)
    implicitHeight: 28

    function valueAt(i) {
        const opt = root.options[i];
        if (opt === undefined) return "";
        return typeof opt === "object" ? (opt.value !== undefined ? opt.value : opt.label) : opt;
    }
    function labelAt(i) {
        const opt = root.options[i];
        if (opt === undefined) return "";
        return typeof opt === "object" ? (opt.label !== undefined ? opt.label : opt.value) : opt;
    }
    function indexOfValue(v) {
        for (let i = 0; i < root.options.length; i++)
            if (root.valueAt(i) === v) return i;
        return 0;
    }

    Rectangle {
        id: track
        anchors.fill: parent
        radius: 7
        color: Theme.insetBg
    }

    RowLayout {
        id: row
        anchors.fill: parent
        anchors.margins: 2
        spacing: 2

        Repeater {
            model: root.options.length

            Rectangle {
                id: segment
                Layout.fillWidth: true
                Layout.fillHeight: true
                implicitWidth: segLabel.implicitWidth + 18
                radius: 6
                color: root.currentIndex === index
                    ? (root.interactive ? Theme.controlBgActive : Theme.controlBg)
                    : "transparent"

                Text {
                    id: segLabel
                    anchors.centerIn: parent
                    text: root.labelAt(index)
                    color: root.currentIndex === index ? Theme.text : Theme.textDim
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                    font.weight: root.currentIndex === index ? Font.DemiBold : Font.Normal
                }

                MouseArea {
                    anchors.fill: parent
                    enabled: root.interactive
                    cursorShape: root.interactive ? Qt.PointingHandCursor : Qt.ArrowCursor
                    onClicked: {
                        root.currentIndex = index;
                        root.activated(index, root.valueAt(index));
                    }
                }
            }
        }
    }
}
