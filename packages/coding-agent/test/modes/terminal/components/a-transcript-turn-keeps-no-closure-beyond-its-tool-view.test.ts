/**
 * WHY THIS SUITE EXISTS:
 *
 * A rebuilt transcript keeps every turn's components for the life of the session, and each kept the
 * closures it allocated per instance: an assistant turn a repaint callback and a scoped-repaint
 * callback bound to itself; a tool card a listener on its producer and the function that removed it,
 * the listener its producer held on the card's diff preview, the generic fallback row's formatter,
 * and every rail frame, framed block and cached view as an object of closures over its own scope; an
 * inline image its fallback colour, and a tool card's image the callback that recorded whether it
 * reached the screen. A drawn `bash` card kept 9 closures and 12 scopes, an `ask` card 15 and 15, an
 * assistant turn 2 and 3.
 *
 * CLASS: no transcript component keeps a closure of its own once its transcript is rebuilt and drawn.
 * The one closure a turn keeps is the function its tool's view draws through, with the parameter and
 * body scopes of the function that built it: at most one closure and two scopes for a turn that calls
 * a tool, none for a turn that does not. Every tool the build ships is swept from `BUILTIN_TOOL_NAMES`
 * and `HIDDEN_TOOL_NAMES`, beside a conversation turn with thinking, a plain answer, a failed turn, a
 * narrated call, a read showing an image and a `browser` card showing a screenshot, with images drawn
 * as images, so a tool added later is measured too. `bash` is the control: its framed view keeps its
 * draw function, so the measurement has to see one closure a turn.
 *
 * Counts are taken in a fresh process (`fixtures/rebuilt-turn-cells.ts`), since a suite that shares a
 * process sees closures other files left behind. A count is rounded, since a lazily built module
 * closure lands in one reading and not the other at well under one per turn.
 *
 * DOES NOT CATCH: a tool whose view keeps no closure today gaining one, which stays inside the
 * one-closure allowance; a closure a card keeps only for arguments or results of a shape the sweep
 * does not draw, or only while it streams; a closure allocated per turn and released before the frame
 * ends, which costs time and never stays live.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES } from "@veyyon/coding-agent/tools/core/builtin-names";
import { SHAPES, TOOL_IMAGE, type TurnCells } from "../../../fixtures/rebuilt-turn-cells";
import { hermeticSpawnEnv } from "../../../helpers/hermetic-spawn-env";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "..", "..", "..", "fixtures", "rebuilt-turn-cells.ts");
const TOOL_SHAPES: ReadonlySet<string> = new Set([...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES, TOOL_IMAGE]);

/** A fresh process loads every tool's card and rebuilds three transcripts per shape. */
const MEASURED_TIMEOUT_MS = 90_000;

describe("a transcript turn keeps no closure beyond its tool view", () => {
	it(
		"keeps no closure for a turn without a tool, and at most its view's draw function for a tool call",
		async () => {
			const { env, cleanup } = hermeticSpawnEnv();
			let perTurn: Record<string, TurnCells>;
			try {
				const { stdout, stderr } = await run(process.execPath, [FIXTURE], {
					env,
					timeout: MEASURED_TIMEOUT_MS - 5_000,
					killSignal: "SIGKILL",
				});
				expect(stderr).toBe("");
				perTurn = JSON.parse(stdout) as Record<string, TurnCells>;
			} finally {
				cleanup();
			}
			// Every shape was measured, the swept tools included.
			expect(Object.keys(perTurn)).toEqual(Object.keys(SHAPES));
			// The control: a card that draws through a framed view keeps that view's draw function.
			expect(Math.round(perTurn.bash.Function)).toBe(1);
			const over = Object.entries(perTurn).flatMap(([shape, cells]) => {
				const tool = TOOL_SHAPES.has(shape);
				const closures = Math.round(cells.Function);
				const scopes = Math.round(cells.JSLexicalEnvironment);
				return closures > (tool ? 1 : 0) || scopes > (tool ? 2 : 0)
					? [`${shape}: ${closures} closures, ${scopes} scopes`]
					: [];
			});
			expect(over).toEqual([]);
		},
		MEASURED_TIMEOUT_MS,
	);
});
