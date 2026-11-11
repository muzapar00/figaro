pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io
import "i18n/en.js" as EnCatalog
import "i18n/zh-TW.js" as TwCatalog

// Lightweight, bundled i18n for the settings window. The keys are the zh-CN
// source strings themselves (gettext style): QML calls I18n.t("唤醒") and the
// lookup returns the zh-TW / en string when one is bundled, else the source.
//
// The language is picked once from the system locale and can be overridden in
// Appearance → Language; the override is persisted in
// ~/.config/figaro/settings-ui.json (the daemon config is never touched).
// Rooted in an Item (not QtObject) because the singleton owns FileView/Process
// children; it is never rendered.
Item {
    id: root

    visible: false
    width: 0
    height: 0

    readonly property var supported: ["zh-CN", "zh-TW", "en"]
    property string language: "zh-CN"
    property bool loaded: false

    readonly property string prefsPath: (Quickshell.env("HOME") || "") + "/.config/figaro/settings-ui.json"
    readonly property bool isEnglish: root.language === "en"
    readonly property bool isTraditional: root.language === "zh-TW"

    function detectLanguage() {
        const raw = [
            Quickshell.env("LC_ALL"),
            Quickshell.env("LC_MESSAGES"),
            Quickshell.env("LANG"),
            Quickshell.env("LANGUAGE"),
        ].filter((value) => value !== undefined && value !== null && value !== "").join(" ").toLowerCase();
        if (raw.length === 0) return "zh-CN";
        if (raw.indexOf("hant") >= 0 || /(^|[ _.\-])(zh|cmn)?[_-](tw|hk|mo)\b/.test(raw)) return "zh-TW";
        if (/(^|[ _.\-])en([ _.\-]|$)/.test(raw)) return "en";
        return "zh-CN";
    }

    function setLanguage(code) {
        if (root.supported.indexOf(code) < 0) return false;
        root.language = code;
        root.persistLanguage();
        return true;
    }

    function persistLanguage() {
        try {
            prefsWriter.exec([
                "/bin/sh", "-c",
                "mkdir -p \"$(dirname \"$1\")\" && printf '%s\\n' \"$2\" > \"$1\"",
                "sh", root.prefsPath, JSON.stringify({ language: root.language }),
            ]);
        } catch (err) {
            console.warn("[figaro-settings] could not persist language: " + err);
        }
    }

    // The translation entry point. Reading root.language here is what makes
    // every QML binding that calls t() re-evaluate when the language changes.
    function t(source) {
        const lang = root.language;
        if (lang === "zh-TW" && TwCatalog.map && TwCatalog.map[source] !== undefined) return TwCatalog.map[source];
        if (lang === "en" && EnCatalog.map && EnCatalog.map[source] !== undefined) return EnCatalog.map[source];
        return source;
    }

    // "3 of 5 steps" style formatting kept out of QML string concatenation.
    function t2(source, value) {
        const text = root.t(source);
        return String(text).replace("%1", String(value));
    }

    FileView {
        id: prefs
        path: root.prefsPath
        blockLoading: true
        printErrors: false
        onLoaded: {
            try {
                const data = JSON.parse(prefs.text() || "{}");
                if (root.supported.indexOf(data.language) >= 0) root.language = data.language;
            } catch (err) {
                // A corrupt prefs file just means "follow the system locale".
            }
            root.loaded = true;
        }
        onLoadFailed: root.loaded = true
    }

    Component.onCompleted: {
        root.language = root.detectLanguage();
        try {
            const data = JSON.parse(prefs.text() || "{}");
            if (root.supported.indexOf(data.language) >= 0) root.language = data.language;
        } catch (err) {
            /* no saved preference */
        }
        root.loaded = true;
    }

    property Process prefsWriter: writer

    Process {
        id: writer
        running: false
    }
}
