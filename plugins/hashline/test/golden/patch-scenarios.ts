/**
 * Golden patch scenarios (TS-SUITE-6). Each scenario is a complete
 * operator-level interaction with the Patcher: initial files, a patch text,
 * and (implicitly) everything observable that comes back — section results,
 * warnings, error messages, and the final filesystem bytes. The runner
 * (golden-patch-outputs.test.ts) replays each scenario against a fresh
 * in-memory Patcher and pins the FULL observable output as a golden JSON
 * file, so a refactor or a Rust port cannot change any operator-visible
 * byte — content, hash tag, header, warning wording, error wording, or
 * line-ending restoration — without the golden diff surfacing it for review.
 *
 * `patch` receives a tag lookup (path -> minted snapshot tag) because tags
 * are content-derived at record time; everything else is static.
 */
export interface PatchScenario {
	name: string;
	/** Initial filesystem entries, recorded into the snapshot store in order. */
	files: ReadonlyArray<readonly [string, string]>;
	/** Paths present on disk but deliberately NOT snapshot-recorded. */
	unrecorded?: readonly string[];
	patch: (tag: (path: string) => string) => string;
}

export const SCENARIOS: readonly PatchScenario[] = [
	{
		name: "swap-single-line",
		files: [["src/a.ts", "one\ntwo\nthree\n"]],
		patch: tag => `[src/a.ts#${tag("src/a.ts")}]\nSWAP 2.=2:\n+TWO\n`,
	},
	{
		name: "del-range",
		files: [["src/a.ts", "l1\nl2\nl3\nl4\nl5\n"]],
		patch: tag => `[src/a.ts#${tag("src/a.ts")}]\nDEL 2.=4\n`,
	},
	{
		name: "ins-pre-and-post",
		files: [["src/a.ts", "alpha\nbeta\n"]],
		patch: tag => `[src/a.ts#${tag("src/a.ts")}]\nINS.PRE 1:\n+first\nINS.POST 2:\n+last\n`,
	},
	{
		name: "ins-head-tail",
		files: [["src/a.ts", "middle\n"]],
		patch: tag => `[src/a.ts#${tag("src/a.ts")}]\nINS.HEAD:\n+head\nINS.TAIL:\n+tail\n`,
	},
	{
		name: "mv-then-swap",
		files: [["src/old.ts", "one\ntwo\n"]],
		patch: tag => `[src/old.ts#${tag("src/old.ts")}]\nSWAP 1.=1:\n+ONE\nMV src/new.ts\n`,
	},
	{
		name: "rem-deletes-file",
		files: [["src/gone.ts", "bye\n"]],
		patch: tag => `[src/gone.ts#${tag("src/gone.ts")}]\nREM\n`,
	},
	{
		name: "crlf-bom-restored-on-persist",
		files: [["src/win.ts", "﻿a\r\nb\r\nc\r\n"]],
		patch: tag => `[src/win.ts#${tag("src/win.ts")}]\nSWAP 2.=2:\n+B\n`,
	},
	{
		name: "multi-section-two-files",
		files: [
			["src/a.ts", "aaa\n"],
			["src/b.ts", "bbb\n"],
		],
		patch: tag =>
			`[src/a.ts#${tag("src/a.ts")}]\nSWAP 1.=1:\n+AAA\n[src/b.ts#${tag("src/b.ts")}]\nSWAP 1.=1:\n+BBB\n`,
	},
	{
		name: "noop-swap-identical-content",
		files: [["src/a.ts", "same\n"]],
		patch: tag => `[src/a.ts#${tag("src/a.ts")}]\nSWAP 1.=1:\n+same\n`,
	},
	{
		name: "apply-error-duplicate-range-hunks",
		files: [["src/a.ts", "one\ntwo\nthree\n"]],
		patch: tag => `[src/a.ts#${tag("src/a.ts")}]\nSWAP 2.=2:\n+first\nSWAP 2.=2:\n+second\n`,
	},
	{
		name: "parse-error-del-with-body",
		files: [["src/a.ts", "one\ntwo\n"]],
		patch: tag => `[src/a.ts#${tag("src/a.ts")}]\nDEL 1.=2\n+stray\n`,
	},
	{
		name: "parse-error-empty-swap",
		files: [["src/a.ts", "one\n"]],
		patch: tag => `[src/a.ts#${tag("src/a.ts")}]\nSWAP 1.=1:\n`,
	},
	{
		name: "apply-error-unknown-tag",
		files: [["src/a.ts", "one\ntwo\n"]],
		patch: () => `[src/a.ts#FFFF]\nSWAP 1.=1:\n+ONE\n`,
	},
	{
		name: "apply-error-missing-tag",
		files: [["src/a.ts", "one\n"]],
		unrecorded: ["src/a.ts"],
		patch: () => `[src/a.ts]\nSWAP 1.=1:\n+ONE\n`,
	},
	{
		name: "apply-error-range-past-eof",
		files: [["src/a.ts", "one\ntwo\nthree\n"]],
		patch: tag => `[src/a.ts#${tag("src/a.ts")}]\nSWAP 99.=99:\n+X\n`,
	},
];
