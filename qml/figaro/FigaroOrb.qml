import QtQuick
import Quickshell

// The assistant's face: one soft ball of light plus a single level ring.
//
// Drawn on a QML Canvas instead of a ShaderEffect or RadialGradient items.
// Two reasons: this machine runs a 27B local model that occupies almost all of
// the 16 GB of VRAM, so a GL context can fail to allocate and Qt then renders
// the surface broken (a dark seam across the screen); and Qt 6.10 does not
// expose RadialGradient as a QML type, only as an enum value. Canvas paints
// with the software backend and gives full control over the falloff.
Item {
    id: orb

    property string state: "idle"
    property real level: 0
    property real diameter: 168

    readonly property bool listening: state === "listening"
    readonly property bool thinking: state === "thinking"
    readonly property bool speaking: state === "speaking"

    // Envelope: fast attack, slow release, so the ball follows a voice without
    // behaving like a VU meter.
    property real env: 0
    property real t: 0

    implicitWidth: diameter
    implicitHeight: diameter

    readonly property color baseColor: thinking ? "#3a2a86" : speaking ? "#4a2a94" : "#33307e"
    readonly property color bodyColor: thinking ? "#7a5cf0" : speaking ? "#8f5cf0" : "#6b5cf0"

    // Slow breathing while thinking: a readable "I am working" cue that does
    // not pull the eye away from whatever the person is doing.
    property real breath: 0
    SequentialAnimation on breath {
        running: orb.thinking
        loops: Animation.Infinite
        NumberAnimation {
            from: 0
            to: 1
            duration: 1700
            easing.type: Easing.InOutSine
        }
        NumberAnimation {
            from: 1
            to: 0
            duration: 1700
            easing.type: Easing.InOutSine
        }
    }

    function withAlpha(c, a) {
        return "rgba(" + Math.round(c.r * 255) + "," + Math.round(c.g * 255) + "," + Math.round(c.b * 255) + "," + a.toFixed(3) + ")";
    }

    function paint(ctx) {
        const w = width;
        const h = height;
        const cx = w / 2;
        const cy = h / 2;
        const scale = orb.thinking ? 1 + orb.breath * 0.02 : 1;
        const r = w * 0.34 * scale;
        const level = orb.env;

        ctx.reset();
        ctx.clearRect(0, 0, w, h);

        const body = orb.bodyColor;
        const base = orb.baseColor;

        // 1. Ambient glow.
        let g = ctx.createRadialGradient(cx, cy, r * 0.35, cx, cy, r * 1.9);
        g.addColorStop(0.0, orb.withAlpha(body, 0.22 + level * 0.20));
        g.addColorStop(0.45, orb.withAlpha(body, 0.08 + level * 0.08));
        g.addColorStop(1.0, orb.withAlpha(body, 0.0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 1.9, 0, Math.PI * 2);
        ctx.fill();

        // 2. The sphere: light in the middle, darker towards the rim.
        g = ctx.createRadialGradient(cx - r * 0.10, cy - r * 0.14, r * 0.06, cx, cy, r);
        g.addColorStop(0.0, orb.withAlpha(orb.bodyColor, 1.0));
        g.addColorStop(0.45, orb.withAlpha(body, 0.98));
        g.addColorStop(0.86, orb.withAlpha(base, 0.96));
        g.addColorStop(1.0, orb.withAlpha(base, 0.0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();

        // 3. One drifting highlight. This is what keeps the ball from reading
        // as a flat disc, and it is the only element that moves on its own.
        const angle = orb.t * (orb.thinking ? 0.0011 : 0.0007);
        const hx = cx + Math.cos(angle) * r * 0.30;
        const hy = cy + Math.sin(angle) * r * 0.30 - r * 0.18;
        g = ctx.createRadialGradient(hx, hy, 0, hx, hy, r * 0.62);
        g.addColorStop(0.0, orb.withAlpha(Qt.rgba(1, 1, 1, 1), 0.26 + level * 0.20));
        g.addColorStop(0.55, orb.withAlpha(Qt.rgba(0.86, 0.9, 1.0, 1), 0.08));
        g.addColorStop(1.0, orb.withAlpha(Qt.rgba(0.86, 0.9, 1.0, 1), 0.0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.96, 0, Math.PI * 2);
        ctx.fill();

        // 4. Cold spark at the core: the sphere's own light source.
        g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.36);
        g.addColorStop(0.0, "rgba(190,235,255," + (0.42 + level * 0.30).toFixed(3) + ")");
        g.addColorStop(1.0, "rgba(190,235,255,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.36, 0, Math.PI * 2);
        ctx.fill();

        // 5. Level ring while listening: one ring, one job.
        if (orb.listening) {
            ctx.strokeStyle = "rgba(166,190,255," + (0.18 + level * 0.55).toFixed(3) + ")";
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.arc(cx, cy, r * (1.06 + level * 0.10), 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    Canvas {
        id: canvas
        anchors.fill: parent
        renderStrategy: Canvas.Cooperative
        onPaint: orb.paint(canvas.getContext("2d"))
    }

    FrameAnimation {
        id: frame
        running: orb.visible && orb.state !== "idle"
        onTriggered: {
            const dt = Math.min(frame.frameTime, 50) / 1000;
            const target = orb.state === "idle" ? 0 : orb.level;
            const rate = target > orb.env ? 15 : 5.0;
            orb.env += (target - orb.env) * (1 - Math.exp(-dt * rate));
            orb.t += frame.frameTime;
            canvas.requestPaint();
        }
    }
}
