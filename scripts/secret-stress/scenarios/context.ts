/**
 * What every scenario group is handed.
 *
 * Seeds are generated per run from `crypto.randomUUID`, so no value this harness stores has ever
 * existed in the repo, in a fixture, or on the operator's machine before the run started. They are
 * long enough to clear the vault's 8-character minimum by a wide margin and distinctive enough that
 * a leak sweep over a terminal capture cannot produce a false positive.
 */
import type { AuthMode, IsolatedRoot } from "../lib/isolation";
import type { Recorder } from "../lib/report";

export interface Ctx {
	iso: IsolatedRoot;
	rec: Recorder;
	/** Catalog id passed to `--model`, exactly as a user would type it. */
	model: string;
	/** Whether a model actually resolves. False turns every model-turn scenario into NOT RUN. */
	hasModel: boolean;
	/** How the run gets a credential, so a scenario building its own root builds the same kind. */
	auth: AuthMode;
	/** Named credential values this run invented, keyed by the name they are stored under. */
	seeds: Record<string, string>;
}

/** A value that cannot collide with anything and is obviously not a real credential. */
export function newSeed(tag: string): string {
	return `stress-${tag}-${crypto.randomUUID().replace(/-/g, "")}`;
}

/** `--model <id>`, the way a user selects a model on the command line. */
export function modelArgs(ctx: Ctx): string[] {
	return ["--model", ctx.model];
}

/**
 * The composer prompt line: what "the TUI is alive and idle" looks like in the byte stream.
 *
 * Shared because three scenario files ask the same question, and a drifting copy would make one
 * of them silently stop recognising a live terminal and report a startup failure that is really a
 * changed prompt string.
 */
export const COMPOSER_READY = /ask anything|for commands/;
