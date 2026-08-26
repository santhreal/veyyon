/**
 * Every tool-render oracle can fail on rows that earn it.
 *
 * WHY THIS SUITE EXISTS:
 * An oracle that cannot fail is worse than no oracle: it reports a guarantee as upheld on every frame
 * forever, and the sweep it runs in reports green while the defect ships. This module has already
 * shipped two of them, and one of the six guarantees here was rewritten twice before it could report
 * anything but "everything is fine": the first version of the style guarantee called every correctly
 * closed row a defect because a renderer closes a colour with `39` and not with `0`, and the version
 * after it could not fail at all once the engine's own row reset was accounted for.
 *
 * WHAT IT ASSERTS:
 * A clean set of rows fails nothing, goes blind nowhere, and is inspected by every guarantee. Then one
 * crafted defect per guarantee, in a `Record` over the id union so a guarantee cannot be declared
 * without a frame that makes it speak, has to come back out of the evaluator as a failure of that
 * guarantee. Each defect is also asserted to fail ONLY its own guarantee: a crafted frame that trips
 * three of them proves nothing about which one was looking.
 *
 * The two states that make every guarantee stand down are pinned as well: a frame with no renders at
 * all, and a frame whose only render transmits an image. Both are skipped rather than blind, because a
 * guarantee with no subject in scope is out of scope, and an image payload is bytes no row oracle can
 * read as text.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Whether the real renderers trip these guarantees. That is the sweep's job, and the sweep pins the
 *   ledger of what they trip today.
 * - Whether a guarantee's message names the right fix. The message is prose; the details object is
 *   what a caller reads.
 *
 * MUTATION GATE:
 * 1. Pointing `checkNoContentSuppliedEscapeSurvives` at `plainRows` turns its case red: stripping
 *    removes the sequence it looks for, which is why that one guarantee reads the raw bytes.
 * 2. Returning `textualRenders` to `state.renders` (ignoring `carriesBinaryPayload`) turns the image
 *    stand-down case red: every guarantee reads the payload bytes and reports a defect.
 */

import { describe, expect, it } from "bun:test";
import {
	evaluateAllToolRenderOracles,
	TOOL_RENDER_ORACLE_GUARANTEES,
	type ToolRenderOracleFrameState,
	type ToolRenderOracleGuarantee,
	type ToolRenderSnapshot,
} from "../src/modes/components/tool-render-defect-oracle";

const HOME = "/home/oracle-operator";
const INJECTED = "\x1b[2J";

function cleanSnapshot(): ToolRenderSnapshot {
	const rawRows = ["\x1b[38;2;120;120;120mread\x1b[39m src/index.ts", "  12 lines, 3 matches"];
	return {
		tool: "read",
		surface: "call",
		fixture: "clean",
		width: 60,
		rawRows,
		// The plain rows are what the cells show. They are written out rather than derived so a defect
		// crafted below changes exactly the channel it means to.
		plainRows: ["read src/index.ts", "  12 lines, 3 matches"],
		carriesBinaryPayload: false,
	};
}

function baselineFrameState(): ToolRenderOracleFrameState {
	return { homeDir: HOME, forbiddenSequences: [INJECTED], renders: [cleanSnapshot()] };
}

/** A crafted frame that is wrong in the way one guarantee describes, and nothing else. */
interface CraftedDefect {
	name: string;
	break: (state: ToolRenderOracleFrameState) => ToolRenderOracleFrameState;
}

function withRows(
	state: ToolRenderOracleFrameState,
	rows: { raw?: readonly string[]; plain?: readonly string[] },
): ToolRenderOracleFrameState {
	const render = state.renders[0];
	if (!render) throw new Error("baseline has no render");
	return {
		...state,
		renders: [{ ...render, rawRows: rows.raw ?? render.rawRows, plainRows: rows.plain ?? render.plainRows }],
	};
}

/**
 * One defect per guarantee, keyed by id.
 *
 * A `Record` over the union: adding a guarantee without a frame that makes it fail is a compile error,
 * which is the only way to keep a registry from acquiring an oracle nobody has ever seen speak.
 */
const DEFECTS: Readonly<Record<ToolRenderOracleGuarantee, CraftedDefect>> = {
	everyRowFitsTheRenderWidth: {
		name: "a row is wider than the width the renderer was given",
		break: state => withRows(state, { plain: ["x".repeat(61), "  12 lines, 3 matches"] }),
	},
	noRowSmugglesALineBreak: {
		name: "a row string carries two lines",
		break: state => withRows(state, { raw: ["read src/index.ts\nand a second line", "  12 lines"] }),
	},
	noRawTabReachesTheScreen: {
		name: "a tab reaches a cell",
		break: state => withRows(state, { plain: ["read\tsrc/index.ts", "  12 lines, 3 matches"] }),
	},
	noContentSuppliedEscapeSurvives: {
		name: "the content's screen clear is forwarded to the terminal",
		break: state => withRows(state, { raw: [`read ${INJECTED}src/index.ts`, "  12 lines"] }),
	},
	noHomeDirectoryPathIsPainted: {
		name: "an unshortened home path is painted",
		break: state => withRows(state, { plain: [`read ${HOME}/src/index.ts`, "  12 lines"] }),
	},
	noControlCharacterOtherThanStyle: {
		name: "a NUL reaches a cell",
		break: state => withRows(state, { plain: ["read src\x00index.ts", "  12 lines"] }),
	},
};

/**
 * Guarantees whose crafted defect legitimately trips another one too.
 *
 * Pinned empty by exact equality. A defect that starts tripping a second guarantee is either a
 * badly-crafted frame or two guarantees that overlap, and both are decisions rather than accidents.
 */
const SINGLE_CRAFT_EXEMPTIONS: readonly ToolRenderOracleGuarantee[] = [];

describe("the baseline rows are clean", () => {
	it("fails nothing and goes blind nowhere", () => {
		const result = evaluateAllToolRenderOracles(baselineFrameState());
		expect(result.failures).toEqual([]);
		expect(result.blind).toEqual([]);
	});

	it("is inspected by every guarantee", () => {
		const result = evaluateAllToolRenderOracles(baselineFrameState());
		expect([...result.inspected].sort()).toEqual([...TOOL_RENDER_ORACLE_GUARANTEES].sort());
	});
});

describe("every guarantee has a frame that makes it fail", () => {
	it("crafts a defect for every declared guarantee", () => {
		expect(Object.keys(DEFECTS).sort()).toEqual([...TOOL_RENDER_ORACLE_GUARANTEES].sort());
	});

	for (const id of TOOL_RENDER_ORACLE_GUARANTEES) {
		const defect = DEFECTS[id];
		it(`${id}: ${defect.name}`, () => {
			const result = evaluateAllToolRenderOracles(defect.break(baselineFrameState()));
			const failure = result.failures.find(entry => entry.oracle === id);
			expect(failure, `${id} stayed silent on a frame crafted to break it`).toBeDefined();
			expect(result.inspected).toContain(id);
		});

		it(`${id}: the crafted defect trips nothing else`, () => {
			const result = evaluateAllToolRenderOracles(defect.break(baselineFrameState()));
			const others = result.failures.map(entry => entry.oracle).filter(oracle => oracle !== id);
			if (SINGLE_CRAFT_EXEMPTIONS.includes(id)) {
				expect(others.length).toBeGreaterThan(0);
				return;
			}
			expect(others).toEqual([]);
		});
	}

	it("states which guarantees are exempt from the single-defect claim", () => {
		expect([...SINGLE_CRAFT_EXEMPTIONS]).toEqual([]);
	});
});

describe("a frame no row oracle can read", () => {
	it("skips every guarantee when there is nothing rendered", () => {
		const result = evaluateAllToolRenderOracles({ homeDir: HOME, forbiddenSequences: [INJECTED], renders: [] });
		expect([...result.skipped].sort()).toEqual([...TOOL_RENDER_ORACLE_GUARANTEES].sort());
		expect(result.blind).toEqual([]);
		expect(result.failures).toEqual([]);
	});

	it("skips every guarantee when the only render transmits an image", () => {
		const base = cleanSnapshot();
		const image: ToolRenderSnapshot = {
			...base,
			rawRows: ["\x1b_Gf=100,a=T;iVBORw0KGgo=\x1b\\"],
			plainRows: ["iVBORw0KGgo="],
			carriesBinaryPayload: true,
		};
		const result = evaluateAllToolRenderOracles({
			homeDir: HOME,
			forbiddenSequences: [INJECTED],
			renders: [image],
		});
		expect([...result.skipped].sort()).toEqual([...TOOL_RENDER_ORACLE_GUARANTEES].sort());
		expect(result.failures).toEqual([]);
	});

	it("stands the escape guarantee down when no sequence was injected", () => {
		const result = evaluateAllToolRenderOracles({ ...baselineFrameState(), forbiddenSequences: [] });
		expect(result.skipped).toContain("noContentSuppliedEscapeSurvives");
		expect(result.inspected).not.toContain("noContentSuppliedEscapeSurvives");
	});
});
