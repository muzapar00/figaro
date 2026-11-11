import QtQuick
import QtQuick.Layouts
import ".."

// 紧凑的服务商按钮：white logo + 名字，点一下直接打开取 Key 页面。
// logo 缺失（如 OpenAI 的 Simple Icons 404）时退化为同色系文字圆标。
Rectangle {
    id: root

    property string label: ""
    property string logoSource: ""
    property string fallbackText: ""
    property color fallbackColor: Theme.accent
    property string fallbackTextColor: "#ffffff"

    signal clicked()

    implicitWidth: contentRow.implicitWidth + 22
    implicitHeight: Theme.controlH
    radius: 8
    color: mouseArea.containsMouse ? Theme.controlBgHover : Theme.controlBg
    border.width: 0.5
    border.color: Qt.rgba(1, 1, 1, 0.12)

    RowLayout {
        id: contentRow
        anchors.centerIn: parent
        spacing: 7

        Image {
            visible: root.logoSource.length > 0
            source: root.logoSource
            sourceSize: Qt.size(32, 32)
            Layout.preferredWidth: 16
            Layout.preferredHeight: 16
            fillMode: Image.PreserveAspectFit
            smooth: true
            mipmap: true
        }

        Rectangle {
            visible: root.logoSource.length === 0
            Layout.preferredWidth: 16
            Layout.preferredHeight: 16
            radius: 8
            color: root.fallbackColor
            Text {
                anchors.centerIn: parent
                text: root.fallbackText.length > 0 ? root.fallbackText : root.label.slice(0, 1)
                color: root.fallbackTextColor
                font.family: Theme.fontSans
                font.pixelSize: 9
                font.weight: Font.DemiBold
            }
        }

        Text {
            text: root.label
            color: Theme.text
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            font.weight: Font.DemiBold
        }
    }

    MouseArea {
        id: mouseArea
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.clicked()
    }
}
