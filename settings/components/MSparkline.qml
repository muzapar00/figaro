import QtQuick
import ".."

// Rolling KWS score graph. Canvas only: no ShaderEffect / MultiEffect because
// the GUI must keep working with the software Qt Quick backend.
Item {
    id: root

    property var scores: []
    property real threshold: 0.8
    property color lineColor: Theme.accent
    property color thresholdColor: Theme.yellow

    implicitHeight: 64

    onScoresChanged: canvas.requestPaint()
    onWidthChanged: canvas.requestPaint()
    onHeightChanged: canvas.requestPaint()
    onThresholdChanged: canvas.requestPaint()

    Canvas {
        id: canvas
        anchors.fill: parent
        onPaint: {
            const ctx = getContext("2d");
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, width, height);
            const w = root.width;
            const h = root.height;
            if (w <= 0 || h <= 0) return;

            // baseline
            ctx.strokeStyle = "#3a3a42";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, h - 0.5);
            ctx.lineTo(w, h - 0.5);
            ctx.stroke();

            // detection threshold
            const ty = h - root.threshold * h;
            ctx.strokeStyle = root.thresholdColor;
            ctx.globalAlpha = 0.55;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(0, ty);
            ctx.lineTo(w, ty);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 1.0;

            const pts = root.scores || [];
            if (pts.length < 2) {
                ctx.fillStyle = Theme.textFaint;
                ctx.font = "10px " + Theme.fontSans;
                ctx.fillText(I18n.t("等待 KWS 分数…"), 6, h / 2);
                return;
            }
            const step = w / (pts.length - 1);
            ctx.beginPath();
            for (let i = 0; i < pts.length; i++) {
                const x = i * step;
                const y = h - Math.max(0, Math.min(1, pts[i])) * h;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = root.lineColor;
            ctx.lineWidth = 1.6;
            ctx.stroke();

            // soft fill under the curve
            ctx.lineTo(w, h);
            ctx.lineTo(0, h);
            ctx.closePath();
            ctx.fillStyle = Qt.rgba(root.lineColor.r, root.lineColor.g, root.lineColor.b, 0.13);
            ctx.fill();

            // newest value dot
            const last = Math.max(0, Math.min(1, pts[pts.length - 1]));
            ctx.beginPath();
            ctx.arc(w - 2, h - last * h, 2.6, 0, Math.PI * 2, false);
            ctx.fillStyle = last > root.threshold ? Theme.red : root.lineColor;
            ctx.fill();
        }
    }
}
