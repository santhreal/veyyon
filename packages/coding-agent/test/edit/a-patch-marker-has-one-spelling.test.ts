/**
 * The apply-patch envelope vocabulary is spelled in one place.
 *
 * WHY THIS EXISTS. A patch envelope is a plain-text protocol: a model writes exact strings
 * like `*** Begin Patch` and `*** Update File:` and the parser reads them back. Three
 * modules under `src/edit/` needed those strings and each carried its own copy.
 * `apply-patch/parser.ts` declared `BEGIN_PATCH_MARKER` and `END_PATCH_MARKER` as private
 * constants while its own sibling `streaming.ts` imported the same two names from
 * `@veyyon/hashline`, and `diff.ts` wrote every marker out as an inline literal, the file
 * operations twice over.
 *
 * WHAT DRIFT WOULD HAVE COST. Nothing raises an error when two copies of a protocol
 * string disagree. The parser simply stops recognising the envelope, so every patch fails
 * to apply and the failure points at the patch rather than at the constant.
 *
 * THE SPELLINGS ALSO DISAGREED ALREADY. `parser.ts` wrote the file operations with a
 * trailing space (`"*** Add File: "`) and `diff.ts` without, and both trimmed whatever
 * followed, so the space was load-bearing in exactly one of them: `*** Add File:src/a.ts`
 * parsed in `diff.ts` and was rejected by `parser.ts`. One spelling now, the lenient one,
 * and the tests below pin both forms.
 */

import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import { ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER } from "@veyyon/hashline";
import {
	ADD_FILE_MARKER,
	DELETE_FILE_MARKER,
	EOF_MARKER,
	FILE_OP_MARKERS,
	MOVE_TO_MARKER,
	PATCH_WRAPPER_MARKERS,
	UPDATE_FILE_MARKER,
	BEGIN_PATCH_MARKER as REEXPORTED_BEGIN,
	END_PATCH_MARKER as REEXPORTED_END,
	ABORT_MARKER as REEXPORTED_ABORT,
} from "../../src/edit/apply-patch/markers";
import { parseApplyPatch } from "../../src/edit/apply-patch/parser";

const EDIT_SRC = path.join(import.meta.dir, "..", "..", "src", "edit");

/** Every `.ts` file under `src/edit`. */
async function editSources(dir: string = EDIT_SRC): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await editSources(full)));
		else if (entry.name.endsWith(".ts")) found.push(full);
	}
	return found;
}

describe("the markers carry the protocol's real strings", () => {
	/**
	 * Real values, not internal agreement. Every module importing one wrong constant
	 * agrees with itself perfectly and speaks a protocol no model writes.
	 */
	it("are the exact envelope strings", () => {
		expect(BEGIN_PATCH_MARKER).toBe("*** Begin Patch");
		expect(END_PATCH_MARKER).toBe("*** End Patch");
		expect(ABORT_MARKER).toBe("*** Abort");
		expect(ADD_FILE_MARKER).toBe("*** Add File:");
		expect(DELETE_FILE_MARKER).toBe("*** Delete File:");
		expect(UPDATE_FILE_MARKER).toBe("*** Update File:");
		expect(MOVE_TO_MARKER).toBe("*** Move to:");
		expect(EOF_MARKER).toBe("*** End of File");
	});

	/**
	 * The envelope markers are hashline's, re-exported rather than restated. If the
	 * re-export ever became a second declaration the values would still look right here,
	 * so identity with hashline's own export is the thing worth asserting.
	 */
	it("re-export hashline's three rather than redeclaring them", () => {
		expect(REEXPORTED_BEGIN).toBe(BEGIN_PATCH_MARKER);
		expect(REEXPORTED_END).toBe(END_PATCH_MARKER);
		expect(REEXPORTED_ABORT).toBe(ABORT_MARKER);
	});

	/** No trailing space on any of them, which is the drift the unification removed. */
	it("carry no trailing whitespace", () => {
		for (const marker of [ADD_FILE_MARKER, DELETE_FILE_MARKER, UPDATE_FILE_MARKER, MOVE_TO_MARKER]) {
			expect(marker, `${marker} should not end in a space`).toBe(marker.trimEnd());
		}
	});

	/** The grouped lists are the file operations and the wrappers, and nothing else. */
	it("group the file operations and the wrappers", () => {
		expect([...FILE_OP_MARKERS]).toEqual([UPDATE_FILE_MARKER, ADD_FILE_MARKER, DELETE_FILE_MARKER]);
		expect([...PATCH_WRAPPER_MARKERS]).toEqual([BEGIN_PATCH_MARKER, END_PATCH_MARKER]);
	});

	/**
	 * `diff --git ` is git's marker, not part of this envelope. It is deliberately absent
	 * so a caller that accepts both adds it explicitly rather than inheriting it.
	 */
	it("do not include git's own file marker", () => {
		expect([...FILE_OP_MARKERS]).not.toContain("diff --git ");
	});
});

describe("the parser reads both spellings of a file operation", () => {
	/**
	 * The ordinary form, with the space a model usually writes. This is what worked
	 * before and must keep working.
	 */
	it("parses an update marker written with a space", () => {
		const patch = parseApplyPatch(
			["*** Begin Patch", "*** Update File: src/a.ts", "@@", "-old", "+new", "*** End Patch"].join("\n"),
		);

		expect(patch.length).toBe(1);
		expect(patch[0]?.path).toBe("src/a.ts");
	});

	/**
	 * THE regression the unified spelling fixes. `diff.ts` already understood this form
	 * and `parser.ts` rejected it, so the same patch text meant two things depending on
	 * which module read it.
	 */
	it("parses an update marker written without a space", () => {
		const patch = parseApplyPatch(
			["*** Begin Patch", "*** Update File:src/a.ts", "@@", "-old", "+new", "*** End Patch"].join("\n"),
		);

		expect(patch.length).toBe(1);
		expect(patch[0]?.path).toBe("src/a.ts");
	});

	/** Extra spaces after the marker are trimmed, as they always were. */
	it("trims a path written with extra spaces", () => {
		const patch = parseApplyPatch(
			["*** Begin Patch", "*** Update File:    src/a.ts  ", "@@", "-old", "+new", "*** End Patch"].join("\n"),
		);

		expect(patch[0]?.path).toBe("src/a.ts");
	});

	/** The add operation takes the same two spellings. */
	it("parses an add marker in both spellings", () => {
		const withSpace = parseApplyPatch(["*** Begin Patch", "*** Add File: new.ts", "+hello", "*** End Patch"].join("\n"));
		const withoutSpace = parseApplyPatch(["*** Begin Patch", "*** Add File:new.ts", "+hello", "*** End Patch"].join("\n"));

		expect(withSpace[0]?.path).toBe("new.ts");
		expect(withoutSpace[0]?.path).toBe("new.ts");
	});

	/** And so does the delete operation. */
	it("parses a delete marker in both spellings", () => {
		const withSpace = parseApplyPatch(["*** Begin Patch", "*** Delete File: gone.ts", "*** End Patch"].join("\n"));
		const withoutSpace = parseApplyPatch(["*** Begin Patch", "*** Delete File:gone.ts", "*** End Patch"].join("\n"));

		expect(withSpace[0]?.path).toBe("gone.ts");
		expect(withoutSpace[0]?.path).toBe("gone.ts");
	});

	/**
	 * A line that merely starts with the same words is not a marker. Loosening the
	 * spelling must not loosen what counts as an envelope line.
	 */
	it("does not treat prose as a file operation", () => {
		expect(() => parseApplyPatch(["*** Begin Patch", "Update File: src/a.ts", "*** End Patch"].join("\n"))).toThrow();
	});
});

describe("no module keeps its own copy", () => {
	/**
	 * The structural lock. Value assertions prove the copies agree TODAY; only a source
	 * lock stops a fourth copy from being pasted in tomorrow, which is how three of them
	 * came to exist. Any `"*** "` envelope literal outside the owner is a copy.
	 */
	it("only markers.ts spells an envelope marker", async () => {
		const files = await editSources();
		// NON-VACUITY: the walk really read the directory.
		expect(files.length).toBeGreaterThan(10);

		const literal = /"\*\*\* (?:Begin Patch|End Patch|Abort|Add File|Delete File|Update File|Move to|End of File)/;
		const offenders: string[] = [];
		for (const file of files) {
			const text = await readFile(file, "utf8");
			const rel = path.relative(EDIT_SRC, file);
			if (rel === path.join("apply-patch", "markers.ts")) continue;
			// Code only: a marker named in a doc comment documents the constant.
			const code = text
				.split("\n")
				.filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
				.join("\n");
			if (literal.test(code)) offenders.push(rel);
		}

		expect(offenders, "an envelope marker literal — import it from ./apply-patch/markers instead").toEqual([]);
	});

	/**
	 * The lock above is only meaningful if the file it exempts still declares the
	 * markers. An exemption for a file that stopped declaring them is a hole that opens
	 * quietly, ready to excuse a copy that lands at that path later.
	 */
	it("and markers.ts really still declares them", async () => {
		const text = await readFile(path.join(EDIT_SRC, "apply-patch", "markers.ts"), "utf8");

		expect(text).toInclude('"*** Add File:"');
		expect(text).toInclude('"*** Delete File:"');
		expect(text).toInclude('"*** Update File:"');
		expect(text).toInclude('"*** Move to:"');
		expect(text).toInclude('"*** End of File"');
	});
});
