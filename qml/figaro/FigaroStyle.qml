pragma Singleton

import QtQuick
import Quickshell

// Shared motion and colour language for the overlay.
//
// The ball and the caption are one component with two parts, so they have to
// agree on three things: the same palette (the caption tint follows the ball's
// state colour), the same springs (they enter and settle together), and the
// same timing (they never look like two widgets animating independently).
Singleton {
    id: style

    // One colour per state: listening is blue, thinking violet, speaking
    // magenta. The ball interpolates between these; the caption uses the
    // dominant one.
    readonly property color listenColor: "#4a7dff"
    readonly property color thinkColor: "#8b5cf6"
    readonly property color speakColor: "#d75cff"

    // Springs. The pair (stiffness, damping) is shared by every moving element
    // in the overlay so the whole thing moves as one object.
    readonly property real springStiffness: 260
    readonly property real springDamping: 14

    // Qt spring units for the QML SpringAnimation used by the window entry.
    readonly property real appearSpring: 4.4
    readonly property real appearDamping: 0.52
    readonly property int fadeMs: 180
    readonly property int crossfadeMs: 180
    readonly property int captionSpringMs: 260

    function kindFor(state) {
        if (state === "listening") return "listen";
        if (state === "thinking") return "think";
        if (state === "speaking") return "speak";
        return "idle";
    }

    function colorFor(state) {
        if (state === "listening") return style.listenColor;
        if (state === "thinking") return style.thinkColor;
        if (state === "speaking") return style.speakColor;
        return "#6b5cf0";
    }
}
