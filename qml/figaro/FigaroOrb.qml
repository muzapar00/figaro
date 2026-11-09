import QtQuick
import Quickshell
import qs.figaro

// The assistant's face, drawn on a Canvas (software renderer friendly).
//
// The three states are meant to be readable without a label, and the ball
// itself has to feel alive rather than be a static sprite:
//
//   listening - the microphone drives an elastic envelope: the sphere swells
//               and springs back, a wavy rim and a tick halo follow the voice
//   thinking  - bright comet arcs rotate *inside* the sphere plus a ring of
//               orbiting dots outside, so "working" is visible even in silence
//   speaking  - the same elastic envelope, driven by the TTS level, emits pulse
//               rings on each syllable onset: output, not input
//
// Envelope is a real spring-damper (position + velocity), not an exponential
// smoothing, which is what makes it overshoot and settle like a physical body.
Item {
    id: orb

    property string state: "idle"
    property real level: 0
    property real diameter: 128

    readonly property bool listening: state === "listening"
    readonly property bool thinking: state === "thinking"
    readonly property bool speaking: state === "speaking"
    // Waiting after a reply: still on screen, still listening for a loud voice,
    // but deliberately still, so it does not look busy.
    readonly property bool waiting: state === "waiting"

    // Spring state for the audio envelope.
    property real env: 0
    property real envVel: 0
    property real t: 0

    property real listenMix: listening ? 1 : 0
    property real thinkMix: thinking ? 1 : 0
    property real speakMix: speaking ? 1 : 0
    Behavior on listenMix { NumberAnimation { duration: 180; easing.type: Easing.OutCubic } }
    Behavior on thinkMix { NumberAnimation { duration: 180; easing.type: Easing.OutCubic } }
    Behavior on speakMix { NumberAnimation { duration: 180; easing.type: Easing.OutCubic } }

    readonly property real ballRadius: diameter / 2
    readonly property real haloPadding: (implicitWidth - diameter) / 2
    implicitWidth: diameter * 1.9
    implicitHeight: diameter * 1.9

    property var pulses: []

    // Apple: "Make motion optional" and "let people cancel motion". When the
    // desktop asks for reduced motion, the ornaments disappear and only colour
    // plus a plain fade remain - the state is still readable because the colour
    // and the audio carry the meaning.
    readonly property bool reduce: FigaroStyle.reduceMotion

    // A short acknowledge bump when the assistant starts answering a wake.
    // One 130 ms pop, tied to the ack - reflexive, not decorative.
    property real pop: 0

    property real breath: 0
    SequentialAnimation on breath {
        running: orb.thinking && !orb.reduce
        loops: Animation.Infinite
        NumberAnimation { from: 0; to: 1; duration: 1700; easing.type: Easing.InOutSine }
        NumberAnimation { from: 1; to: 0; duration: 1700; easing.type: Easing.InOutSine }
    }

    function rgba(r, g, b, a) {
        return "rgba(" + Math.round(r * 255) + "," + Math.round(g * 255) + "," + Math.round(b * 255) + "," + Math.max(0, Math.min(1, a)).toFixed(3) + ")";
    }

    function bodyColor() {
        const l = orb.listenMix;
        const th = orb.thinkMix;
        const sp = orb.speakMix;
        const sum = Math.max(0.001, l + th + sp);
        if (orb.waiting) {
            const wc = FigaroStyle.listenColor;
            return { r: wc.r, g: wc.g, b: wc.b };
        }
        return {
            r: (0.28 * l + 0.56 * th + 0.86 * sp) / sum,
            g: (0.52 * l + 0.34 * th + 0.34 * sp) / sum,
            b: (1.00 * l + 0.94 * th + 0.98 * sp) / sum,
        };
    }

    // A closed, wobbling circle. The wobble is driven by the (elastic) level,
    // so the silhouette breathes with the voice instead of staying a perfect
    // circle. Three harmonics keep the motion from looking like a sine wave.
    function blobPath(ctx, cx, cy, r, amp, t) {
        const N = 72;
        ctx.beginPath();
        for (let i = 0; i <= N; i++) {
            const a = (i / N) * Math.PI * 2;
            const wob = 1.0
                + amp * (0.055 * Math.sin(3 * a + t * 1.7)
                       + 0.035 * Math.sin(5 * a - t * 2.3)
                       + 0.028 * Math.sin(2 * a + t * 0.9));
            const rr = r * wob;
            const x = cx + Math.cos(a) * rr;
            const y = cy + Math.sin(a) * rr;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.closePath();
    }

    function paint(ctx) {
        const w = width;
        const h = height;
        const cx = w / 2;
        const cy = h / 2;
        const env = orb.env;
        const t = orb.t;
        const body = orb.bodyColor();

        // The ball breathes with the voice: elastic swell, springy settle.
        const scale = (1 + env * (orb.reduce ? 0.03 : 0.10)) * (1 + orb.breath * 0.02) * (1 + orb.pop * 0.06);
        const r = orb.ballRadius * scale;
        // Capped on purpose: the silhouette should breathe, not turn into
        // an egg. The visible bounce comes from the scale, not from wobble.
        const amp = orb.reduce ? 0.0 : 0.12 + Math.min(0.30, env * 0.32);

        ctx.reset();
        ctx.clearRect(0, 0, w, h);

        // 1. Ambient glow. A stack of flat alpha circles costs a fraction of a
        // large radial gradient on the software rasteriser (the halo covers
        // ~10x the ball's area, and it is the single most expensive fill in the
        // frame). Eight steps are enough for a soft falloff at this size.
        const glowSteps = 12;
        for (let i = glowSteps; i >= 1; i--) {
            const f = i / glowSteps;
            const a = (0.20 + env * 0.26) * Math.pow(1 - f, 1.7);
            if (a < 0.004) continue;
            ctx.fillStyle = orb.rgba(body.r, body.g, body.b, a);
            ctx.beginPath();
            ctx.arc(cx, cy, r * (0.9 + (1.85 - 0.9) * f), 0, Math.PI * 2);
            ctx.fill();
        }

        // 2. The sphere itself, deformed by the current level.
        let g;
        g = ctx.createRadialGradient(cx - r * 0.10, cy - r * 0.14, r * 0.06, cx, cy, r * 1.02);
        g.addColorStop(0.0, orb.rgba(Math.min(1, body.r + 0.25), Math.min(1, body.g + 0.25), body.b, 1.0));
        g.addColorStop(0.45, orb.rgba(body.r, body.g, body.b, 0.98));
        g.addColorStop(0.86, orb.rgba(body.r * 0.5, body.g * 0.45, body.b * 0.75, 0.96));
        g.addColorStop(1.0, orb.rgba(body.r * 0.4, body.g * 0.35, body.b * 0.6, 0.0));
        ctx.fillStyle = g;
        orb.blobPath(ctx, cx, cy, r, amp, t * 0.001);
        ctx.fill();

        // 3. THINKING: comet arcs rotating inside the sphere. Clipped to the
        // ball so the rotation reads as something spinning under the surface.
        if (orb.thinkMix > 0.01) {
            const m = orb.thinkMix;
            ctx.save();
            orb.blobPath(ctx, cx, cy, r * 0.995, amp, t * 0.001);
            ctx.clip();
            ctx.lineCap = "round";

            const spin = orb.reduce ? 0.6 : t * 0.001;
            ctx.lineWidth = r * 0.26;
            ctx.strokeStyle = orb.rgba(0.92, 0.88, 1.0, 0.22 * m);
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.62, spin * 2.6, spin * 2.6 + Math.PI * 0.7);
            ctx.stroke();

            ctx.lineWidth = r * 0.16;
            ctx.strokeStyle = orb.rgba(0.75, 0.95, 1.0, 0.30 * m);
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.86, -spin * 1.9 + Math.PI, -spin * 1.9 + Math.PI + Math.PI * 0.5);
            ctx.stroke();
            ctx.restore();
        }

        // 4. Single drifting highlight: keeps the ball from reading as a disc.
        const angle = t * (orb.thinking ? 0.0012 : 0.0007);
        const hx = cx + Math.cos(angle) * r * 0.30;
        const hy = cy + Math.sin(angle) * r * 0.30 - r * 0.18;
        g = ctx.createRadialGradient(hx, hy, 0, hx, hy, r * 0.62);
        g.addColorStop(0.0, orb.rgba(1, 1, 1, 0.22 + env * 0.18));
        g.addColorStop(0.55, orb.rgba(0.86, 0.9, 1.0, 0.07));
        g.addColorStop(1.0, orb.rgba(0.86, 0.9, 1.0, 0.0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.96, 0, Math.PI * 2);
        ctx.fill();

        // 5. LISTENING: wavy rim + level ticks that spring with the voice.
        if (orb.listenMix > 0.01) {
            const m = orb.listenMix;
            ctx.strokeStyle = orb.rgba(0.66, 0.84, 1.0, (0.22 + env * 0.55) * m);
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            const N = 72;
            for (let i = 0; i <= N; i++) {
                const a = (i / N) * Math.PI * 2;
                const wob = 1 + (0.05 + env * 0.18) * Math.sin(4 * a + t * 0.0022);
                const rr = r * 1.16 * wob;
                const x = cx + Math.cos(a) * rr;
                const y = cy + Math.sin(a) * rr;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();

            const ticks = orb.reduce ? 0 : 24;
            ctx.lineCap = "round";
            ctx.lineWidth = 2.2;
            for (let i = 0; i < ticks; i++) {
                const a = (i / ticks) * Math.PI * 2 + t * 0.00010;
                const wobble = 0.35 + 0.65 * Math.abs(Math.sin(i * 2.1 + t * 0.0018));
                const v = Math.min(1, env) * wobble;
                const inner = r * 1.24;
                const outer = inner + r * (0.03 + 0.26 * v);
                ctx.strokeStyle = orb.rgba(0.76, 0.88, 1.0, (0.12 + 0.85 * v) * m);
                ctx.beginPath();
                ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
                ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
                ctx.stroke();
            }
        }

        // 7. SPEAKING: pulse rings on syllable onsets + level halo.
        if (orb.speakMix > 0.01) {
            const m = orb.speakMix;
            for (const p of orb.pulses) {
                const life = Math.min(1, p.age / 0.85);
                ctx.strokeStyle = orb.rgba(body.r, body.g, body.b, (1 - life) * 0.85 * m);
                ctx.lineWidth = 2.8;
                ctx.beginPath();
                ctx.arc(cx, cy, r * (1.08 + life * 0.70), 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.strokeStyle = orb.rgba(0.94, 0.72, 1.0, (0.16 + env * 0.55) * m);
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(cx, cy, r * (1.06 + env * 0.10), 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    Connections {
        target: orb
        function onStateChanged() {
            if (orb.state === "waking" && !orb.reduce) {
                popAnim.restart();
            }
        }
    }

    SequentialAnimation {
        id: popAnim
        NumberAnimation { target: orb; property: "pop"; to: 1; duration: FigaroStyle.popMs; easing.type: Easing.OutCubic }
        NumberAnimation { target: orb; property: "pop"; to: 0; duration: FigaroStyle.popMs * 1.6; easing.type: Easing.OutCubic }
    }

    Canvas {
        id: canvas
        anchors.fill: parent
        // Immediate: with the software backend a cooperative canvas can be
        // starved when the scene graph has no other reason to redraw.
        renderStrategy: Canvas.Immediate
        onPaint: orb.paint(canvas.getContext("2d"))
    }

    Timer {
        id: frame
        // 30 fps is enough for the slow thinking motion; audio-reactive states
        // get the full 60.
        interval: FigaroStyle.frameIntervalFor(orb.state)
        repeat: true
        running: orb.visible && orb.state !== "idle"
        onTriggered: {
            const dtMs = 16;
            const dt = dtMs / 1000;
            orb.t += dtMs;

            // Spring-damper envelope: this is what makes the ball bounce
            // instead of simply following the meter.
            const target = (orb.state === "idle" || orb.waiting) ? 0 : Math.min(1, orb.level);
            const stiffness = FigaroStyle.springStiffness;
            const damping = FigaroStyle.springDamping;
            const accel = stiffness * (target - orb.env) - damping * orb.envVel;
            orb.envVel += accel * dt;
            orb.env += orb.envVel * dt;
            if (orb.env < 0) { orb.env = 0; orb.envVel = 0; }

            // A pulse on each syllable onset while speaking.
            if (!orb.reduce && orb.speakMix > 0.5 && orb.envVel > 0.9 && orb.env > 0.15) {
                const next = orb.pulses.slice();
                next.push({ age: 0 });
                orb.pulses = next.slice(-3);
            }
            if (orb.pulses.length) {
                const aged = [];
                for (const p of orb.pulses) {
                    p.age += dt;
                    if (p.age < 0.95) aged.push(p);
                }
                orb.pulses = aged;
            }
            canvas.requestPaint();
        }
    }
}
