import QtQuick
import QtQuick.Layouts
import ".."
import "../components"

// 外观：整体动画尺寸、形状、动画开关、窗口按钮大小。
// 所有值写 ui.*，daemon 热生效（QML 订阅 {type:"ui"} 帧，无需重启）。
MPageScroll {
    id: page

    property real scaleValue: 1.0
    property string shapeValue: "orb"
    property string motionValue: "auto"
    property int buttonSizeValue: 16
    property bool advanced: true

    readonly property var shapes: [
        { id: "orb", label: "球 ↔ 胶囊", hint: "倾听时是球，回答时展开成胶囊（默认）", icon: "shapePill" },
        { id: "ball", label: "始终是球", hint: "一直是球，字幕浮在球下方", icon: "shapeBall" },
        { id: "line", label: "一条线", hint: "细横线，随音量起伏，字幕在线下方", icon: "shapeLine" },
    ]

    function syncFromConfig() {
        page.scaleValue = Number(Ipc.uiValue("scale", 1.0));
        page.shapeValue = String(Ipc.uiValue("shape", "orb"));
        page.motionValue = String(Ipc.uiValue("motion", "auto"));
        page.buttonSizeValue = Number(Ipc.uiValue("windowButtonSize", 16));
    }

    function writeScale(value) {
        const v = Math.round(value * 100) / 100;
        page.scaleValue = v;
        Ipc.writeField("ui.scale", v);
    }
    function writeShape(value) {
        page.shapeValue = value;
        Ipc.writeField("ui.shape", value);
    }
    function writeMotion(off) {
        page.motionValue = off ? "off" : "auto";
        Ipc.writeField("ui.motion", off ? "off" : "auto");
    }
    function writeButtonSize(value) {
        page.buttonSizeValue = value;
        Ipc.writeField("ui.windowButtonSize", value);
    }

    function resetDefaults() {
        page.scaleValue = 1.0;
        page.shapeValue = "orb";
        page.motionValue = "auto";
        page.buttonSizeValue = 16;
        scaleDebounce.stop();
        Ipc.writeFields([
            { path: "ui.scale", value: 1.0 },
            { path: "ui.shape", value: "orb" },
            { path: "ui.motion", value: "auto" },
            { path: "ui.windowButtonSize", value: 16 },
        ]);
        return "appearance-reset";
    }

    // Harness: write a distinctive scale + shape so shoot.sh can assert it.
    function demoWrite() {
        page.scaleValue = 1.25;
        page.shapeValue = "ball";
        page.motionValue = "auto";
        page.buttonSizeValue = 20;
        Ipc.writeFields([
            { path: "ui.scale", value: 1.25 },
            { path: "ui.shape", value: "ball" },
            { path: "ui.motion", value: "auto" },
            { path: "ui.windowButtonSize", value: 20 },
        ]);
        return "appearance-demo-written";
    }

    function snapshot() {
        return {
            title: "外观",
            scale: page.scaleValue,
            shape: page.shapeValue,
            motion: page.motionValue,
            windowButtonSize: page.buttonSizeValue,
            daemonUi: Ipc.uiSnapshot,
        };
    }

    Connections {
        target: Ipc
        function onConfigChanged() { page.syncFromConfig(); }
        function onUiSnapshotChanged() { page.syncFromConfig(); }
    }

    Component.onCompleted: page.syncFromConfig()

    // Debounced write while dragging: avoid a config.set storm.
    Timer {
        id: scaleDebounce
        interval: 350
        repeat: false
        onTriggered: page.writeScale(page.scaleValue)
    }

    MPageHeader {
        title: "外观"
        subtitle: "动画尺寸、形状与窗口按钮 —— 改动即时生效"
        icon: "sliders"
    }

    MCard {
        title: "动画尺寸"
        subtitle: "整体缩放：球 / 胶囊 / 字幕一起按比例放大或缩小"

        MRow {
            label: "整体尺寸"
            subtitle: "ui.scale · 0.5× – 2.0×（拖动松手后 0.35 秒写入，避免刷配置）"
            showSeparator: false
            RowLayout {
                spacing: 10
                Text {
                    text: "×" + page.scaleValue.toFixed(2)
                    color: Theme.text
                    font.family: Theme.fontSans
                    font.pixelSize: 16
                    font.weight: Font.DemiBold
                    Layout.preferredWidth: 62
                    horizontalAlignment: Text.AlignRight
                }
                MSlider {
                    Layout.preferredWidth: 210
                    from: 0.5
                    to: 2.0
                    value: page.scaleValue
                    markers: [1.0]
                    onMoved: (v) => {
                        page.scaleValue = Math.round(v * 100) / 100;
                        scaleDebounce.restart();
                    }
                }
                MApplyStatus { paths: ["ui.scale"] }
            }
        }
    }

    MCard {
        title: "形状"
        subtitle: "ui.shape · 决定费加罗倾听/回答时显示成什么"

        RowLayout {
            Layout.fillWidth: true
            spacing: 10

            Repeater {
                model: page.shapes

                Rectangle {
                    id: shapeCard
                    required property var modelData
                    Layout.fillWidth: true
                    implicitHeight: 116
                    radius: 10
                    color: page.shapeValue === modelData.id ? Qt.rgba(0.04, 0.52, 1.0, 0.14) : Theme.insetBg
                    border.width: page.shapeValue === modelData.id ? 1 : 0.5
                    border.color: page.shapeValue === modelData.id ? Theme.accent : Qt.rgba(1, 1, 1, 0.08)

                    Column {
                        anchors.fill: parent
                        anchors.margins: 12
                        spacing: 6
                        Row {
                            spacing: 8
                            MIcon {
                                kind: shapeCard.modelData.icon
                                size: 18
                                color: page.shapeValue === shapeCard.modelData.id ? Theme.accent : Theme.textDim
                                anchors.verticalCenter: parent.verticalCenter
                            }
                            Text {
                                text: shapeCard.modelData.label
                                color: Theme.text
                                font.family: Theme.fontSans
                                font.pixelSize: Theme.fs
                                font.weight: Font.DemiBold
                                anchors.verticalCenter: parent.verticalCenter
                            }
                        }
                        Text {
                            width: parent.width
                            text: shapeCard.modelData.hint
                            color: Theme.textFaint
                            font.family: Theme.fontSans
                            font.pixelSize: Theme.fsTiny
                            wrapMode: Text.WordWrap
                            lineHeight: 1.2
                        }
                    }

                    // small live sketch of the selected shape
                    Rectangle {
                        anchors.right: parent.right
                        anchors.bottom: parent.bottom
                        anchors.margins: 10
                        width: shapeCard.modelData.id === "line" ? 46 : 22
                        height: shapeCard.modelData.id === "line" ? 3 : 22
                        radius: shapeCard.modelData.id === "orb" ? 11 : (shapeCard.modelData.id === "ball" ? 11 : 2)
                        color: Qt.rgba(0.04, 0.52, 1.0, 0.35)
                        border.width: shapeCard.modelData.id === "orb" ? 0 : 0
                    }

                    MouseArea {
                        anchors.fill: parent
                        cursorShape: Qt.PointingHandCursor
                        onClicked: page.writeShape(shapeCard.modelData.id)
                    }
                }
            }
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            MApplyStatus { paths: ["ui.shape"] }
            Item { Layout.fillWidth: true }
            Text {
                text: "形状由主界面读取，设置窗口保留当前选择。"
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsTiny
            }
        }
    }

    MCard {
        title: "动画"
        subtitle: "ui.motion · 关闭后状态切换瞬间完成，没有任何过渡动画"

        MRow {
            label: "关闭动画"
            subtitle: "ui.motion = off（默认 auto）。系统级「减弱动态效果」由桌面环境负责，这里只影响费加罗自己的动画"
            showSeparator: false
            RowLayout {
                spacing: 8
                MApplyStatus { paths: ["ui.motion"] }
                MToggle {
                    checked: page.motionValue === "off"
                    onToggled: (value) => page.writeMotion(value)
                }
            }
        }
    }

    MCard {
        title: "窗口按钮大小"
        subtitle: "ui.windowButtonSize · 左上角红黄绿交通灯（默认 16px）"

        MRow {
            label: "按钮大小"
            subtitle: "12 / 16 / 20 像素；改变后本窗口标题栏立即跟着变"
            RowLayout {
                spacing: 8
                MApplyStatus { paths: ["ui.windowButtonSize"] }
                MSegmented {
                    Layout.preferredWidth: 190
                    options: ["12 px", "16 px", "20 px"]
                    currentIndex: page.buttonSizeValue <= 12 ? 0 : (page.buttonSizeValue >= 20 ? 2 : 1)
                    onActivated: (index, value) => {
                        const sizes = [12, 16, 20];
                        page.writeButtonSize(sizes[index]);
                    }
                }
            }
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 14
            MTrafficLight { size: 12; tone: "#ff5f57"; glyph: "close" }
            MTrafficLight { size: 12; tone: "#febc2e"; glyph: "minus" }
            MTrafficLight { size: 12; tone: "#28c840"; glyph: "plus" }
            Text { text: "12 px"; color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: Theme.fsTiny }
            Item { width: 6; height: 1 }
            MTrafficLight { size: 16; tone: "#ff5f57"; glyph: "close" }
            MTrafficLight { size: 16; tone: "#febc2e"; glyph: "minus" }
            MTrafficLight { size: 16; tone: "#28c840"; glyph: "plus" }
            Text { text: "16 px（默认）"; color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: Theme.fsTiny }
            Item { width: 6; height: 1 }
            MTrafficLight { size: 20; tone: "#ff5f57"; glyph: "close" }
            MTrafficLight { size: 20; tone: "#febc2e"; glyph: "minus" }
            MTrafficLight { size: 20; tone: "#28c840"; glyph: "plus" }
            Text { text: "20 px"; color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: Theme.fsTiny }
            Item { Layout.fillWidth: true }
        }
    }

    MAdvancedCard {
        title: "高级"
        subtitle: "恢复默认外观 / daemon 当前生效值"
        expanded: page.advanced

        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            MButton {
                text: "恢复默认外观"
                icon: "refresh"
                onClicked: page.resetDefaults()
            }
            MApplyStatus {
                paths: ["ui.scale", "ui.shape", "ui.motion", "ui.windowButtonSize"]
            }
            Item { Layout.fillWidth: true }
        }
        Text {
            Layout.fillWidth: true
            text: "daemon 当前生效：scale=×" + Number(Ipc.uiValue("scale", 1.0)).toFixed(2)
                + " · shape=" + String(Ipc.uiValue("shape", "orb"))
                + " · motion=" + String(Ipc.uiValue("motion", "auto"))
                + " · windowButtonSize=" + Number(Ipc.uiValue("windowButtonSize", 16)) + "px"
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            wrapMode: Text.WordWrap
        }
    }
}
