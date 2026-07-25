/**
 * An LSP config file that cannot be used says so, instead of looking like no config at all.
 *
 * WHY THIS SUITE EXISTS. `readConfigFile` was `try { ... } catch { return null }`. Config discovery
 * probes upwards of fifty candidate paths, nearly all absent, and every one of them returns null —
 * so a JSON typo in the `lsp.json` a user just wrote was indistinguishable from that file not
 * existing. The servers they configured never started, no error was printed anywhere, and `/lsp`
 * reported the project as having no configuration. The user's next move is to conclude LSP does not
 * work in this project, which is the invisible failure Law 10 is about: the operation "succeeded"
 * and the configured capability quietly went missing.
 *
 * The same catch covered the plugin-marketplace path, where a malformed `marketplace.json` dropped
 * every LSP server a plugin declares, and it also swallowed the `pathIsWithin` refusal for a plugin
 * whose config path escapes its own directory — a security-relevant refusal that no one could see.
 *
 * These tests are built around one distinction: ABSENT is silent, PRESENT-AND-BROKEN is loud. Both
 * halves matter. Warning on absence would print fifty lines on every start and train everyone to
 * ignore the warning that counts, so the quiet cases are pinned just as hard as the loud ones.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "@veyyon/coding-agent/lsp/config";
import { logger } from "@veyyon/utils";

/**
 * A real directory per test, because `loadConfig` reads the filesystem by path and the
 * behaviour under test IS the filesystem error code that comes back. Outside the repo so a
 * stray `lsp.json` cannot be picked up by anything else, and outside `~` so the real-data
 * tripwire has nothing to object to.
 */
let cwd: string;
let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

/** Warnings about the config FILE, dropping the per-server field validation that already existed. */
function configWarnings(): Array<{ message: string; fields: Record<string, unknown> }> {
	return warnings.filter(entry => entry.message.startsWith("LSP config file"));
}

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-lsp-config-"));
	// A marker file so the project looks like a real Node project; without one, root-marker
	// detection short-circuits before any server would be considered.
	fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture" }));
	warnings = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields: fields ?? {} });
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(cwd, { recursive: true, force: true });
});

describe("a config file that does not parse", () => {
	it("is reported with its path and the parser's own message", () => {
		// The path is the whole point: fifty candidates were probed and the user needs to know
		// WHICH file they broke. The parser message is what tells them where in it.
		fs.writeFileSync(path.join(cwd, "lsp.json"), '{ "servers": { "ts": { "command": "x" }, }');

		loadConfig(cwd);

		const reported = configWarnings();
		expect(reported.length).toBe(1);
		expect(reported[0]?.message).toBe("LSP config file could not be parsed; ignoring it.");
		expect(reported[0]?.fields.path).toBe(path.join(cwd, "lsp.json"));
		// The parser's own words, not a rewritten summary: they name the token and position,
		// which is the part that actually tells the user where to look.
		expect(reported[0]?.fields.error).toBe("JSON Parse error: Property name must be a string literal");
	});

	it("is reported for a YAML config too, not only JSON", () => {
		// The two parsers are chosen by extension, and only one of them was ever exercised by
		// hand. A silent YAML failure is the same bug wearing a different suffix.
		fs.writeFileSync(path.join(cwd, "lsp.yaml"), "servers:\n  ts:\n    command: [unclosed\n");

		loadConfig(cwd);

		expect(configWarnings().map(entry => entry.message)).toEqual([
			"LSP config file could not be parsed; ignoring it.",
		]);
		expect(configWarnings()[0]?.fields.path).toBe(path.join(cwd, "lsp.yaml"));
	});

	it("does not stop the other config sources from loading", () => {
		// Non-fatal on purpose: one broken file in one of fifty locations must not take out a
		// perfectly good one somewhere else. Both are read, and only the broken one is named.
		fs.writeFileSync(path.join(cwd, "lsp.json"), "not json at all");
		fs.mkdirSync(path.join(cwd, ".veyyon"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".veyyon", "lsp.json"),
			JSON.stringify({
				servers: { fixture: { command: "node", fileTypes: ["ts"], rootMarkers: ["package.json"] } },
			}),
		);

		const config = loadConfig(cwd);

		expect(configWarnings().map(entry => entry.fields.path)).toEqual([path.join(cwd, "lsp.json")]);
		// The good override took effect: `node` resolves, so the server is available rather
		// than merely declared.
		expect(config.servers.fixture?.command).toBe("node");
	});
});

describe("a config file that parses to the wrong shape", () => {
	it("is reported when it is not an object", () => {
		// `normalizeConfig` returns null for anything that is not a record. A top-level array
		// is the natural mistake ("a list of servers"), and it silently did nothing.
		fs.writeFileSync(path.join(cwd, "lsp.json"), JSON.stringify([{ command: "x" }]));

		loadConfig(cwd);

		expect(configWarnings().map(entry => entry.message)).toEqual([
			"LSP config file does not contain a server map; ignoring it.",
		]);
	});

	it("is reported for a bare string, which YAML makes easy to produce", () => {
		fs.writeFileSync(path.join(cwd, "lsp.yml"), "just-a-string\n");

		loadConfig(cwd);

		expect(configWarnings().map(entry => entry.message)).toEqual([
			"LSP config file does not contain a server map; ignoring it.",
		]);
	});
});

describe("a config file that exists but cannot be read", () => {
	it("is reported rather than treated as absent", () => {
		// A directory where a file is expected. It is not "no config here" — it is a mistake
		// that leaves the config permanently ineffective, so it gets a line.
		fs.mkdirSync(path.join(cwd, "lsp.json"));

		loadConfig(cwd);

		const reported = configWarnings();
		expect(reported.length).toBe(1);
		expect(reported[0]?.message).toBe("LSP config file exists but could not be read; ignoring it.");
		expect(reported[0]?.fields.path).toBe(path.join(cwd, "lsp.json"));
	});
});

describe("the absent and the healthy cases", () => {
	it("say nothing when no config file exists anywhere", () => {
		// The load-bearing negative. Fifty-odd candidate paths are probed on every start; a
		// warning per miss would bury the one warning that means something.
		loadConfig(cwd);

		expect(configWarnings()).toEqual([]);
	});

	it("say nothing when the config is valid", () => {
		fs.writeFileSync(
			path.join(cwd, "lsp.json"),
			JSON.stringify({
				servers: { fixture: { command: "node", fileTypes: ["ts"], rootMarkers: ["package.json"] } },
			}),
		);

		const config = loadConfig(cwd);

		expect(configWarnings()).toEqual([]);
		expect(config.servers.fixture?.fileTypes).toEqual(["ts"]);
	});

	it("say nothing when a config file is empty of servers but well formed", () => {
		// `{}` parses, is a record, and normalizes to an empty server map. Nothing is wrong
		// with it: the defaults apply, exactly as with no file at all.
		fs.writeFileSync(path.join(cwd, "lsp.json"), "{}");

		loadConfig(cwd);

		expect(configWarnings()).toEqual([]);
	});

	it("say nothing about a file whose only problem is an unusable server entry", () => {
		// That case has its own warning (`Ignoring invalid LSP server config`), which predates
		// this suite. The file-level warnings must not double-report it.
		fs.writeFileSync(path.join(cwd, "lsp.json"), JSON.stringify({ servers: { broken: { fileTypes: ["ts"] } } }));

		loadConfig(cwd);

		expect(configWarnings()).toEqual([]);
		expect(warnings.map(entry => entry.message)).toContain(
			"Ignoring invalid LSP server config (missing required fields).",
		);
	});
});
