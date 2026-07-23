import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ArgotConflictError } from "../src/codec.js";
import { ArgotParseError } from "../src/parse.js";
import { ArgotSession } from "../src/session.js";
import type { Vocabulary } from "../src/types.js";

function vocab(entries: Record<string, string>, sigil = "§"): Vocabulary {
	return { version: 1, sigil, handles: new Map(Object.entries(entries)), meta: new Map() };
}

const DICT = `version = 1
[handles]
dbconn = "packages/server/src/database/connection.ts"
`;

const TSC_DICT = `version = 1
[handles]
tsc = "bunx tsgo --noEmit"
`;

describe("ArgotSession: load-on-read", () => {
	test("carries the fixed preamble and is inert before any read", () => {
		const argot = new ArgotSession();
		expect(argot.preamble).toContain("AGENTS.dict");
		expect(argot.loaded).toBe(false);
		expect(argot.expand("§dbconn stays")).toBe("§dbconn stays");
	});

	test("arms the codec when it observes an AGENTS.dict read", () => {
		const argot = new ArgotSession();
		const loaded = argot.observe("/some/project/AGENTS.dict", DICT);
		expect(loaded).toBe(true);
		expect(argot.loaded).toBe(true);
		expect(argot.expand("open §dbconn")).toBe("open packages/server/src/database/connection.ts");
	});

	test("matches on the file name, wherever the project lives", () => {
		const argot = new ArgotSession();
		expect(argot.observe(join("/home/me/work/monorepo", "AGENTS.dict"), DICT)).toBe(true);
		expect(argot.expand("§dbconn")).toBe("packages/server/src/database/connection.ts");
	});

	test("ignores any other file the agent reads", () => {
		const argot = new ArgotSession();
		expect(argot.observe("/project/src/index.ts", "const x = 1;")).toBe(false);
		expect(argot.observe("/project/AGENTS.md", "# guidance")).toBe(false);
		expect(argot.loaded).toBe(false);
		expect(argot.expand("§dbconn")).toBe("§dbconn");
	});

	test("throws on a malformed dictionary instead of arming an empty codec", () => {
		const argot = new ArgotSession();
		expect(() => argot.observe("/project/AGENTS.dict", "version = 1\n[handles]\n")).toThrow(ArgotParseError);
		expect(argot.loaded).toBe(false);
	});

	test("observing two projects unions their vocabularies", () => {
		// A session that reads a dictionary in two directories should expand handles
		// from both, keyed by directory so neither displaces the other.
		const argot = new ArgotSession();
		argot.observe("/a/AGENTS.dict", DICT);
		argot.observe("/b/AGENTS.dict", TSC_DICT);
		expect(argot.expand("§dbconn and §tsc")).toBe(
			"packages/server/src/database/connection.ts and bunx tsgo --noEmit",
		);
	});

	test("re-observing the same directory replaces that directory's vocabulary", () => {
		// The directory is the key, so a second read of the same AGENTS.dict swaps
		// its handles rather than accumulating stale ones.
		const argot = new ArgotSession();
		argot.observe("/a/AGENTS.dict", DICT);
		argot.observe("/a/AGENTS.dict", TSC_DICT);
		expect(argot.expand("§tsc")).toBe("bunx tsgo --noEmit");
		expect(argot.expand("§dbconn")).toBe("§dbconn");
	});

	test("a later malformed read throws and leaves the loaded vocabulary intact", () => {
		// State integrity: a bad dictionary must not wipe a good one already armed.
		const argot = new ArgotSession();
		argot.observe("/a/AGENTS.dict", DICT);
		expect(() => argot.observe("/b/AGENTS.dict", "version = 1\n[handles]\n")).toThrow(ArgotParseError);
		expect(argot.loaded).toBe(true);
		expect(argot.expand("§dbconn")).toBe("packages/server/src/database/connection.ts");
	});

	test("matches the file name exactly and ignores near-miss names", () => {
		const argot = new ArgotSession();
		expect(argot.observe("/p/AGENTS.dict.bak", DICT)).toBe(false);
		expect(argot.observe("/p/agents.dict", DICT)).toBe(false);
		expect(argot.observe("/p/my-AGENTS.dict", DICT)).toBe(false);
		expect(argot.loaded).toBe(false);
	});
});

describe("ArgotSession: cache flow (loadVocab)", () => {
	test("loadVocab arms the codec from a vocabulary without a file read", () => {
		const argot = new ArgotSession();
		argot.loadVocab(vocab({ dbconn: "packages/server/src/database/connection.ts" }));
		expect(argot.loaded).toBe(true);
		expect(argot.expand("open §dbconn")).toBe("open packages/server/src/database/connection.ts");
	});

	test("promptFragment is empty until a dictionary is loaded", () => {
		expect(new ArgotSession().promptFragment()).toBe("");
	});

	test("promptFragment lists the handles armed through loadVocab", () => {
		const argot = new ArgotSession();
		argot.loadVocab(vocab({ dbconn: "packages/server/src/database/connection.ts" }));
		const fragment = argot.promptFragment();
		expect(fragment).toContain("§dbconn");
		expect(fragment).toContain("packages/server/src/database/connection.ts");
	});

	test("loadVocab with an empty vocabulary re-arms the inert codec", () => {
		const argot = new ArgotSession();
		argot.loadVocab(vocab({ dbconn: "packages/server/src/database/connection.ts" }));
		argot.loadVocab(vocab({}));
		expect(argot.loaded).toBe(false);
		expect(argot.expand("§dbconn")).toBe("§dbconn");
		expect(argot.promptFragment()).toBe("");
	});

	test("loadVocab discards everything loaded before it", () => {
		// loadVocab is the single-project reset, distinct from keyed load: after it,
		// only its one vocabulary is active.
		const argot = new ArgotSession();
		argot.load("keyhog", vocab({ tsc: "bunx tsgo --noEmit" }));
		argot.loadVocab(vocab({ dbconn: "packages/server/src/database/connection.ts" }));
		expect(argot.expand("§dbconn")).toBe("packages/server/src/database/connection.ts");
		expect(argot.expand("§tsc")).toBe("§tsc");
	});
});

describe("ArgotSession: keyed multi-project load and unload", () => {
	const DB = vocab({ dbconn: "packages/server/src/database/connection.ts" });
	const TSC = vocab({ tsc: "bunx tsgo --noEmit" });

	test("load keys several projects and unions them for decode and teach", () => {
		const argot = new ArgotSession();
		argot.load("server", DB);
		argot.load("build", TSC);
		expect(argot.expand("§dbconn then §tsc")).toBe(
			"packages/server/src/database/connection.ts then bunx tsgo --noEmit",
		);
		const fragment = argot.promptFragment();
		expect(fragment).toContain("§dbconn");
		expect(fragment).toContain("§tsc");
	});

	test("unload stops teaching a project but keeps decoding it", () => {
		// A handle already written must keep expanding after its project is
		// unloaded; only the teaching (promptFragment) stops.
		const argot = new ArgotSession();
		argot.load("server", DB);
		argot.load("build", TSC);
		expect(argot.unload("server")).toBe(true);
		// Decode is unconditional: dbconn still expands.
		expect(argot.expand("§dbconn")).toBe("packages/server/src/database/connection.ts");
		// Teach dropped it: the fragment no longer advertises dbconn, but still tsc.
		const fragment = argot.promptFragment();
		expect(fragment).not.toContain("§dbconn");
		expect(fragment).toContain("§tsc");
		// The session is still loaded (decode-active) after an unload.
		expect(argot.loaded).toBe(true);
	});

	test("unload returns false for an absent or already-unloaded key", () => {
		const argot = new ArgotSession();
		argot.load("server", DB);
		expect(argot.unload("missing")).toBe(false);
		expect(argot.unload("server")).toBe(true);
		expect(argot.unload("server")).toBe(false);
	});

	test("load with teach: false decodes without teaching", () => {
		const argot = new ArgotSession();
		argot.load("server", DB, { teach: false });
		expect(argot.expand("§dbconn")).toBe("packages/server/src/database/connection.ts");
		expect(argot.promptFragment()).toBe("");
	});

	test("re-loading a key replaces only that key", () => {
		const argot = new ArgotSession();
		argot.load("server", DB);
		argot.load("build", TSC);
		argot.load("server", vocab({ migr: "packages/server/src/database/migrations" }));
		expect(argot.expand("§dbconn")).toBe("§dbconn");
		expect(argot.expand("§migr")).toBe("packages/server/src/database/migrations");
		expect(argot.expand("§tsc")).toBe("bunx tsgo --noEmit");
	});
});

describe("ArgotSession: vocabulary() reports the combined decode set", () => {
	const DB = vocab({ dbconn: "packages/server/src/database/connection.ts" });
	const TSC = vocab({ tsc: "bunx tsgo --noEmit" });

	test("an unloaded session reports an empty vocabulary", () => {
		const argot = new ArgotSession();
		const v = argot.vocabulary();
		expect(v.handles.size).toBe(0);
	});

	test("unions every loaded project's handles, matching what expand decodes", () => {
		const argot = new ArgotSession();
		argot.load("server", DB);
		argot.load("build", TSC);
		const v = argot.vocabulary();
		expect(v.handles.get("dbconn")).toBe("packages/server/src/database/connection.ts");
		expect(v.handles.get("tsc")).toBe("bunx tsgo --noEmit");
		expect(v.handles.size).toBe(2);
	});

	test("includes decode-only (teach: false) handles, since decode covers them", () => {
		const argot = new ArgotSession();
		argot.load("server", DB, { teach: false });
		expect(argot.vocabulary().handles.get("dbconn")).toBe("packages/server/src/database/connection.ts");
	});
});

describe("ArgotSession: conflicting loads fail loud", () => {
	test("a shared handle name with a different expansion throws and preserves state", () => {
		const argot = new ArgotSession();
		argot.load("a", vocab({ x: "one/path.ts" }));
		expect(() => argot.load("b", vocab({ x: "another/path.ts" }))).toThrow(ArgotConflictError);
		// The good state survives the rejected load.
		expect(argot.expand("§x")).toBe("one/path.ts");
	});

	test("the same handle bound to the same expansion is deduplicated, not a conflict", () => {
		const argot = new ArgotSession();
		argot.load("a", vocab({ x: "same/path.ts" }));
		expect(() => argot.load("b", vocab({ x: "same/path.ts" }))).not.toThrow();
		expect(argot.expand("§x")).toBe("same/path.ts");
	});

	test("different sigils across projects cannot be combined", () => {
		const argot = new ArgotSession();
		argot.load("a", vocab({ x: "one/path.ts" }, "§"));
		expect(() => argot.load("b", vocab({ y: "two/path.ts" }, "@"))).toThrow(ArgotConflictError);
	});
});

describe("ArgotSession: fork for subagent inherit", () => {
	const DB = vocab({ dbconn: "packages/server/src/database/connection.ts" });
	const TSC = vocab({ tsc: "bunx tsgo --noEmit" });

	test("a fork starts knowing everything the parent had loaded", () => {
		const parent = new ArgotSession();
		parent.load("server", DB);
		parent.load("build", TSC);
		const child = parent.fork();
		expect(child.expand("§dbconn and §tsc")).toBe(
			"packages/server/src/database/connection.ts and bunx tsgo --noEmit",
		);
		expect(child.promptFragment()).toContain("§dbconn");
	});

	test("a fork carries the teach flags, not just the vocabularies", () => {
		// unload flips a key to decode-only; the fork must reproduce that, or an
		// inherited child would start re-teaching a project the parent had retired.
		const parent = new ArgotSession();
		parent.load("server", DB);
		parent.load("build", TSC);
		parent.unload("server");
		const child = parent.fork();
		expect(child.expand("§dbconn")).toBe("packages/server/src/database/connection.ts");
		expect(child.promptFragment()).not.toContain("§dbconn");
		expect(child.promptFragment()).toContain("§tsc");
	});

	test("the child is detached: loading in the child never reaches the parent", () => {
		const parent = new ArgotSession();
		parent.load("server", DB);
		const child = parent.fork();
		child.load("build", TSC);
		// The child sees both; the parent still sees only its own.
		expect(child.expand("§tsc")).toBe("bunx tsgo --noEmit");
		expect(parent.expand("§tsc")).toBe("§tsc");
	});

	test("the child is detached: the parent's later changes never reach the child", () => {
		const parent = new ArgotSession();
		parent.load("server", DB);
		const child = parent.fork();
		parent.load("build", TSC);
		expect(parent.expand("§tsc")).toBe("bunx tsgo --noEmit");
		expect(child.expand("§tsc")).toBe("§tsc");
	});

	test("forking an inert session yields an inert session", () => {
		const child = new ArgotSession().fork();
		expect(child.loaded).toBe(false);
		expect(child.expand("§dbconn")).toBe("§dbconn");
	});
});
