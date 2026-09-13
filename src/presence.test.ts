import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_HYSTERESIS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_THRESHOLD,
  QUIET_FIXTURE,
  QUIET_RSSI,
  RSSI_BASELINE,
  WALK_BY_FIXTURE,
  WALK_BY_RSSI,
  assertWalkBy,
  detectMotion,
  presenceState,
  sampleFrames,
  type MotionSample,
  type Presence,
} from "./presence.ts";

test("sampleFrames: same seed and clock return the same stream", () => {
  const clock = () => 1_700_000_000_000;
  const a = sampleFrames({ seed: 7, clock, profile: "quiet", count: 8 });
  const b = sampleFrames({ seed: 7, clock, profile: "quiet", count: 8 });
  assert.deepEqual(a, b);
  const other = sampleFrames({ seed: 8, clock, profile: "quiet", count: 8 });
  assert.notDeepEqual(a, other);
  assert.equal(a[0]?.t, 1_700_000_000_000);
  assert.equal(a[1]?.t, 1_700_000_000_000 + DEFAULT_INTERVAL_MS);
  for (const frame of a) {
    assert.equal(frame.kind, "rssi");
    assert.ok(Number.isFinite(frame.amplitude));
  }
});

test("sampleFrames: injectable samples keep timestamps from the fixture clock", () => {
  const frames = sampleFrames({
    samples: [-62, -50, -62],
    clock: () => 100,
    intervalMs: 10,
    kind: "rssi",
  });
  assert.deepEqual(
    frames.map((frame) => ({ t: frame.t, amplitude: frame.amplitude })),
    [
      { t: 100, amplitude: -62 },
      { t: 110, amplitude: -50 },
      { t: 120, amplitude: -62 },
    ],
  );
});

test("sampleFrames: CSI kind is the same numeric path with a different baseline", () => {
  const frames = sampleFrames({
    kind: "csi",
    samples: [40, 48, 40],
    clock: () => 0,
  });
  assert.equal(frames[0]?.kind, "csi");
  assert.deepEqual(
    frames.map((frame) => frame.amplitude),
    [40, 48, 40],
  );
});

test("detectMotion: consecutive delta at/above threshold is intensity; else quiet", () => {
  const frames = sampleFrames({
    samples: WALK_BY_RSSI,
    clock: () => 0,
  });
  const motion = detectMotion(frames, DEFAULT_THRESHOLD);
  assert.equal(motion.length, frames.length);
  assert.equal(motion[0]?.quiet, true);
  assert.equal(motion[0]?.intensity, 0);

  const firstSwing = motion[6];
  assert.equal(firstSwing?.intensity, 4);
  assert.equal(firstSwing?.quiet, false);

  const peak = motion[7];
  assert.equal(peak?.intensity, 8);
  assert.equal(peak?.quiet, false);

  const settled = motion[15];
  assert.equal(settled?.intensity, 0);
  assert.equal(settled?.quiet, true);
});

test("detectMotion: sub-threshold jitter is quiet", () => {
  const frames = sampleFrames({
    samples: [RSSI_BASELINE, RSSI_BASELINE + 0.4, RSSI_BASELINE, RSSI_BASELINE - 0.3],
    clock: () => 0,
  });
  const motion = detectMotion(frames, DEFAULT_THRESHOLD);
  for (const sample of motion) {
    assert.equal(sample.quiet, true);
    assert.equal(sample.intensity, 0);
  }
});

test("presenceState: enter above high, leave below low, hold in the band", () => {
  const motion = intensities([0, 4, 8, 2, 0]);
  const states = presenceState(motion, { enter: 5, leave: 1 });
  assert.deepEqual(
    states.map((sample) => sample.state),
    ["CLEAR", "CLEAR", "PRESENCE", "PRESENCE", "CLEAR"],
  );
});

test("presenceState: a brief blip below enter stays CLEAR (no flap)", () => {
  const frames = sampleFrames({
    samples: [-62, -62, -59, -62, -62, -62],
    clock: () => 0,
  });
  const motion = detectMotion(frames, DEFAULT_THRESHOLD);
  const states = presenceState(motion, DEFAULT_HYSTERESIS);
  assert.ok(motion.some((sample) => sample.intensity === 3));
  for (const sample of states) {
    assert.equal(sample.state, "CLEAR");
  }
});

test("assertWalkBy: synthetic walk-by is PRESENCE then CLEAR", () => {
  const result = assertWalkBy(WALK_BY_FIXTURE);
  const sequence = result.states.map((sample) => sample.state);
  assert.ok(sequence.includes("PRESENCE"));
  assert.equal(sequence[sequence.length - 1], "CLEAR");
  assertPresenceThenClear(sequence);
  assert.equal(result.frames.length, WALK_BY_RSSI.length);
});

test("assertWalkBy: quiet fixture stays CLEAR", () => {
  const result = assertWalkBy(QUIET_FIXTURE);
  for (const sample of result.states) {
    assert.equal(sample.state, "CLEAR");
  }
  assert.equal(result.frames.length, QUIET_RSSI.length);
  assert.equal(result.motion.every((sample) => sample.quiet), true);
});

test("assertWalkBy: seeded walk-by profile still PRESENCE then CLEAR", () => {
  const result = assertWalkBy({
    profile: "walk-by",
    source: { profile: "walk-by", seed: 3, clock: () => 42, count: 20 },
  });
  assertPresenceThenClear(result.states.map((sample) => sample.state));
});

test("assertWalkBy: CSI walk-by uses the same occupancy path", () => {
  const result = assertWalkBy({
    profile: "walk-by",
    source: { profile: "walk-by", kind: "csi", seed: 1, clock: () => 0, count: 20 },
  });
  assert.equal(result.frames[0]?.kind, "csi");
  assertPresenceThenClear(result.states.map((sample) => sample.state));
});

test("presenceState: enter must sit above leave", () => {
  assert.throws(
    () => presenceState([], { enter: 1, leave: 1 }),
    /enter \(1\) must be above leave \(1\)/,
  );
});

function intensities(values: readonly number[]): MotionSample[] {
  return values.map((intensity, i) => ({
    t: i * DEFAULT_INTERVAL_MS,
    intensity,
    quiet: intensity === 0,
  }));
}

function assertPresenceThenClear(sequence: readonly Presence[]): void {
  const firstPresence = sequence.indexOf("PRESENCE");
  assert.ok(firstPresence >= 0, "expected PRESENCE");
  assert.ok(
    sequence.slice(firstPresence).includes("CLEAR"),
    "expected PRESENCE then CLEAR",
  );
}
