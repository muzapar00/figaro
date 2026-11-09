# Third-party notices

Figaro reuses the following third-party work.

## siriwave — Siri waveform algorithm

- Source: https://github.com/vitaly-z/siriwave
- File ported: `src/ios9-curve.ts`
- Port: `qml/figaro/SiriWave.qml` (reimplemented for QML Canvas, colours changed)
- License: MIT

```
MIT License

Copyright (c) 2020 Flavio Maria De Stefano

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Apple Intelligence animation (visual reference only)

- Source: https://github.com/TopScrech/Apple-Intelligence-Animation
- Used as a reference for the iOS 18 Siri glow/ripple behaviour behind
  `qml/figaro/shaders/figaro_orb.frag`; no code copied (the original is Swift +
  Metal).
