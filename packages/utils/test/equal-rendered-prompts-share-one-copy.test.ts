/**
 * Equal strings that pass through `internString`, and so every `prompt.render` result, share one
 * buffer, and an interned string is still collected with its last holder.
 *
 * WHY: forty live spawned agents each held their own copy of the same rendered tool descriptions
 * and system prompt sections, about 220 KiB apiece. The class is "equal text rendered twice is held
 * twice": `render` is the choke point every tool description and prompt section passes through, so
 * the suite measures there as well as at the helper.
 *
 * String bytes are read in a fresh process (`fixtures/interned-string-growth.ts`): in the test runner,
 * garbage the files run before this one left behind is freed inside the measured window and moved the
 * plain arm by more than its own 2.5 MiB. The plain arm, holding the same number of separately built
 * copies, proves the measurement sees them, and the interned arms must hold under a tenth of that.
 *
 * NOT CAUGHT: text built by concatenating rendered pieces outside `render` is a new string and is
 * not interned here; the agent interns its system prompt parts for that case.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { internString } from "../src/strings";
import { CHARS, COPIES, type InternGrowth } from "./fixtures/interned-string-growth";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "fixtures", "interned-string-growth.ts");

/** Twenty heap snapshots of a process that loads only the prompt module. */
const MEASURED_TIMEOUT_MS = 60_000;

let growth: InternGrowth;

beforeAll(async () => {
	const { stdout, stderr } = await run(process.execPath, [FIXTURE], {
		timeout: MEASURED_TIMEOUT_MS - 5_000,
		killSignal: "SIGKILL",
	});
	expect(stderr).toBe("");
	growth = JSON.parse(stdout) as InternGrowth;
}, MEASURED_TIMEOUT_MS);

describe("internString", () => {
	it("holds equal strings built separately as one copy", () => {
		expect(growth.plain).toBeGreaterThan((COPIES / 2) * CHARS);
		expect(growth.interned).toBeLessThan(growth.plain / 10);
	});

	it("lets an interned string go when its last holder drops it", () => {
		expect(growth.dropped).toBeLessThan(4 * CHARS);
	});

	it("returns every value unchanged, including ones a property key treats specially", () => {
		for (const value of [
			"",
			"__proto__",
			"constructor",
			"0",
			"123",
			"4294967295",
			"-1",
			"1.5",
			"é\u{1f600}",
			"\ud800",
		]) {
			expect(internString(value)).toBe(value);
		}
	});
});

describe("render", () => {
	it("holds equal renders of one template as one copy", () => {
		expect(growth.renderWithVariables).toBeLessThan(growth.plain / 10);
	});

	it("holds equal renders of a template with no variables as one copy", () => {
		expect(growth.renderStatic).toBeLessThan(growth.plain / 10);
	});
});
