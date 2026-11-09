#!/usr/bin/env python3
"""Generate Figaro's UI sound effects.

Pure Python standard library (numpy is not installed on this machine). Run from
anywhere:

    python3 assets/sfx/generate.py

Output: five 32 kHz / mono / 16-bit WAV files next to this script.

Design goals (measured levels and the "why" are in README.md):
  * short: 65-200 ms, nothing that loops or drones
  * no piercing highs: fundamentals <= 1.3 kHz, harmonics rolled off hard, so
    there is essentially no energy above ~2.5 kHz
  * "does not fight the voice":
      - sounds that can overlap Figaro speaking (listen-start) sit ABOVE the
        male-voice main band (~150-900 Hz)
      - sounds that only play after/cancelling speech (answer-done, dismiss,
        error) may use a warmer, lower register
  * low level: rendered peaks around -15..-18 dBFS. With the default
    sfx.volume = 0.35 the effective loudness is ~4-7 dB below Figaro's voice
    (TTS measures -25.5 LUFS, the sounds -30..-32 LUFS) — clearly audible when
    nothing else plays, never fighting the voice when it does
  * click-free: raised-cosine attack + exponential decay + smooth fade-out

The waveforms are deterministic, so the committed WAVs can be regenerated
instead of being binary blobs of unknown origin.
"""

import math
import os
import struct
import wave

SR = 32000
OUT_DIR = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------- synthesis --
def envelope(n, attack_ms=7.0, release_ms=18.0, decay=3.0):
    """Raised-cosine attack, exponential decay, raised-cosine fade-out."""
    attack = max(1, int(SR * attack_ms / 1000))
    release = max(1, min(int(SR * release_ms / 1000), max(1, n // 2)))
    out = []
    for i in range(n):
        if i < attack:
            gain = 0.5 - 0.5 * math.cos(math.pi * i / attack)
        else:
            gain = 1.0
        gain *= math.exp(-decay * (i / SR))
        remaining = n - i
        if remaining <= release:
            gain *= 0.5 - 0.5 * math.cos(math.pi * remaining / release)
        out.append(gain)
    return out


def tone(n, f_start, f_end, harmonics=(1.0,), attack_ms=7.0, decay=3.0):
    """Glide from f_start to f_end; `harmonics` amplitudes for k=1,2,3..."""
    envl = envelope(n, attack_ms=attack_ms, release_ms=min(20.0, 500.0 * n / SR), decay=decay)
    harm_sum = sum(harmonics)
    out = []
    phase = 0.0
    for i in range(n):
        frac = i / max(1, n - 1)
        freq = f_start + (f_end - f_start) * frac
        phase += 2.0 * math.pi * freq / SR
        sample = 0.0
        for k, amp in enumerate(harmonics, start=1):
            sample += amp * math.sin(k * phase)
        out.append(envl[i] * sample / harm_sum)
    return out


def note(duration_ms, freq, harmonics=(1.0,), attack_ms=7.0, decay=3.0):
    n = int(SR * duration_ms / 1000)
    return tone(n, freq, freq, harmonics=harmonics, attack_ms=attack_ms, decay=decay)


def glide(duration_ms, f_start, f_end, harmonics=(1.0,), attack_ms=7.0, decay=3.0):
    n = int(SR * duration_ms / 1000)
    return tone(n, f_start, f_end, harmonics=harmonics, attack_ms=attack_ms, decay=decay)


def silence(duration_ms):
    return [0.0] * int(SR * duration_ms / 1000)


def save(name, samples, peak_dbfs):
    """Normalise to `peak_dbfs` and write a 32 kHz mono 16-bit PCM WAV."""
    peak = max(abs(x) for x in samples) or 1.0
    scale = (10.0 ** (peak_dbfs / 20.0)) / peak
    payload = bytearray()
    for x in samples:
        value = int(round(max(-1.0, min(1.0, x * scale)) * 32767.0))
        payload += struct.pack('<h', value)
    path = os.path.join(OUT_DIR, name)
    with wave.open(path, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SR)
        wav.writeframes(bytes(payload))
    duration_ms = len(samples) / SR * 1000.0
    return path, duration_ms


# -------------------------------------------------------------------- sounds --
SOUNDS = [
    # 1) listen-start: 80 ms rising "blip" — the soft "boop" right as capture
    #    opens. Above the male-voice band so it does not mask the wake ack.
    (
        'listen-start.wav',
        glide(80, 920.0, 1270.0, (1.0, 0.18), attack_ms=6.0, decay=4.2),
        -15.0,
    ),
    # 2) listen-end: 65 ms very light falling tick (end of capture), quieter.
    (
        'listen-end.wav',
        glide(65, 1150.0, 900.0, (1.0, 0.10), attack_ms=6.0, decay=5.0),
        -17.5,
    ),
    # 3) answer-done: 155 ms soft two-note resolve G4 -> C5. Plays only after the
    #    reply has finished, so the warmer low register is safe.
    (
        'answer-done.wav',
        note(70, 392.00, (1.0, 0.26, 0.10), attack_ms=6.0, decay=2.0)
        + note(85, 523.25, (1.0, 0.22, 0.08), attack_ms=5.0, decay=2.6),
        -15.0,
    ),
    # 4) dismiss: 200 ms gentle downward glide, "standing down".
    (
        'dismiss.wav',
        glide(200, 720.0, 330.0, (1.0, 0.20), attack_ms=8.0, decay=1.8),
        -15.5,
    ),
    # 5) error: 180 ms two soft low pulses G4 -> F4 — a "hmm", not an alarm.
    (
        'error.wav',
        note(85, 392.00, (1.0, 0.18), attack_ms=7.0, decay=2.2)
        + silence(18)
        + note(78, 349.23, (1.0, 0.16), attack_ms=6.0, decay=2.4),
        -16.5,
    ),
]


def main():
    total_size = 0
    for name, samples, peak_dbfs in SOUNDS:
        path, duration_ms = save(name, samples, peak_dbfs)
        size = os.path.getsize(path)
        total_size += size
        print(f'{name:18s} {duration_ms:6.1f} ms  {size:6d} B  rendered peak {peak_dbfs:6.1f} dBFS')
    print(f'{"total":18s} {"":6s}     {total_size:6d} B')


if __name__ == '__main__':
    main()
