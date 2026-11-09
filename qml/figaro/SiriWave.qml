// Figaro voice wave — a QML port of the classic Siri waveform.
//
// Algorithm ported from `siriwave` (iOS 9 curve):
//   https://github.com/vitaly-z/siriwave  (MIT, Copyright (c) 2020 Flavio Maria De Stefano)
// See qml/THIRD_PARTY_NOTICES.md for the full notice. The maths is the original's;
// the drawing is reimplemented on a QML Canvas and the colours are Figaro's.
//
// The original model is: a few *coloured groups*, each made of several random
// curves that are summed into one shape and filled. That sum-of-curves is what
// gives Siri its lumpy, organic silhouette — drawing one thin line per curve
// looks like a seismograph instead.
import QtQuick
import QtQuick.Controls

Item {
    id: wave

    property real level: 0        // 0..1 raw input level
    property bool active: false
    property real amplitude: active ? 0.34 + level * 0.66 : 0.0
    property real speed: 1.0
    // Travel distance. The original canvas is much larger than this strip, so
    // the same maths yields only a few pixels here unless scaled up.
    readonly property real gain: 3.6

    readonly property var groupColors: ["#6b3fd4", "#d94fd0", "#3fc6e0"]

    implicitWidth: 560
    implicitHeight: 132

    opacity: active ? 1.0 : 0.0
    visible: opacity > 0.01
    Behavior on opacity {
        NumberAnimation {
            duration: wave.active ? 220 : 260
            easing.type: Easing.OutCubic
        }
    }

    // ---- ported constants ---------------------------------------------------
    readonly property int graphX: 25
    readonly property real attFactor: 4.0
    readonly property real despawnFactor: 0.02
    readonly property real speedFactor: 1.0
    readonly property real pixelDepth: 1.0

    // ---- ported state -------------------------------------------------------
    property real timeSec: 0
    property real spawnAt: 0
    property var groups: []       // [{color, curves:[{phase,amp,timeout,offset,speed,final,width,verse}]}]

    function randRange(lo, hi) {
        return lo + Math.random() * (hi - lo);
    }

    function spawnGroup(color) {
        const count = Math.floor(randRange(2, 5.999));
        const curves = [];
        for (let i = 0; i < count; i++) {
            curves.push({
                phase: 0,
                amp: 0,
                timeout: randRange(0.5, 2.0),
                offset: randRange(-3, 3),
                speed: randRange(0.5, 1.0),
                final: randRange(0.3, 1.0),
                width: randRange(1, 3),
                verse: randRange(-1, 1)
            });
        }
        return { color: color, curves: curves };
    }

    function spawn() {
        spawnAt = timeSec;
        const next = [];
        for (let g = 0; g < groupColors.length; g++)
            next.push(spawnGroup(groupColors[g]));
        groups = next;
    }

    function globalAttFn(x) {
        return Math.pow(attFactor / (attFactor + x * x), attFactor);
    }

    // Sum of the group's curves, normalised to <= 1.
    function yRelativePos(group, i) {
        let y = 0;
        const n = group.curves.length;
        for (let ci = 0; ci < n; ci++) {
            const c = group.curves[ci];
            // Static spread so curves start apart, plus a random offset.
            let t = 4 * (-1 + (ci / Math.max(1, n - 1)) * 2) + c.offset;
            const k = 1 / c.width;
            const x = i * k - t;
            y += Math.abs(c.amp * Math.sin(c.verse * x - c.phase) * globalAttFn(x));
        }
        return y / Math.max(1, n);
    }

    function yPos(group, i) {
        const mid = height * 0.5;
        return 0.8 * mid * amplitude * yRelativePos(group, i) * globalAttFn((i / graphX) * 2) * gain;
    }

    function xPos(i) {
        return width * ((i + graphX) / (graphX * 2));
    }

    function advance(dt) {
        const norm = Math.max(0.2, Math.min(dt * 60, 3));   // frame-rate independent
        if (groups.length === 0) {
            spawn();
            return;
        }
        for (const group of groups) {
            for (const c of group.curves) {
                const at = spawnAt + c.timeout;
                c.amp += (timeSec >= at ? -despawnFactor : despawnFactor) * norm;
                c.amp = Math.min(Math.max(c.amp, 0), c.final);
                c.phase = (c.phase + speed * c.speed * speedFactor * dt * 6.0) % (2 * Math.PI);
            }
        }
    }

    function paint(ctx) {
        ctx.reset();
        ctx.clearRect(0, 0, width, height);
        if (groups.length === 0 || amplitude <= 0.001)
            return;

        const mid = height * 0.5;

        // Support line: the faint horizontal strand from the original.
        const grad = ctx.createLinearGradient(0, mid, width, mid);
        grad.addColorStop(0.0, "rgba(255,255,255,0)");
        grad.addColorStop(0.14, "rgba(214,224,255,0.20)");
        grad.addColorStop(0.86, "rgba(214,224,255,0.20)");
        grad.addColorStop(1.0, "rgba(255,255,255,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, mid - 0.5, width, 1);

        ctx.globalCompositeOperation = "lighter";

        let maxY = -Infinity;

        for (const group of groups) {
            for (const sign of [1, -1]) {
                ctx.beginPath();
                for (let i = -graphX; i <= graphX; i += pixelDepth) {
                    const x = xPos(i);
                    const y = yPos(group, i);
                    if (i === -graphX)
                        ctx.moveTo(x, mid + sign * y);
                    else
                        ctx.lineTo(x, mid + sign * y);
                    maxY = Math.max(maxY, y);
                }
                ctx.closePath();

                // Filled band plus a bright rim: the fill is what makes it read
                // as Siri rather than as a line chart.
                ctx.fillStyle = group.color;
                ctx.globalAlpha = 0.20;
                ctx.fill();
                ctx.strokeStyle = group.color;
                ctx.globalAlpha = 0.85;
                ctx.lineWidth = 1.4;
                ctx.stroke();
            }
        }

        ctx.globalAlpha = 1.0;
        ctx.globalCompositeOperation = "source-over";

        wave.prevMaxY = maxY;
        if (maxY < 1.5 && timeSec - spawnAt > 0.4)
            spawn();
    }

    property real prevMaxY: 0

    Canvas {
        id: canvas
        anchors.fill: parent
        renderStrategy: Canvas.Cooperative
        onPaint: wave.paint(canvas.getContext("2d"))
    }

    FrameAnimation {
        running: wave.visible
        onTriggered: {
            const dt = Math.min(frameTime, 60) / 1000;
            wave.timeSec += dt;
            wave.advance(dt);
            canvas.requestPaint();
        }
    }
}
