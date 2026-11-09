import QtQuick
import Kos.SurfaceShape 1.0

// The KWin liquid-glass declaration for the pill, isolated in its own file.
//
// Kos.SurfaceShape is part of the KOS desktop (a native plugin on QML2_IMPORT_PATH),
// not of Quickshell or Qt. A hard `import` in the capsule would make the whole
// overlay fail to load on any machine without KOS - which is exactly what happens
// on plain Plasma or another Wayland compositor. The capsule therefore loads this
// file through a Loader: when the plugin is missing the Loader reports an error,
// the declaration simply does not exist, and the capsule still draws its own
// translucent background.
Item {
    id: glass

    property Item pill: null       // the pill item whose shape is declared
    property real pillHeight: 0    // its height, for the capsule radius
    property real progress: 0      // 0 = ball, 1 = open pill

    visible: false
    width: 0
    height: 0

    SurfaceShape {
        target: glass.progress > 0.02 ? glass.pill : null
        blurSigma: 26
        effectType: SurfaceShape.Liquid
        material: SurfaceShape.Regular
        tintMode: SurfaceShape.Fixed
        tintColor: "black"
        tintOpacity: 0.46
        radius: glass.pillHeight / 2
        exponent: 2.0
        enabled: glass.progress > 0.02
    }
}
