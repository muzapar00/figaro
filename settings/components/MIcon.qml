import QtQuick
import ".."

// Small stroked icon set drawn with Canvas so the GUI needs no icon font and
// no ShaderEffect (software renderer safe). Everything is drawn in an 18x18
// logical box and scaled to `size`.
Item {
    id: root

    property string kind: "system"
    property color color: Theme.textDim
    property int size: 18

    implicitWidth: size
    implicitHeight: size

    onKindChanged: canvas.requestPaint()
    onColorChanged: canvas.requestPaint()
    onSizeChanged: canvas.requestPaint()

    Canvas {
        id: canvas
        anchors.fill: parent
        onPaint: {
            const ctx = getContext("2d");
            const s = root.size / 18;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, root.size, root.size);
            ctx.scale(s, s);
            ctx.strokeStyle = root.color;
            ctx.fillStyle = root.color;
            ctx.lineWidth = 1.6;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";

            switch (root.kind) {
            case "overview": // speedometer
                ctx.beginPath();
                ctx.arc(9, 10, 6, Math.PI * 1.08, Math.PI * 1.92, false);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(9, 10);
                ctx.lineTo(12.6, 5.6);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(9, 10, 1.1, 0, Math.PI * 2, false);
                ctx.fill();
                break;
            case "wake": // waveform
                ctx.beginPath();
                ctx.moveTo(3, 9); ctx.lineTo(3, 9);
                ctx.moveTo(5.2, 6); ctx.lineTo(5.2, 12);
                ctx.moveTo(7.8, 3.6); ctx.lineTo(7.8, 14.4);
                ctx.moveTo(10.4, 5.4); ctx.lineTo(10.4, 12.6);
                ctx.moveTo(12.9, 7); ctx.lineTo(12.9, 11);
                ctx.moveTo(15.2, 8.2); ctx.lineTo(15.2, 9.8);
                ctx.stroke();
                break;
            case "mic":
                ctx.beginPath();
                ctx.arc(9, 6.6, 2.7, Math.PI, 0, false);
                ctx.lineTo(11.7, 9.6);
                ctx.arc(9, 9.6, 2.7, 0, Math.PI, false);
                ctx.lineTo(6.3, 6.6);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(9, 12.4); ctx.lineTo(9, 15);
                ctx.moveTo(6.2, 15.2); ctx.lineTo(11.8, 15.2);
                ctx.stroke();
                break;
            case "speaker":
                ctx.beginPath();
                ctx.moveTo(3.6, 7.2); ctx.lineTo(6, 7.2); ctx.lineTo(9, 4.2);
                ctx.lineTo(9, 13.8); ctx.lineTo(6, 10.8); ctx.lineTo(3.6, 10.8);
                ctx.closePath();
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(9.2, 9, 3.4, -0.9, 0.9, false);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(9.2, 9, 5.6, -0.75, 0.75, false);
                ctx.stroke();
                break;
            case "text":
                ctx.beginPath();
                ctx.moveTo(4, 5); ctx.lineTo(14, 5);
                ctx.moveTo(4, 9); ctx.lineTo(11, 9);
                ctx.moveTo(4, 13); ctx.lineTo(13, 13);
                ctx.stroke();
                break;
            case "diagnostics": // stethoscope
                ctx.beginPath();
                ctx.arc(5.5, 12.2, 2.2, 0, Math.PI * 2, false);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(5.5, 10); ctx.lineTo(5.5, 6.2);
                ctx.quadraticCurveTo(5.5, 3.6, 9.4, 3.6);
                ctx.quadraticCurveTo(12.6, 3.6, 12.6, 6.2);
                ctx.lineTo(12.6, 8.4);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(12.6, 10.2, 1.7, 0, Math.PI * 2, false);
                ctx.stroke();
                break;
            case "sliders":
                ctx.beginPath();
                ctx.moveTo(3, 5); ctx.lineTo(15, 5);
                ctx.moveTo(3, 9); ctx.lineTo(15, 9);
                ctx.moveTo(3, 13); ctx.lineTo(15, 13);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(7, 5, 1.6, 0, Math.PI * 2, false);
                ctx.fill();
                ctx.beginPath();
                ctx.arc(11.5, 9, 1.6, 0, Math.PI * 2, false);
                ctx.fill();
                ctx.beginPath();
                ctx.arc(6.5, 13, 1.6, 0, Math.PI * 2, false);
                ctx.fill();
                break;
            case "shapePill":
                ctx.beginPath();
                ctx.moveTo(6.2, 5.4); ctx.lineTo(11.8, 5.4);
                ctx.quadraticCurveTo(14.6, 5.4, 14.6, 9);
                ctx.quadraticCurveTo(14.6, 12.6, 11.8, 12.6);
                ctx.lineTo(6.2, 12.6);
                ctx.quadraticCurveTo(3.4, 12.6, 3.4, 9);
                ctx.quadraticCurveTo(3.4, 5.4, 6.2, 5.4);
                ctx.closePath();
                ctx.stroke();
                break;
            case "shapeBall":
                ctx.beginPath();
                ctx.arc(9, 9, 5.6, 0, Math.PI * 2, false);
                ctx.stroke();
                break;
            case "shapeLine":
                ctx.beginPath();
                ctx.moveTo(2.8, 9); ctx.lineTo(15.2, 9);
                ctx.stroke();
                break;
            case "key":
                ctx.beginPath();
                ctx.arc(6.4, 9, 2.6, 0, Math.PI * 2, false);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(9, 9); ctx.lineTo(15.4, 9);
                ctx.moveTo(13, 9); ctx.lineTo(13, 11.6);
                ctx.moveTo(15.4, 9); ctx.lineTo(15.4, 11.1);
                ctx.stroke();
                break;
            case "folder":
                ctx.beginPath();
                ctx.moveTo(3.2, 6.2); ctx.lineTo(7.4, 6.2); ctx.lineTo(8.6, 7.8);
                ctx.lineTo(14.8, 7.8); ctx.lineTo(14.8, 13.2); ctx.lineTo(3.2, 13.2);
                ctx.closePath();
                ctx.stroke();
                break;
            case "wand":
                ctx.beginPath();
                ctx.moveTo(4, 14); ctx.lineTo(11.4, 6.6);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(12.6, 3.2); ctx.lineTo(13.4, 5.2); ctx.lineTo(15.4, 6);
                ctx.lineTo(13.4, 6.8); ctx.lineTo(12.6, 8.8); ctx.lineTo(11.8, 6.8);
                ctx.lineTo(9.8, 6); ctx.lineTo(11.8, 5.2);
                ctx.closePath();
                ctx.fill();
                break;
            case "chat":
                ctx.beginPath();
                ctx.moveTo(5.2, 3.8); ctx.lineTo(13.6, 3.8);
                ctx.quadraticCurveTo(15.4, 3.8, 15.4, 5.6);
                ctx.lineTo(15.4, 10.2);
                ctx.quadraticCurveTo(15.4, 12, 13.6, 12);
                ctx.lineTo(9.4, 12); ctx.lineTo(6.2, 14.8);
                ctx.lineTo(6.6, 12); ctx.lineTo(5.2, 12);
                ctx.quadraticCurveTo(3.4, 12, 3.4, 10.2);
                ctx.lineTo(3.4, 5.6);
                ctx.quadraticCurveTo(3.4, 3.8, 5.2, 3.8);
                ctx.closePath();
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(6.5, 7.9, 0.95, 0, Math.PI * 2, false);
                ctx.arc(9.4, 7.9, 0.95, 0, Math.PI * 2, false);
                ctx.arc(12.3, 7.9, 0.95, 0, Math.PI * 2, false);
                ctx.fill();
                break;
            case "chevronDown":
                ctx.beginPath();
                ctx.moveTo(5.6, 7.4); ctx.lineTo(9, 10.8); ctx.lineTo(12.4, 7.4);
                ctx.stroke();
                break;
            case "chevronRight":
                ctx.beginPath();
                ctx.moveTo(7.4, 5.6); ctx.lineTo(10.8, 9); ctx.lineTo(7.4, 12.4);
                ctx.stroke();
                break;
            case "check":
                ctx.beginPath();
                ctx.moveTo(3.8, 9.4); ctx.lineTo(7.2, 12.8); ctx.lineTo(14.2, 5.2);
                ctx.stroke();
                break;
            case "close":
                ctx.beginPath();
                ctx.moveTo(5.2, 5.2); ctx.lineTo(12.8, 12.8);
                ctx.moveTo(12.8, 5.2); ctx.lineTo(5.2, 12.8);
                ctx.stroke();
                break;
            case "minus":
                ctx.beginPath();
                ctx.moveTo(5, 9); ctx.lineTo(13, 9);
                ctx.stroke();
                break;
            case "plus":
                ctx.beginPath();
                ctx.moveTo(9, 5.2); ctx.lineTo(9, 12.8);
                ctx.moveTo(5.2, 9); ctx.lineTo(12.8, 9);
                ctx.stroke();
                break;
            case "play":
                ctx.beginPath();
                ctx.moveTo(6, 4.4); ctx.lineTo(13.6, 9); ctx.lineTo(6, 13.6);
                ctx.closePath();
                ctx.fill();
                break;
            case "stop":
                ctx.fillRect(5.4, 5.4, 7.2, 7.2);
                break;
            case "record":
                ctx.beginPath();
                ctx.arc(9, 9, 4.2, 0, Math.PI * 2, false);
                ctx.fill();
                break;
            case "export":
                ctx.beginPath();
                ctx.moveTo(9, 3.4); ctx.lineTo(9, 11.4);
                ctx.moveTo(5.8, 8.4); ctx.lineTo(9, 11.6); ctx.lineTo(12.2, 8.4);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(4, 13.2); ctx.lineTo(4, 14.6); ctx.lineTo(14, 14.6); ctx.lineTo(14, 13.2);
                ctx.stroke();
                break;
            case "refresh":
                ctx.beginPath();
                ctx.arc(9, 9, 5, Math.PI * 0.35, Math.PI * 1.75, false);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(12.4, 4.2); ctx.lineTo(14.2, 7.4); ctx.lineTo(10.8, 7.6);
                ctx.closePath();
                ctx.fill();
                break;
            case "warning":
                ctx.beginPath();
                ctx.moveTo(9, 3.4); ctx.lineTo(15.4, 14.6); ctx.lineTo(2.6, 14.6);
                ctx.closePath();
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(9, 7.4); ctx.lineTo(9, 10.8);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(9, 12.9, 0.9, 0, Math.PI * 2, false);
                ctx.fill();
                break;
            case "info":
                ctx.beginPath();
                ctx.arc(9, 9, 6.4, 0, Math.PI * 2, false);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(9, 8.2); ctx.lineTo(9, 12.6);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(9, 5.9, 0.95, 0, Math.PI * 2, false);
                ctx.fill();
                break;
            case "external":
                ctx.beginPath();
                ctx.moveTo(7.4, 4.2); ctx.lineTo(4.6, 4.2); ctx.lineTo(4.6, 13.8); ctx.lineTo(14.2, 13.8); ctx.lineTo(14.2, 11.0);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(10.6, 3.4); ctx.lineTo(14.6, 3.4); ctx.lineTo(14.6, 7.4);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(9.0, 9.0); ctx.lineTo(14.4, 3.6);
                ctx.stroke();
                break;
            case "dot":
                ctx.beginPath();
                ctx.arc(9, 9, 3.2, 0, Math.PI * 2, false);
                ctx.fill();
                break;
            default:
                ctx.beginPath();
                ctx.arc(9, 9, 6, 0, Math.PI * 2, false);
                ctx.stroke();
                break;
            }
        }
    }
}
