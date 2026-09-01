import { WALK_BY_FIXTURE, assertWalkBy, sampleFrames } from "./presence.ts";

const quiet = sampleFrames({ profile: "quiet", seed: 1, clock: () => 0, count: 8 });
const walk = assertWalkBy(WALK_BY_FIXTURE);
const peak = walk.motion.reduce((max, sample) => Math.max(max, sample.intensity), 0);

process.stdout.write(
  [
    `quiet[0] ${JSON.stringify(quiet[0])}`,
    `walk     ${walk.states.map((sample) => sample.state).join(" → ")}`,
    `peak     intensity=${peak}`,
    "",
  ].join("\n"),
);
