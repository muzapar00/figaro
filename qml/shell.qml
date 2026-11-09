import Quickshell
import qs.figaro

// Standalone Quickshell configuration: `qs -c figaro`.
// Deliberately independent from the KOS shell so Figaro can be started,
// stopped or restarted without touching the desktop.
ShellRoot {
    FigaroOverlay {}
}
