// KWin helper script: the settings window draws its own macOS title bar, so the
// compositor's server-side decoration must be hidden. Loaded at GUI start by
// shell.qml through `qdbus6 org.kde.KWin /Scripting ... loadScript`; it only
// touches the window whose caption is exactly this title.
//
// Loaded as a runtime KWin script (never installed into ~/.local/share/kwin),
// so nothing persists after KWin restarts and no user config is modified.
const TITLE = "费加罗设置";

function strip(window) {
    if (!window) return;
    if (window.caption === TITLE && !window.noBorder) {
        window.noBorder = true;
        print("[figaro-settings] undecorated: " + window.caption);
    }
}

function scan() {
    const list = workspace.windowList ? workspace.windowList() : workspace.clientList();
    for (let i = 0; i < list.length; i++) strip(list[i]);
}

scan();
if (workspace.windowAdded) workspace.windowAdded.connect(function(window) { strip(window); });
print("[figaro-settings] decoration-strip script active");
