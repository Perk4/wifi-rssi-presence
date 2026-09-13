# wifi-rssi-presence

Host-side walk of a Wi-Fi RSSI / CSI human-presence radar. Sample a stub stream, turn consecutive-sample delta into motion, then Schmitt-trigger occupancy so a walk-by is `PRESENCE` then `CLEAR`. There is no Cardputer firmware, no ESP-IDF CSI driver, and no product HUD.

This is not [ld2450-radar-hud](https://github.com/Perk4/ld2450-radar-hud). That one is mmWave: parse an HLK-LD2450 UART frame into x/y, EMA-smooth, draw a FOV-clipped polar grid, overlay a trail. This one is Wi-Fi sensing: amplitude over time, not range/angle.

Source itch: Talking Sasquach — [$50 Human Detecting Radar Feels Illegal (It's Easy)](https://www.youtube.com/watch?v=HqTxv7y6sDM). ESP32-S3 Cardputer, Wi-Fi RSSI/CSI as a body detector. We keep sample → motion → occupancy and drop the device UI.

## The four primitives

`src/presence.ts` is the whole pipeline.

| Host | Cardputer / ESP32 Wi-Fi sensing |
| --- | --- |
| `sampleFrames(source)` | CSI callback or AP RSSI over time |
| `detectMotion(frames, threshold)` | Consecutive-sample \|Δamplitude\| as motion |
| `presenceState(motion, opts)` | Occupancy Schmitt trigger (`PRESENCE` / `CLEAR`) |
| `assertWalkBy(fixture)` | Walk-by must visit `PRESENCE` then `CLEAR`; quiet stays `CLEAR` |

1. **Sample.** `sampleFrames(source)` returns `{ t, amplitude, kind }[]`. `kind` is `"rssi"` (dBm) or `"csi"` (subcarrier amplitude). Same numeric stream either way. On the chip this is `esp_wifi` CSI or `esp_wifi_sta_get_ap_info`. Here it is a stub: inject `samples`, or a `profile` (`quiet` / `walk-by` / `blip`) with fixture `clock` and `seed`.
2. **Motion.** `detectMotion(frames, threshold)` is consecutive-sample `|amplitude[i] - amplitude[i-1]|`. If that delta meets `threshold`, intensity is the delta. Otherwise quiet (`intensity` 0). The first sample has no predecessor, so it is quiet.
3. **Presence.** `presenceState(motion, { enter, leave })` is hysteresis. Enter `PRESENCE` at/above `enter`. Leave `CLEAR` at/below `leave`. Values in the band hold the last state, so a one-sample blip does not flap occupancy.
4. **Walk-by.** `assertWalkBy(fixture)` runs the three steps. A synthetic walk-by must see `PRESENCE` then return to `CLEAR`. A quiet fixture must stay `CLEAR`. Throws if the occupancy path is wrong.

Wi-Fi sensing vs mmWave:

| | This library (Wi-Fi) | ld2450-radar-hud (mmWave) |
| --- | --- | --- |
| Input | RSSI dBm or CSI amplitude vs time | 30-byte LD2450 UART x/y |
| Motion | Consecutive-sample delta | EMA of a tracked point |
| Output | `PRESENCE` / `CLEAR` | Polar FOV + trail |
| Hardware | None (stub frames) | None (fixture bytes) |

## Walk-by fixture

`WALK_BY_RSSI` is 20 samples at 50 ms. Baseline −62 dBm, a body crosses (down to −44 dBm), then empty again.

```
-62 -62 -62 -62 -62 -62 -58 -50 -44 -46 -52 -58 -61 -62 -62 -62 -62 -62 -62 -62
```

Default motion threshold is 2 dB. Peak consecutive delta is 8 dB. Default hysteresis is `enter: 5`, `leave: 1`. The walk enters `PRESENCE` on the 8 dB swing and returns to `CLEAR` once the room is quiet. `QUIET_RSSI` is twenty −62 dBm samples and never leaves `CLEAR`. A 3 dB blip sits in the hysteresis band and stays `CLEAR`.

## Run

Needs Node 22 or newer (type stripping, no build step).

```bash
npm install
npm test
npm run typecheck
npm run demo
```

`npm run demo` prints a quiet sample, the walk-by occupancy path, and peak motion intensity.

## What this is not

No Cardputer firmware, CSI driver, ESP-IDF, TFT radar HUD, or mmWave tracker. The host path is the one with tests.
