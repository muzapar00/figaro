import QtQuick
import QtQuick.Layouts
import ".."

// Scrollable page body with a slim macOS-style scroll indicator.
Flickable {
    id: root

    property int spacing: 16
    property int outerPadding: Theme.padOuter

    default property alias content: stack.data

    clip: true
    contentWidth: width
    contentHeight: stack.implicitHeight + root.outerPadding * 2
    boundsBehavior: Flickable.StopAtBounds
    flickDeceleration: 2500

    ColumnLayout {
        id: stack
        x: root.outerPadding
        y: root.outerPadding
        width: Math.max(0, root.width - root.outerPadding * 2)
        spacing: root.spacing
    }

    function scrollBottom() {
        contentY = Math.max(0, contentHeight - height);
    }
    function scrollTop() {
        contentY = 0;
    }
    function scrollTo(y) {
        contentY = Math.max(0, Math.min(contentHeight - height, y));
    }

    Rectangle {
        id: scrollbar
        visible: root.contentHeight > root.height
        width: 4
        radius: 2
        color: Qt.rgba(1, 1, 1, 0.40)
        x: root.width - 7
        height: Math.max(28, root.height * root.height / Math.max(1, root.contentHeight))
        y: Math.max(2, Math.min(root.height - height - 2,
                               root.visibleArea.yPosition * root.height))
    }
}
