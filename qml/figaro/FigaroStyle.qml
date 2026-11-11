pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io

// Shared motion and colour language for the overlay.
//
// The rules come from Apple's Human Interface Guidelines, "Motion"
// (developer.apple.com/design/human-interface-guidelines/motion):
//
//  1. "Add motion purposefully, supporting the experience without overshadowing
//     it." One primary motion per state; ornament that does not carry meaning is
//     removed (no orbiting dots, no idle shimmer).
//  2. "Make motion optional." `reduceMotion` follows the desktop's own animation
//     setting (KDE AnimationDurationFactor = 0 disables it, like Reduce Motion):
//     geometry becomes instant and only short cross-fades remain. The assistant
//     is still fully usable because every state is also conveyed by colour and
//     by its audio.
//  3. "Strive for realistic feedback motion that follows people's gestures."
//     The ball is driven by the actual microphone/TTS level through a
//     spring-damper, and the ball becomes a pill along the same path it would
//     travel, rather than teleporting.
//  4. "Aim for brevity and precision." Text never bounces (its move is a plain
//     ease-out), only the object the user is not reading overshoots.
//  5. "Avoid adding motion to interactions that occur frequently." Nothing here
//     runs while idle, and the overlay does not animate when hidden.
//  6. "Let people cancel motion." Any animation can be interrupted by tap, short
//     hotkey press or a cancel phrase; cancelling deflates instead of snapping.
Singleton {
    id: style

    // ---- compositor capabilities ------------------------------------------
    // Quickshell is Wayland-only and shows the overlay through wlr-layer-shell:
    // KDE (KWin), sway/Hyprland and other wlroots compositors provide it,
    // GNOME's Mutter does not. KOS's liquid glass is a KDE-only native plugin, so
    // every other desktop skips the probe and uses FigaroCapsule's own
    // translucent fill (docs/platform-support.md has the full matrix).
    readonly property string desktopName: String(Quickshell.env("XDG_CURRENT_DESKTOP") || "")
    readonly property string sessionType: String(Quickshell.env("XDG_SESSION_TYPE") || "")
    readonly property bool kdeDesktop: /(^|[:;])(KDE|Plasma)/i.test(desktopName)
        || /^(1|true)$/i.test(String(Quickshell.env("KDE_FULL_SESSION") || ""))
    readonly property bool waylandSession: sessionType === "wayland"
        || String(Quickshell.env("WAYLAND_DISPLAY") || "").length > 0
    // KOS (KWin compositor glass) only exists on KDE; elsewhere the Loader is not
    // created at all, so a missing plugin does not log an error on every start.
    readonly property bool useCompositorGlass: kdeDesktop && waylandSession

    // ---- palette -----------------------------------------------------------
    readonly property color listenColor: "#4a7dff"
    readonly property color thinkColor: "#8b5cf6"
    readonly property color speakColor: "#d75cff"

    // ---- springs (one family, shared by every moving element) --------------
    readonly property real springStiffness: 260
    readonly property real springDamping: 14

    // Qt spring units for QML SpringAnimation (shape/position changes).
    readonly property real shapeSpring: 3.2
    readonly property real shapeDamping: 0.46
    readonly property real appearSpring: 4.4
    readonly property real appearDamping: 0.52

    // ---- timing (brief, so nothing makes people wait) ----------------------
    readonly property int fadeMs: 180
    readonly property int crossfadeMs: 180
    readonly property int exitMs: 170
    // Text must never bounce; it is being read.
    readonly property int textSlideMs: 120
    readonly property int textFadeMs: 90
    // Acknowledge/cancel feedback: short enough to feel like a reflex.
    readonly property int popMs: 130

    // ---- accessibility -----------------------------------------------------
    // true when the desktop asks for reduced motion. KDE stores 0 in
    // AnimationDurationFactor when animations are disabled.
    property bool reduceMotion: true

    Process {
        running: true
        command: ["sh", "-c", "kreadconfig6 --file kdeglobals --group KDE --key AnimationDurationFactor 2>/dev/null || true"]
        stdout: StdioCollector {
            onStreamFinished: {
                const v = String(text || "").trim();
                // empty or "1"/"1.2" means animations on; "0" means off.
                style.reduceMotion = (v === "0");
            }
        }
    }

    function kindFor(state) {
        if (state === "listening") return "listen";
        if (state === "thinking") return "think";
        if (state === "speaking") return "speak";
        return "idle";
    }

    function colorFor(state) {
        if (state === "listening") return style.listenColor;
        // The waiting window means "still here, ready for you": reuse the
        // listening blue so the state reads without a new colour.
        if (state === "waiting") return style.listenColor;
        if (state === "thinking") return style.thinkColor;
        if (state === "speaking") return style.speakColor;
        return "#6b5cf0";
    }

    // Repaint budget per state: audio-reactive states need 60 fps, the slow
    // thinking motion does not. This keeps the overlay cheap while it is on
    // screen (Apple: 30-60 fps is enough for smooth motion).
    function frameIntervalFor(state) {
        // Measured on this machine with the overlay back on the GPU: 30 fps costs
        // 18% of one core while speaking, versus 35% when the overlay rasterised
        // on the CPU. 60 fps costs 120% (the timer outruns the canvas raster), so
        // 30 fps is the sweet spot: same smoothness as before at half the CPU.
        // Thinking is a slow rotation (20 fps), reduced motion is calmer still.
        if (style.reduceMotion) return 50;
        if (state === "thinking") return 50;
        return 33;
    }
}
