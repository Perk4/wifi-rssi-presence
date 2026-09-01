export type Clock = () => number;

export type SampleKind = "rssi" | "csi";

export type Profile = "quiet" | "walk-by" | "blip";

export type Presence = "PRESENCE" | "CLEAR";

export type FrameSource = {
  kind?: SampleKind;
  seed?: number;
  clock?: Clock;
  count?: number;
  intervalMs?: number;
  profile?: Profile;
  samples?: readonly number[];
};

export type SampleFrame = {
  t: number;
  amplitude: number;
  kind: SampleKind;
};

export type MotionSample = {
  t: number;
  intensity: number;
  quiet: boolean;
};

export type HysteresisOpts = {
  enter: number;
  leave: number;
  initial?: Presence;
};

export type PresenceSample = {
  t: number;
  state: Presence;
  intensity: number;
};

export type WalkByFixture = {
  profile: "walk-by" | "quiet";
  source?: FrameSource;
  threshold?: number;
  hysteresis?: HysteresisOpts;
};

export type WalkByResult = {
  frames: SampleFrame[];
  motion: MotionSample[];
  states: PresenceSample[];
};

export const DEFAULT_KIND: SampleKind = "rssi";
export const DEFAULT_COUNT = 20;
export const DEFAULT_INTERVAL_MS = 50;
export const DEFAULT_SEED = 1;
export const DEFAULT_THRESHOLD = 2;
export const DEFAULT_HYSTERESIS: HysteresisOpts = { enter: 5, leave: 1 };
export const RSSI_BASELINE = -62;
export const CSI_BASELINE = 40;

/**
 * Quiet room, then a body crosses the RF path (RSSI swings), then empty again.
 * Consecutive |delta| peaks at 8 dB so hysteresis enter=5 trips, then it settles.
 */
export const WALK_BY_RSSI: readonly number[] = [
  -62, -62, -62, -62, -62, -62, -58, -50, -44, -46, -52, -58, -61, -62, -62, -62,
  -62, -62, -62, -62,
];

export const QUIET_RSSI: readonly number[] = Array.from(
  { length: DEFAULT_COUNT },
  () => RSSI_BASELINE,
);

export const QUIET_FIXTURE: WalkByFixture = {
  profile: "quiet",
  source: { samples: QUIET_RSSI, clock: () => 0, kind: "rssi" },
};

export const WALK_BY_FIXTURE: WalkByFixture = {
  profile: "walk-by",
  source: { samples: WALK_BY_RSSI, clock: () => 0, kind: "rssi" },
};

/**
 * Stub stream of RSSI dBm (or CSI amplitude) over time.
 * On a Cardputer this is `esp_wifi_sta_get_ap_info` / CSI callback.
 * Here it is a seeded fixture. `clock` sets t0; `seed` salts stub noise.
 */
export function sampleFrames(source: FrameSource): SampleFrame[] {
  const kind = source.kind ?? DEFAULT_KIND;
  assertKind(kind);
  const intervalMs = source.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`intervalMs must be a finite number > 0, got ${intervalMs}`);
  }
  const t0 = source.clock?.() ?? 0;
  if (!Number.isFinite(t0)) {
    throw new Error(`clock() must return a finite timestamp, got ${t0}`);
  }

  const amplitudes = resolveAmplitudes(source, kind, t0);
  return amplitudes.map((amplitude, i) => ({
    t: t0 + i * intervalMs,
    amplitude,
    kind,
  }));
}

/**
 * Consecutive-sample |delta|. Intensity is that delta when it meets `threshold`;
 * otherwise quiet (intensity 0). First sample has no predecessor, so it is quiet.
 */
export function detectMotion(
  frames: readonly SampleFrame[],
  threshold: number,
): MotionSample[] {
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error(`threshold must be a finite number >= 0, got ${threshold}`);
  }
  const out: MotionSample[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame === undefined) {
      throw new Error(`frames[${i}] is missing`);
    }
    if (i === 0) {
      out.push({ t: frame.t, intensity: 0, quiet: true });
      continue;
    }
    const prev = frames[i - 1];
    if (prev === undefined) {
      throw new Error(`frames[${i - 1}] is missing`);
    }
    const delta = Math.abs(frame.amplitude - prev.amplitude);
    const crossed = delta >= threshold;
    out.push({
      t: frame.t,
      intensity: crossed ? delta : 0,
      quiet: !crossed,
    });
  }
  return out;
}

/**
 * Schmitt trigger on motion intensity. Enter PRESENCE at/above `enter`.
 * Leave CLEAR at/below `leave`. Values in between hold the last state so a
 * one-sample blip does not flap occupancy.
 */
export function presenceState(
  motion: readonly MotionSample[],
  opts: HysteresisOpts,
): PresenceSample[] {
  if (!Number.isFinite(opts.enter) || !Number.isFinite(opts.leave)) {
    throw new Error("hysteresis enter and leave must be finite numbers");
  }
  if (opts.leave < 0) {
    throw new Error(`hysteresis leave must be >= 0, got ${opts.leave}`);
  }
  if (opts.enter <= opts.leave) {
    throw new Error(
      `hysteresis enter (${opts.enter}) must be above leave (${opts.leave})`,
    );
  }
  let state: Presence = opts.initial ?? "CLEAR";
  return motion.map((sample) => {
    state = nextPresence(state, sample.intensity, opts);
    return { t: sample.t, state, intensity: sample.intensity };
  });
}

/**
 * Walk-by fixture must visit PRESENCE then return to CLEAR.
 * Quiet fixture must stay CLEAR. Throws if the occupancy path is wrong.
 */
export function assertWalkBy(fixture: WalkByFixture): WalkByResult {
  const profile = fixture.profile;
  const source: FrameSource = {
    ...(fixture.source ?? {}),
    profile: fixture.source?.profile ?? profile,
  };
  const frames = sampleFrames(source);
  const motion = detectMotion(frames, fixture.threshold ?? DEFAULT_THRESHOLD);
  const states = presenceState(motion, fixture.hysteresis ?? DEFAULT_HYSTERESIS);

  switch (profile) {
    case "quiet":
      assertAllClear(states);
      break;
    case "walk-by":
      assertPresenceThenClear(states);
      break;
    default: {
      const _never: never = profile;
      throw new Error(`unknown fixture profile: ${_never}`);
    }
  }

  return { frames, motion, states };
}

function resolveAmplitudes(
  source: FrameSource,
  kind: SampleKind,
  t0: number,
): number[] {
  if (source.samples !== undefined) {
    if (source.samples.length === 0) {
      throw new Error("samples must be a non-empty array of finite numbers");
    }
    return source.samples.map((value, i) => {
      if (!Number.isFinite(value)) {
        throw new Error(`samples[${i}] must be finite, got ${value}`);
      }
      return value;
    });
  }

  const count = source.count ?? DEFAULT_COUNT;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`count must be an integer >= 1, got ${count}`);
  }
  const seed = source.seed ?? DEFAULT_SEED;
  if (!Number.isFinite(seed)) {
    throw new Error(`seed must be finite, got ${seed}`);
  }
  const profile = source.profile ?? "quiet";
  return rssiSeries(profile, count, seed, t0).map((rssi) =>
    toAmplitude(rssi, kind),
  );
}

function rssiSeries(
  profile: Profile,
  count: number,
  seed: number,
  t0: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const noise =
      (unit(seed ^ Math.imul(i + 1, 0x9e3779b9) ^ (t0 & 0xffff)) - 0.5) * 0.6;
    const base = profileRssi(profile, i, count);
    out.push(roundTo(base + noise, 3));
  }
  return out;
}

function profileRssi(profile: Profile, i: number, count: number): number {
  switch (profile) {
    case "quiet":
      return RSSI_BASELINE;
    case "walk-by":
      return walkByRssi(i, count);
    case "blip":
      return i === Math.floor(count / 2) ? RSSI_BASELINE + 3 : RSSI_BASELINE;
    default: {
      const _never: never = profile;
      throw new Error(`unknown profile: ${_never}`);
    }
  }
}

function walkByRssi(i: number, count: number): number {
  if (count === WALK_BY_RSSI.length) {
    const sample = WALK_BY_RSSI[i];
    if (sample === undefined) {
      throw new Error(`WALK_BY_RSSI[${i}] is missing`);
    }
    return sample;
  }
  const start = Math.floor(count * 0.3);
  const end = Math.floor(count * 0.65);
  if (i < start || i > end || end <= start) {
    return RSSI_BASELINE;
  }
  const u = (i - start) / (end - start);
  return roundTo(RSSI_BASELINE - 14 * Math.sin(Math.PI * u), 3);
}

function toAmplitude(rssi: number, kind: SampleKind): number {
  switch (kind) {
    case "rssi":
      return rssi;
    case "csi":
      return CSI_BASELINE + Math.abs(rssi - RSSI_BASELINE);
    default: {
      const _never: never = kind;
      throw new Error(`unknown kind: ${_never}`);
    }
  }
}

function nextPresence(
  state: Presence,
  intensity: number,
  opts: HysteresisOpts,
): Presence {
  switch (state) {
    case "CLEAR":
      return intensity >= opts.enter ? "PRESENCE" : "CLEAR";
    case "PRESENCE":
      return intensity <= opts.leave ? "CLEAR" : "PRESENCE";
    default: {
      const _never: never = state;
      throw new Error(`unknown presence: ${_never}`);
    }
  }
}

function assertKind(kind: SampleKind): void {
  switch (kind) {
    case "rssi":
    case "csi":
      return;
    default: {
      const _never: never = kind;
      throw new Error(`unknown kind: ${_never}`);
    }
  }
}

function assertAllClear(states: readonly PresenceSample[]): void {
  for (const sample of states) {
    if (sample.state !== "CLEAR") {
      throw new Error(
        `quiet fixture expected CLEAR throughout, got ${sample.state} at t=${sample.t}`,
      );
    }
  }
}

function assertPresenceThenClear(states: readonly PresenceSample[]): void {
  const firstPresence = states.findIndex((sample) => sample.state === "PRESENCE");
  if (firstPresence < 0) {
    throw new Error("walk-by fixture expected PRESENCE");
  }
  const after = states.slice(firstPresence);
  if (!after.some((sample) => sample.state === "CLEAR")) {
    throw new Error("walk-by fixture expected PRESENCE then CLEAR");
  }
  const last = states[states.length - 1];
  if (last === undefined || last.state !== "CLEAR") {
    throw new Error("walk-by fixture expected to end CLEAR");
  }
}

function unit(seed: number): number {
  let x = seed >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return (x >>> 0) / 0x1_0000_0000;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
