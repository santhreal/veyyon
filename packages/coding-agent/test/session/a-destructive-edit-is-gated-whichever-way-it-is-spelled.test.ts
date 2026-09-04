// WHY: the ACP permission gate is the only thing between a connected client and a tool call that
// deletes or moves a file without being asked. The edit tool reaches those two operations through
// three unrelated argument shapes — structured `edits` entries, a hashline patch in `input`, and an
// apply_patch envelope in that same field — and each is parsed by different code. A gate that
// understands one of them consents to the other two in silence, which is the class this closes:
// every spelling of a destructive edit produces an intent, and every spelling of a harmless one
// produces none.
//
// The gated tool set is swept from the exported constant rather than listed, so adding a tool to it
// without deciding what its prompt says turns this red.
//
// Not covered: what the client does with the intent. Asking, caching the answer under `cacheKey`
// and acting on it live in AgentSession, which owns the connection; this module only reads the
// arguments.

import { describe, expect, it } from "bun:test";
import {
	extractPermissionLocations,
	getEditDestructiveIntent,
	getPermissionIntent,
	PERMISSION_OPTIONS,
	PERMISSION_OPTIONS_BY_ID,
	PERMISSION_REQUIRED_TOOLS,
} from "../../src/session/agent-session-permissions";

/** The same delete, written the three ways the edit tool accepts it. */
const DELETE_SPELLINGS: Record<string, unknown> = {
	"structured edits entry": { path: "a.ts", edits: [{ op: "delete" }] },
	"hashline REM": { input: "[a.ts#A1B2]\nREM" },
	"apply_patch envelope": { input: "*** Begin Patch\n*** Delete File: a.ts\n*** End Patch" },
};

/** The same move, likewise. */
const MOVE_SPELLINGS: Record<string, unknown> = {
	"structured edits entry": { path: "a.ts", edits: [{ op: "swap", rename: "b.ts" }] },
	"hashline MV": { input: "[a.ts#A1B2]\nMV b.ts" },
};

describe("a destructive edit is gated whichever way it is spelled", () => {
	for (const [spelling, args] of Object.entries(DELETE_SPELLINGS)) {
		it(`reads a delete written as a ${spelling}`, () => {
			expect(getEditDestructiveIntent(args)).toEqual({ kind: "delete", paths: ["a.ts"] });
			expect(getPermissionIntent("edit", args)).toEqual({
				toolName: "edit",
				title: "Delete a.ts",
				paths: ["a.ts"],
				cacheKey: "edit:delete",
			});
		});
	}

	for (const [spelling, args] of Object.entries(MOVE_SPELLINGS)) {
		it(`reads a move written as a ${spelling}`, () => {
			expect(getEditDestructiveIntent(args)).toEqual({ kind: "move", paths: ["a.ts", "b.ts"] });
			expect(getPermissionIntent("edit", args)).toEqual({
				toolName: "edit",
				title: "Move a.ts to b.ts",
				paths: ["a.ts", "b.ts"],
				cacheKey: "edit:move",
			});
		});
	}

	it("keeps a delete and a move under separate cache keys", () => {
		// One "always allow" answer must not carry across. Consenting to a move is not consenting
		// to a delete, so the key an answer is remembered under has to distinguish them.
		const del = getPermissionIntent("edit", DELETE_SPELLINGS["structured edits entry"]);
		const move = getPermissionIntent("edit", MOVE_SPELLINGS["structured edits entry"]);
		expect(del?.cacheKey).not.toBe(move?.cacheKey);
	});

	it("asks for nothing when an edit only rewrites lines", () => {
		expect(getEditDestructiveIntent({ path: "a.ts", edits: [{ op: "swap" }] })).toBeUndefined();
		expect(getPermissionIntent("edit", { path: "a.ts", edits: [{ op: "swap" }] })).toBeUndefined();
	});

	it("does not read a create that names a destination as a move", () => {
		// `rename` on a create is where the new file goes, not a file being taken away.
		expect(getEditDestructiveIntent({ path: "a.ts", edits: [{ op: "create", rename: "b.ts" }] })).toBeUndefined();
	});

	it("asks for nothing when the input parses as neither patch dialect", () => {
		expect(getEditDestructiveIntent({ input: "just some prose" })).toBeUndefined();
	});

	it("survives arguments that are not a record at all", () => {
		for (const junk of [undefined, null, "text", 42, []]) {
			expect(getEditDestructiveIntent(junk)).toBeUndefined();
		}
	});
});

describe("the gate covers every tool it claims to", () => {
	it("gates exactly these four tools", () => {
		// Pinned by equality, not swept, because the sweep below only visits what is in the set:
		// dropping `edit` from it would ungate every destructive edit and leave that sweep green.
		// Adding a tool is red here until someone records it, and red below until it has a branch.
		expect([...PERMISSION_REQUIRED_TOOLS].sort()).toEqual(["bash", "delete", "edit", "move"]);
	});

	it("prompts for each gated tool, and each prompt names the operation", () => {
		// Swept from the exported set: a tool added to it without a branch in getPermissionIntent
		// would otherwise be gated and then wave itself through.
		const args: Record<string, unknown> = {
			bash: { command: "rm -rf /tmp/x" },
			edit: DELETE_SPELLINGS["structured edits entry"],
			delete: { path: "a.ts" },
			move: { oldPath: "a.ts", newPath: "b.ts" },
		};
		const unhandled: string[] = [];
		for (const tool of PERMISSION_REQUIRED_TOOLS) {
			const intent = getPermissionIntent(tool, args[tool]);
			if (intent === undefined || intent.title === tool) unhandled.push(tool);
		}
		expect(unhandled).toEqual([]);
	});

	it("prompts for nothing outside that set", () => {
		for (const tool of ["read", "search", "write", "task"]) {
			expect(getPermissionIntent(tool, { path: "a.ts", command: "x" })).toBeUndefined();
		}
	});

	it("truncates a long bash command so the prompt stays one line", () => {
		const intent = getPermissionIntent("bash", { command: "x".repeat(500) });
		expect(intent?.title).toHaveLength(80);
	});

	it("falls back to the tool name when the argument it titles with is missing", () => {
		// A malformed call still has to produce a prompt; a blank title would ask the user to
		// approve nothing in particular.
		expect(getPermissionIntent("bash", {})?.title).toBe("bash");
		expect(getPermissionIntent("delete", {})?.title).toBe("delete");
		expect(getPermissionIntent("move", {})?.title).toBe("move");
	});

	it("reads a move from any of the argument spellings the tools use", () => {
		for (const args of [
			{ oldPath: "a.ts", newPath: "b.ts" },
			{ from: "a.ts", to: "b.ts" },
			{ path: "a.ts", destination: "b.ts" },
		]) {
			expect(getPermissionIntent("move", args)?.paths).toEqual(["a.ts", "b.ts"]);
		}
	});

	it("offers four options, each resolvable by the id it is sent under", () => {
		// The client answers with an optionId, so an option that cannot be looked up again is an
		// answer the session cannot act on.
		expect(PERMISSION_OPTIONS.map(o => o.kind)).toEqual([
			"allow_once",
			"allow_always",
			"reject_once",
			"reject_always",
		]);
		for (const option of PERMISSION_OPTIONS) {
			expect(PERMISSION_OPTIONS_BY_ID.get(option.optionId)).toBe(option);
		}
	});
});

describe("the locations a prompt points at are absolute and distinct", () => {
	it("resolves a relative argument against the session cwd", () => {
		// The editor host opens these paths, and it cannot resolve one relative to a cwd it does
		// not share.
		expect(extractPermissionLocations({ path: "src/a.ts" }, "/repo")).toEqual([{ path: "/repo/src/a.ts" }]);
	});

	it("leaves an absolute argument alone", () => {
		expect(extractPermissionLocations({ path: "/elsewhere/a.ts" }, "/repo")).toEqual([{ path: "/elsewhere/a.ts" }]);
	});

	it("collapses the same file named twice under different keys", () => {
		expect(extractPermissionLocations({ path: "a.ts", file: "a.ts" }, "/repo")).toEqual([{ path: "/repo/a.ts" }]);
	});

	it("reads both ends of a move, in order", () => {
		expect(extractPermissionLocations({ oldPath: "a.ts", newPath: "b.ts" }, "/repo")).toEqual([
			{ path: "/repo/a.ts" },
			{ path: "/repo/b.ts" },
		]);
	});

	it("reads a list of paths as well as a single one", () => {
		expect(extractPermissionLocations({ paths: ["a.ts", "b.ts"] }, "/repo")).toEqual([
			{ path: "/repo/a.ts" },
			{ path: "/repo/b.ts" },
		]);
	});

	it("uses the explicit paths alone when the caller supplies them", () => {
		// The intent already worked out which files matter; re-scanning the raw arguments would
		// add ones it deliberately left out.
		expect(extractPermissionLocations({ path: "ignored.ts" }, "/repo", ["chosen.ts"])).toEqual([
			{ path: "/repo/chosen.ts" },
		]);
	});

	it("drops a non-string or empty path rather than sending it", () => {
		expect(extractPermissionLocations({ path: 42, file: "", paths: [null, "a.ts"] }, "/repo")).toEqual([
			{ path: "/repo/a.ts" },
		]);
	});

	it("returns nothing for arguments that are not an object", () => {
		for (const junk of [undefined, null, "text", 42]) {
			expect(extractPermissionLocations(junk, "/repo")).toEqual([]);
		}
	});
});
