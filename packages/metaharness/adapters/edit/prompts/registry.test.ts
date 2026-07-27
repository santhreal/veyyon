/**
 * The edit benchmark's prompts are a registry, and the registry is complete.
 *
 * WHY THIS SUITE EXISTS. These three prompts decide what every scored run is asked to
 * do, so a change to one moves every number the harness reports while the code that
 * produced them is untouched. They were imported by relative path from `runner.ts` and
 * appeared in no list, which is how a benchmark ends up unable to say what it asked the
 * model.
 *
 * The checks are the same two the product registries get, for the same reasons: the set
 * on disk and the set in the registry must agree in BOTH directions (a file with no row
 * is a prompt nothing sends, a row with no file is a row describing a document that is
 * not there), and each row must hold its own file's bytes rather than a copy that
 * drifted. A row wired to the wrong import typechecks and renders, and the run would be
 * scored against the wrong task.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { prompt } from "@veyyon/utils";
import { EDIT_BENCHMARK_PROMPTS, editBenchmarkPrompts } from "./registry";

const PROMPTS_DIR = import.meta.dir;

/** Every `.md` beside this registry, as the id it would be registered under. */
async function idsOnDisk(): Promise<string[]> {
	const found: string[] = [];
	const glob = new Bun.Glob("**/*.md");
	for await (const relative of glob.scan({ cwd: PROMPTS_DIR, onlyFiles: true })) {
		found.push(relative.replace(/\\/g, "/").slice(0, -".md".length));
	}
	return found.sort();
}

describe("the edit benchmark's prompt registry", () => {
	it("registers exactly the files on disk, no more and no fewer", async () => {
		// Compared as `string[]` on both sides. The ids are a literal union, so the
		// narrower type would make the expected value have to be that union too, and a
		// file on disk with no row could then not be expressed at all.
		const registered: string[] = [...editBenchmarkPrompts.ids];

		expect(registered.sort()).toEqual(await idsOnDisk());
	});

	it("finds prompts at all, so the comparison is not two empty sets", async () => {
		// Both sides going empty would pass forever while proving nothing, which is
		// exactly how a coverage check rots.
		const onDisk = await idsOnDisk();

		expect(onDisk.length).toBe(3);
		expect(editBenchmarkPrompts.ids.length).toBe(onDisk.length);
	});

	it("holds each file's own bytes in its row", async () => {
		// The row's text must BE the file. A row wired to the wrong import still
		// typechecks and still renders, and the benchmark would then score a model
		// against a task it was never given.
		for (const id of editBenchmarkPrompts.ids) {
			const onDisk = await Bun.file(path.join(PROMPTS_DIR, `${id}.md`)).text();

			expect(EDIT_BENCHMARK_PROMPTS[id].text, `${id} does not hold its own file's bytes`).toBe(onDisk);
		}
	});

	it("gives every prompt a purpose that says something", () => {
		for (const id of editBenchmarkPrompts.ids) {
			const purpose = EDIT_BENCHMARK_PROMPTS[id].purpose;

			expect(purpose.length, `${id} has no usable purpose`).toBeGreaterThan(15);
			expect(purpose, `${id}'s purpose just repeats its id`).not.toBe(id);
		}
	});

	it("has an analyzable variable contract for every prompt", () => {
		// All three are Handlebars templates rendered against run state. A template that
		// cannot be parsed cannot be checked for holes either, so an unanalyzable row
		// hides a missing-variable bug that reaches the model as a literal `{{task}}`.
		for (const id of editBenchmarkPrompts.ids) {
			const analysis = prompt.analyzePromptTemplate(EDIT_BENCHMARK_PROMPTS[id].text);

			expect(Array.isArray(analysis.required), `${id} has no readable variable contract`).toBe(true);
			expect(Array.isArray(analysis.optional), `${id} has no readable variable contract`).toBe(true);
		}
	});

	it("asks the task prompt for the task, which is the variable that matters", () => {
		// Not a shape check: `benchmark-task` exists to carry the case's task text, and a
		// template that stopped referencing it would render a well-formed prompt asking
		// for nothing, and the model's confusion would be scored as a failure.
		const analysis = prompt.analyzePromptTemplate(EDIT_BENCHMARK_PROMPTS["benchmark-task"].text);
		const named = [...analysis.required, ...analysis.optional].map(variable => variable.name);

		expect(named).toContain("task_prompt");
	});
});

describe("looking a benchmark prompt up by an id held in a variable", () => {
	// Through the descriptor, which is what a consumer holds; the package-specific alias it
	// used to export was the same value under a second name.
	it("returns the registered row", () => {
		expect(editBenchmarkPrompts.require("benchmark-system")).toBe(EDIT_BENCHMARK_PROMPTS["benchmark-system"]);
	});

	it("throws on an unknown id rather than scoring a run with no brief", () => {
		// An empty system prompt still produces a run and still produces a score, and
		// the score is then attributed to the model rather than to the missing brief.
		expect(() => editBenchmarkPrompts.require("benchmark-sistem")).toThrow(
			/unknown prompt "benchmark-sistem" in packages\/metaharness\/adapters\/edit\/prompts/,
		);
	});

	it("names the near miss", () => {
		expect(() => editBenchmarkPrompts.require("benchmark-sistem")).toThrow(/Did you mean "benchmark-system"/);
	});
});
