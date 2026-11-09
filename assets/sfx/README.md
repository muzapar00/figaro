# Figaro UI sound effects (earcons)

Five short, quiet confirmations for the overlay — deliberately **not** part of
the voice path: they are synthesized here (no MiniMax voice), played by
`src/voice/sfx/` on the same PipeWire sink as the voice, and can never interrupt
speech.

| file | duration | size | rendered peak | K-weighted loudness | effective @ sfx.volume=0.35 | spectral centroid | >2 kHz energy |
|---|---|---|---|---|---|---|---|
| `listen-start.wav` | 80 ms | 5.2 KB | -15.0 dBFS | -20.4 LUFS | **-29.5 LUFS** | 1080 Hz | -10.5 dB |
| `listen-end.wav` | 65 ms | 4.2 KB | -17.5 dBFS | -22.9 LUFS | **-32.0 LUFS** | 1054 Hz | -11.3 dB |
| `answer-done.wav` | 155 ms | 10.0 KB | -15.0 dBFS | -20.7 LUFS | **-29.8 LUFS** | 498 Hz | -21.8 dB |
| `dismiss.wav` | 200 ms | 12.8 KB | -15.5 dBFS | -21.3 LUFS | **-30.4 LUFS** | 545 Hz | -20.0 dB |
| `error.wav` | 181 ms | 11.6 KB | -16.5 dBFS | -22.6 LUFS | **-31.8 LUFS** | 379 Hz | -27.8 dB |

Total 43.8 KB; all files are 32 kHz / mono / 16-bit PCM WAV, well under the
60 KB per-file budget.

Reference: Figaro's TTS voice measures **-25.5 LUFS / -6.5 dBFS peak** (MiniMax
`male-qn-jingying` preview, ffmpeg ebur128). At the default `sfx.volume = 0.35`
the UI sounds therefore sit **4–6.5 dB below the voice in loudness** (and
~18–20 dB below it in peak) — audible when the room is quiet, never fighting the
voice.

Measured with `python3 assets/sfx/measure.py` (stdlib K-weighting, ITU-R BS.1770
without gating — gated integrated loudness is meaningless below ebur128's 400 ms
block size) and `ffmpeg ebur128` for true peaks. Re-run it after any change.

## What the sounds are for

| sound | design | suggested trigger |
|---|---|---|
| `listen-start` | 80 ms rising blip 920→1270 Hz, soft attack | the moment a wake is accepted, as the acknowledgement starts. It fills the ack's ~100 ms leading silence and sits **above** the male voice band. |
| `listen-end` | 65 ms very light falling tick 1150→900 Hz | capture actually ends / ASR goes to `finalizing` (push-to-talk release). Quieter than the start blip. |
| `answer-done` | 155 ms two-note resolve G4→C5 | the reply has **finished playing** (state `speaking` → `waiting`/`idle`). Only plays after speech, so the warmer low register is safe. |
| `dismiss` | 200 ms gentle downward glide 720→330 Hz | user cancels / says 退下 / UI dismiss — "standing down". |
| `error` | 181 ms two soft pulses G4→F4 | a genuine voice/agent error (not for "no network" spam). A "hmm", not an alarm. |

## Design constraints

- **Short**: 65–200 ms, nothing loops, nothing drones (a "thinking" loop was
  deliberately not made — it would read as stutter).
- **No piercing highs**: fundamentals ≤ 1.3 kHz with rolled-off harmonics; >2 kHz
  energy is at most -10.5 dB relative (listen-start) and much less for the rest.
- **Does not fight the voice**: the only sound that can overlap Figaro speaking
  is `listen-start`, and it sits above the male-voice main band (~150–900 Hz).
  The warm/lower sounds only fire after speech has ended.
- **Click-free**: raised-cosine attack, exponential decay, smooth fade-out.
- **Low level**: rendered peaks -15…-17.5 dBFS; with the default volume this is
  4–6.5 dB below the TTS voice.

## Regenerating

```bash
python3 assets/sfx/generate.py     # rewrite the WAVs (stdlib only, deterministic)
python3 assets/sfx/measure.py      # durations / peaks / LUFS / spectrum
```

Both scripts are pure Python 3 standard library (numpy is not installed on this
machine). The WAVs are deterministic, so they can be regenerated instead of being
unknown binary blobs. Sound design, synthesis and level calibration: Figaro
project, released under the same terms as the repository (CC0-1.0 for the audio).
