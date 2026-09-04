/**
 * The one place the replay actually runs, imported for its side effect.
 *
 * `cli.ts` names this as its first import so the write happens during THIS module's evaluation,
 * ahead of the directory resolver, the logger and everything they reach. A statement in `cli.ts`
 * would be too late: static imports are evaluated before the first statement of the module that
 * declares them, which is the whole 33ms this is jumping ahead of.
 *
 * The side effect lives here rather than in `./first-frame-replay` so that reading the recording,
 * validating it and recording a new one stay callable — from the frame that records, and from a
 * test — without any of them writing to fd 1 as a consequence of being imported.
 */

import { replayFirstFrame } from "./first-frame-replay";

replayFirstFrame();
