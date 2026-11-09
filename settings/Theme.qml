pragma Singleton

import QtQuick

// macOS-dark look for the Figaro settings panel.
// Single source of truth for colors / metrics so every page stays consistent.
QtObject {
    id: theme

    // macOS uses SF Pro. Inter is the closest locally installed sans; Qt falls
    // back to Noto Sans CJK for the Chinese glyphs automatically.
    readonly property string fontSans: "Inter"
    readonly property string fontCJK: "Noto Sans CJK SC"

    // macOS dark-mode system colors (Appearance > Dark).
    readonly property color windowBg: "#1c1c1e"
    readonly property color contentBg: "#1e1e22"
    readonly property color sidebarBg: "#26262b"
    readonly property color cardBg: "#2c2c31"
    readonly property color cardBgAlt: "#303036"
    readonly property color insetBg: "#1a1a1d"
    readonly property color separator: "#3d3d45"
    readonly property color text: "#f5f5f7"
    readonly property color textDim: "#a8a8b0"
    readonly property color textFaint: "#73737c"
    readonly property color accent: "#0a84ff"
    readonly property color green: "#30d158"
    readonly property color red: "#ff453a"
    readonly property color yellow: "#ffd60a"
    readonly property color orange: "#ff9f0a"
    readonly property color controlBg: "#3a3a42"
    readonly property color controlBgHover: "#47474f"
    readonly property color controlBgActive: "#55555e"
    readonly property color toggleOff: "#48484f"

    // Metrics picked from macOS System Settings (row 44, controls 28, cards 12r).
    readonly property int radiusCard: 12
    readonly property int radiusControl: 7
    readonly property int controlH: 28
    readonly property int rowH: 46
    readonly property int pad: 16
    readonly property int padOuter: 20
    readonly property int sidebarW: 212
    readonly property int titleBarH: 40
    readonly property int fs: 13
    readonly property int fsSmall: 11
    readonly property int fsTiny: 10
    readonly property int fsTitle: 22
    readonly property int fsSection: 10
    readonly property int windowW: 900
    readonly property int windowH: 640

    function qsColor(c) {
        return c;
    }
}
