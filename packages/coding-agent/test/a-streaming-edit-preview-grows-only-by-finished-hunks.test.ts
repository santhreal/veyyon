/**
 * WHY: the shared edit-preview producer decides what a tool card draws while a call's
 * arguments are still streaming. Three contracts: a free-form payload that is not JSON yet
 * is exposed as `input`, a removal hunk whose additions have not arrived stays hidden until
 * they do, and a tool that is not edit-like never gains preview fields. Stale-key dedupe and
 * abort-on-stop are asserted through the observable `onChange` count. Not covered: the
 * file-backed `replace`/`patch`/`hashline` strategies, which have their own suites.
 */
import { describe, expect, test } from "bun:test";
import { isEditLikeToolName, ToolCallPreview } from "../src/presentation/tool-call-preview";

function previewFor(
	toolName: string,
	args: unknown,
	mode?: "apply_patch",
): { preview: ToolCallPreview; changes: () => number } {
	let changes = 0;
	const preview = new ToolCallPreview(args, {
		toolName,
		mode,
		cwd: "/repo",
		onChange: () => {
			changes += 1;
		},
	});
	return { preview, changes: () => changes };
}

const envelope = (body: string) => `*** Begin Patch\n*** Update File: src/app.ts\n@@\n${body}`;

describe("a streaming edit preview grows only by finished hunks", () => {
	test("a tool that is not edit-like gets the streamed input but no edit mode or preview", async () => {
		expect(["edit", "apply_patch", "write", "bash"].filter(isEditLikeToolName)).toEqual(["edit", "apply_patch"]);
		const { preview, changes } = previewFor("bash", { __partialJson: "*** Begin" }, "apply_patch");
		preview.update({ __partialJson: envelope("-old\n+new\n") });
		await preview.whenSettled();
		expect(changes()).toBe(1);
		expect(preview.arguments).toEqual({ __partialJson: envelope("-old\n+new\n"), input: envelope("-old\n+new\n") });
	});

	test("a non-JSON partial payload is exposed as the input field with the edit mode attached", () => {
		const { preview } = previewFor("apply_patch", { __partialJson: envelope("-old\n") }, "apply_patch");
		expect(preview.arguments).toEqual({
			__partialJson: envelope("-old\n"),
			input: envelope("-old\n"),
			editMode: "apply_patch",
		});
		const { preview: json } = previewFor("apply_patch", { __partialJson: '{"input": "x' }, "apply_patch");
		expect(json.arguments).toEqual({ __partialJson: '{"input": "x', editMode: "apply_patch" });
	});

	test("a removal hunk waits for its additions before it is drawn", async () => {
		const { preview, changes } = previewFor("apply_patch", {}, "apply_patch");
		preview.update({ __partialJson: envelope("-old\n") });
		await preview.whenSettled();
		expect(changes()).toBe(1);
		expect(preview.arguments).not.toHaveProperty("previewDiff");

		preview.update({ __partialJson: envelope("-old\n+new\n-gone\n") });
		await preview.whenSettled();
		expect(changes()).toBe(2);
		expect(preview.arguments).toMatchObject({ previewDiff: "@@\n-old\n+new", preview: { diff: "@@\n-old\n+new" } });

		preview.update({ __partialJson: envelope("-old\n+new\n-gone\n+here\n") });
		await preview.whenSettled();
		expect(changes()).toBe(3);
		expect(preview.arguments).toMatchObject({ previewDiff: "@@\n-old\n+new\n-gone\n+here" });
	});

	test("an identical payload recomputes nothing and a trailing partial line is not drawn", async () => {
		const { preview, changes } = previewFor("apply_patch", {}, "apply_patch");
		preview.update({ __partialJson: envelope("-old\n+new\n") });
		await preview.whenSettled();
		preview.update({ __partialJson: envelope("-old\n+new\n") });
		await preview.whenSettled();
		expect(changes()).toBe(1);
		preview.update({ __partialJson: envelope("-old\n+new\n+partial") });
		await preview.whenSettled();
		expect(changes()).toBe(2);
		expect(preview.arguments).toMatchObject({ previewDiff: "@@\n-old\n+new" });
	});

	test("without an edit mode an update changes the arguments but computes nothing", async () => {
		const { preview, changes } = previewFor("apply_patch", {});
		preview.update({ __partialJson: envelope("-old\n+new\n") });
		await preview.whenSettled();
		expect(changes()).toBe(0);
		expect(preview.arguments).toEqual({ __partialJson: envelope("-old\n+new\n"), input: envelope("-old\n+new\n") });
	});
});
