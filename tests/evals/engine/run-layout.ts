/**
 * One naming rule for the directory and the job name a trial is filed under.
 *
 * Three backends file a trial's artifacts: the in-process backend writes a nested directory, and
 * harbor and pier write a flat job name. Each one built the name inline, and the harbor and pier
 * cleanups rebuilt it a second time to find what runTrial had written, so a change to one copy
 * pointed the cleanup at a directory that does not exist, or at one that belongs to another trial.
 */
import * as path from "node:path";
import { pathSegmentFrom } from "./package-paths";
import type { TrialCell } from "./contracts";

/** Segment a run with no id is filed under. */
export const DEFAULT_RUN_SEGMENT = "run";
/** Segment a cell with no variant is filed under. */
export const DEFAULT_VARIANT_SEGMENT = "default";
/** Segment a cell with an empty task id is filed under. */
export const DEFAULT_TASK_SEGMENT = "task";

/** The four parts every trial name is built from, each already a safe path segment. */
export interface TrialSegments {
	readonly run: string;
	readonly variant: string;
	readonly task: string;
	readonly repeat: number;
}

/** Resolve a cell's name parts. A missing or unsafe part takes its default segment. */
export function trialSegments(runId: string, cell: TrialCell): TrialSegments {
	const repeat = cell.repeat;
	return {
		run: pathSegmentFrom(runId, DEFAULT_RUN_SEGMENT),
		variant: pathSegmentFrom(cell.variant || DEFAULT_VARIANT_SEGMENT, DEFAULT_VARIANT_SEGMENT),
		task: pathSegmentFrom(cell.task, DEFAULT_TASK_SEGMENT),
		repeat: typeof repeat === "number" && Number.isSafeInteger(repeat) && repeat > 0 ? repeat : 0,
	};
}

/** `<run>__<variant>__<task>__r<repeat>`: the flat job name harbor and pier file a trial under. */
export function trialJobName(runId: string, cell: TrialCell): string {
	const segments = trialSegments(runId, cell);
	return `${segments.run}__${segments.variant}__${segments.task}__r${segments.repeat}`;
}

/** `<runsDir>/<run>`: the directory one run's trials are filed under. */
export function runDirFor(runsDir: string, runId: string): string {
	return path.join(runsDir, pathSegmentFrom(runId, DEFAULT_RUN_SEGMENT));
}

/** `<runsDir>/<run>/<variant>/<task>/repeat-<n>`: the nested directory the in-process backend writes. */
export function trialDirFor(runsDir: string, runId: string, cell: TrialCell): string {
	const segments = trialSegments(runId, cell);
	return path.join(runsDir, segments.run, segments.variant, segments.task, `repeat-${segments.repeat}`);
}

/** The segment a variant's staged assets are filed under. */
export function sanitizeVariantName(name: string): string {
	return pathSegmentFrom(name, DEFAULT_VARIANT_SEGMENT);
}
