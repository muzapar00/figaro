#!/usr/bin/env python3
"""Measure the generated UI sound effects (stdlib only).

    python3 assets/sfx/measure.py [--volume 0.35]

Reports, per WAV:
  duration, file size, peak dBFS, RMS dBFS, true peak (ffmpeg ebur128),
  K-weighted loudness (LUFS, whole-file ungated — ITU-R BS.1770 K-weighting
  without gating; short one-shots are exactly where gated integrated loudness is
  meaningless, ebur128 reports -70.0 for everything shorter than 400 ms),
  effective level at the default sfx volume, spectral centroid and the fraction
  of energy above 2 kHz / 4 kHz (the "no piercing highs" check).
"""

import math
import os
import struct
import subprocess
import sys
import wave

SR = 32000
DIR = os.path.dirname(os.path.abspath(__file__))
FILES = [
    'listen-start.wav',
    'listen-end.wav',
    'answer-done.wav',
    'dismiss.wav',
    'error.wav',
]


def read_wav(path):
    with wave.open(path, 'rb') as wav:
        assert wav.getnchannels() == 1, 'mono only'
        assert wav.getsampwidth() == 2, '16-bit only'
        assert wav.getframerate() == SR, '32 kHz only'
        frames = wav.readframes(wav.getnframes())
    return [struct.unpack('<h', frames[i:i + 2])[0] / 32768.0 for i in range(0, len(frames), 2)]


def db(value):
    return 20.0 * math.log10(value) if value > 0 else -200.0


# --- ITU-R BS.1770 K-weighting (high shelf + high pass), designed for SR ------
def k_weighting_coeffs(fs=SR):
    # Stage 1: high shelf, +4 dB above 1681.974450955533 Hz, Q 0.7071752369554196
    gain_db = 4.0
    q1 = 0.7071752369554196
    fc1 = 1681.974450955533
    a = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * math.pi * fc1 / fs
    alpha = math.sin(w0) / (2.0 * q1)
    root = math.sqrt(a)
    cos_w0 = math.cos(w0)
    b = [
        a * ((a + 1.0) + (a - 1.0) * cos_w0 + 2.0 * root * alpha),
        -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0),
        a * ((a + 1.0) + (a - 1.0) * cos_w0 - 2.0 * root * alpha),
    ]
    den = [(a + 1.0) - (a - 1.0) * cos_w0 + 2.0 * root * alpha,
           2.0 * ((a - 1.0) - (a + 1.0) * cos_w0),
           (a + 1.0) - (a - 1.0) * cos_w0 - 2.0 * root * alpha]
    shelf = (b, den)
    # Stage 2: high pass, fc 38.13547087602444 Hz, Q 0.5003270373238773
    q2 = 0.5003270373238773
    fc2 = 38.13547087602444
    w0 = 2.0 * math.pi * fc2 / fs
    alpha = math.sin(w0) / (2.0 * q2)
    cos_w0 = math.cos(w0)
    hp_b = [(1.0 + cos_w0) / 2.0, -(1.0 + cos_w0), (1.0 + cos_w0) / 2.0]
    hp_den = [1.0 + alpha, -2.0 * cos_w0, 1.0 - alpha]
    return shelf, (hp_b, hp_den)


def biquad(samples, coeff):
    b, a = coeff
    # normalise a0 == 1
    b0, b1, b2 = [v / a[0] for v in b]
    a1, a2 = a[1] / a[0], a[2] / a[0]
    out = [0.0] * len(samples)
    x1 = x2 = y1 = y2 = 0.0
    for i, x0 in enumerate(samples):
        y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        out[i] = y0
        x2, x1 = x1, x0
        y2, y1 = y1, y0
    return out


def lufs_ungated(samples):
    shelf, hp = k_weighting_coeffs()
    weighted = biquad(biquad(samples, shelf), hp)
    mean_square = sum(v * v for v in weighted) / len(weighted)
    return -0.691 + 10.0 * math.log10(mean_square) if mean_square > 0 else -200.0


def highpass_rms_ratio(samples, cutoff_hz):
    """Fraction of energy (power) above cutoff, via a biquad high-pass."""
    w0 = 2.0 * math.pi * cutoff_hz / SR
    alpha = math.sin(w0) / (2.0 * 0.7071)
    cos_w0 = math.cos(w0)
    b = [(1.0 + cos_w0) / 2.0, -(1.0 + cos_w0), (1.0 + cos_w0) / 2.0]
    a = [1.0 + alpha, -2.0 * cos_w0, 1.0 - alpha]
    hp = biquad(samples, (b, a))
    total_power = sum(v * v for v in samples) or 1e-20
    hp_power = sum(v * v for v in hp)
    return hp_power / total_power


def spectral_centroid(samples):
    """Energy-weighted mean frequency of a 0-8 kHz Goertzel grid."""
    n = len(samples)
    if n == 0:
        return 0.0
    freqs = [125.0 * i for i in range(1, 65)]  # 125 Hz .. 8 kHz
    weighted_sum = 0.0
    total = 0.0
    for freq in freqs:
        coeff = 2.0 * math.cos(2.0 * math.pi * freq / SR)
        # Goertzel
        s_prev = s_prev2 = 0.0
        for sample in samples:
            s = sample + coeff * s_prev - s_prev2
            s_prev2 = s_prev
            s_prev = s
        power = s_prev * s_prev + s_prev2 * s_prev2 - coeff * s_prev * s_prev2
        weighted_sum += freq * power
        total += power
    return weighted_sum / total if total > 0 else 0.0


def ebur128_peak(path):
    try:
        proc = subprocess.run(
            ['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
            capture_output=True, text=True, timeout=30,
        )
        stderr = proc.stderr
        true_peaks = [
            float(line.split('TPK:')[1].split('dBFS')[0])
            for line in stderr.splitlines() if 'TPK:' in line
        ]
        if true_peaks:
            return max(true_peaks)
        # very short files: ebur128 only prints the final summary line
        summary = [
            float(line.split('Peak:')[1].split('dBFS')[0])
            for line in stderr.splitlines() if line.strip().startswith('Peak:')
        ]
        return max(summary) if summary else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def main():
    volume = 0.35
    if '--volume' in sys.argv:
        volume = float(sys.argv[sys.argv.index('--volume') + 1])
    volume_db = 20.0 * math.log10(volume)
    print(f'sfx.volume default = {volume} ({volume_db:+.1f} dB)\n')
    header = (
        f'{"file":18s} {"dur(ms)":>8s} {"size(B)":>7s} {"peak dBFS":>10s} {"truePk":>7s} '
        f'{"RMS dBFS":>9s} {"LUFS(K,ungated)":>16s} {"LUFS@vol":>9s} {"centroid":>8s} {">2k":>6s} {">4k":>6s}'
    )
    print(header)
    print('-' * len(header))
    rows = []
    for name in FILES:
        path = os.path.join(DIR, name)
        samples = read_wav(path)
        peak = max(abs(v) for v in samples) or 1e-20
        rms = math.sqrt(sum(v * v for v in samples) / len(samples))
        lufs = lufs_ungated(samples)
        centroid = spectral_centroid(samples)
        hi2 = highpass_rms_ratio(samples, 2000.0)
        hi4 = highpass_rms_ratio(samples, 4000.0)
        true_peak = ebur128_peak(path)
        row = {
            'file': name,
            'duration_ms': len(samples) / SR * 1000.0,
            'size': os.path.getsize(path),
            'peak_dbfs': db(peak),
            'true_peak': true_peak,
            'rms_dbfs': db(rms),
            'lufs': lufs,
            'lufs_at_volume': lufs + volume_db,
            'centroid': centroid,
            'hi2k': hi2,
            'hi4k': hi4,
        }
        rows.append(row)
        print(
            f'{name:18s} {row["duration_ms"]:8.1f} {row["size"]:7d} {row["peak_dbfs"]:10.1f} '
            f'{true_peak if true_peak is not None else float("nan"):7.1f} {row["rms_dbfs"]:9.1f} '
            f'{lufs:16.1f} {row["lufs_at_volume"]:9.1f} {centroid:8.0f} '
            f'{10 * math.log10(max(hi2, 1e-12)):6.1f} {10 * math.log10(max(hi4, 1e-12)):6.1f}',
        )
    print('\n(>2k/>4k = power fraction above that frequency, dB)')
    total = sum(r['size'] for r in rows)
    print(f'total size: {total} B; max duration: {max(r["duration_ms"] for r in rows):.0f} ms; '
          f'max peak: {max(r["peak_dbfs"] for r in rows):.1f} dBFS')
    return rows


if __name__ == '__main__':
    main()
