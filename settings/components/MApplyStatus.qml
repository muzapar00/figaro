import QtQuick
import ".."

// Compact per-field write state: 写入中 / 已生效 / 需重启 / daemon 未开放.
// Reads the tracking that Ipc.writeField()/writeFields() keep per config path.
Item {
    id: root

    property var paths: []
    property bool showWhenIdle: false

    readonly property var status: Ipc.fieldStateFor(root.paths)
    readonly property string state: root.status ? root.status.state : ""
    readonly property string label: {
        switch (root.state) {
        case "pending": return I18n.t("写入中…");
        case "applied": return I18n.t("已生效");
        case "restart": return I18n.t("已写入 · 需重启 daemon");
        case "forbidden": return I18n.t("daemon 未开放此配置");
        case "unknown": return I18n.t("已写入 · 未报告生效");
        case "error": return root.status && root.status.message ? root.status.message : I18n.t("写入失败");
        default: return "";
        }
    }
    readonly property color tone: {
        switch (root.state) {
        case "applied": return Theme.green;
        case "restart": return Theme.orange;
        case "pending": return Theme.yellow;
        case "forbidden": return Theme.red;
        case "unknown": return Theme.orange;
        case "error": return Theme.red;
        default: return Theme.textFaint;
        }
    }

    implicitWidth: row.implicitWidth
    implicitHeight: 18
    visible: root.showWhenIdle || root.state.length > 0

    Row {
        id: row
        spacing: 4

        Rectangle {
            visible: root.state.length > 0
            width: 6
            height: 6
            radius: 3
            color: root.tone
            anchors.verticalCenter: parent.verticalCenter
        }
        Text {
            text: root.label
            color: root.tone
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            anchors.verticalCenter: parent.verticalCenter
        }
    }
}
