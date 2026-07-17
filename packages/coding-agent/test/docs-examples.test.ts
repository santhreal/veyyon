/**
 * Doctest for markdown examples: every `veyyon …` command line, `mcpServers`
 * JSON block, and keybinding action ID shown in the docs is validated against
 * the real CLI parser, MCP config validator, and keybinding registry, so doc
 * examples cannot drift from shipped behavior (BACKLOG DOCS-CODE-EXAMPLES-TESTED).
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "@veyyon/pi-coding-agent/cli/args";
import { isSubcommand } from "@veyyon/pi-coding-agent/cli-commands";
import { KEYBINDINGS } from "@veyyon/pi-coding-agent/config/keybindings";
import { SETTINGS_SCHEMA } from "@veyyon/pi-coding-agent/config/settings-schema";
import { validateServerConfig } from "@veyyon/pi-coding-agent/mcp/config";
import { MCP_CONFIG_SCHEMA_URL } from "@veyyon/pi-coding-agent/mcp/types";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@veyyon/pi-coding-agent/slash-commands/builtin-registry";
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "@veyyon/pi-coding-agent/tools";
import { YAML } from "bun";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

/**
 * Fenced blocks the checker must not parse as veyyon's own surface:
 * illustrative content for other tools, negative examples, or explicitly
 * spec-not-shipped shapes. Every entry carries the reason it is exempt.
 */
const EXEMPT_FILES = new Set<string>([
	// oh-my-pi upstream changelogs carry pre-fork examples.
]);

interface Fence {
	file: string;
	/** 1-indexed line of the opening ``` */
	line: number;
	lang: string;
	body: string[];
}

function listMarkdownFiles(): string[] {
	const result = spawnSync("git", ["ls-files", "*.md", "**/*.md"], {
		cwd: REPO_ROOT,
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(`git ls-files failed: ${result.stderr}`);
	}
	return [...new Set(result.stdout.split("\n").filter(Boolean))].filter(
		file =>
			!file.endsWith("CHANGELOG.md") &&
			!file.includes("/builtin-rules/") &&
			!file.includes("/test/") &&
			!file.includes("/__tests__/") &&
			!file.includes("/fixtures/") &&
			!file.startsWith("vendor/") &&
			!EXEMPT_FILES.has(file),
	);
}

function extractFences(file: string): Fence[] {
	const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf-8");
	const lines = text.split("\n");
	const fences: Fence[] = [];
	let open: Fence | null = null;
	let fenceMarker = "";
	// Handbook convention: a "Spec — not shipped" marker scopes the rest of the
	// page (page-top blockquotes) or the section it opens; examples after it
	// illustrate the target shape, not the shipped CLI, so they are not checked.
	let specScope = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!open && line.includes("Spec — not shipped")) specScope = true;
		const match = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
		if (!open && match) {
			if (specScope) {
				// Consume the spec-scoped fence without recording it.
				open = { file, line: i + 1, lang: "__spec__", body: [] };
				fenceMarker = match[2][0].repeat(match[2].length);
				continue;
			}
			open = { file, line: i + 1, lang: match[3].trim().split(/\s+/)[0].toLowerCase(), body: [] };
			fenceMarker = match[2][0].repeat(match[2].length);
			continue;
		}
		if (
			open &&
			match &&
			match[3].trim() === "" &&
			match[2].startsWith(fenceMarker[0]) &&
			match[2].length >= fenceMarker.length
		) {
			if (open.lang !== "__spec__") fences.push(open);
			open = null;
			continue;
		}
		if (open) open.body.push(line);
	}
	return fences;
}

const SHELL_LANGS = new Set(["console", "bash", "sh", "shell", "zsh"]);

/** Tokenize a shell-ish line, respecting single/double quotes. */
function shellTokens(line: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (const ch of line) {
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
		} else if (ch === "#" && current === "") {
			break; // unquoted trailing comment
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (/\s/.test(ch)) {
			if (current) tokens.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	if (current) tokens.push(current);
	return tokens;
}

interface CommandExample {
	file: string;
	line: number;
	raw: string;
	/** argv after the `veyyon` token */
	argv: string[];
}

function collectVeyyonCommands(fences: Fence[]): CommandExample[] {
	const commands: CommandExample[] = [];
	for (const fence of fences) {
		if (!SHELL_LANGS.has(fence.lang)) continue;
		for (let i = 0; i < fence.body.length; i++) {
			let raw = fence.body[i].trim();
			if (raw.startsWith("#")) continue;
			// Join backslash continuations.
			while (raw.endsWith("\\") && i + 1 < fence.body.length) {
				raw = `${raw.slice(0, -1)} ${fence.body[++i].trim()}`;
			}
			// console blocks prefix commands with `$ `; unprefixed lines are output.
			if (fence.lang === "console") {
				if (!raw.startsWith("$")) continue;
				raw = raw.slice(1).trim();
			}
			// Validate every veyyon segment of pipelines / && chains / ; sequences.
			for (const segment of raw.split(/\|\||&&|;|\|/)) {
				const trimmed = segment.trim();
				if (!/^veyyon(\s|$)/.test(trimmed)) continue;
				const tokens = shellTokens(trimmed);
				// Placeholder-only examples (`veyyon <subcommand> …`) are shape
				// illustrations, not runnable commands; skip tokens that are pure
				// placeholders but keep the rest of the line checkable.
				const argv = tokens.slice(1).filter(token => !/^<.*>$/.test(token) && token !== "…" && token !== "...");
				if (tokens.slice(1).some(token => /^--<|^\[.*\]$/.test(token))) continue;
				commands.push({ file: fence.file, line: fence.line, raw: trimmed, argv });
			}
		}
	}
	return commands;
}

const markdownFiles = listMarkdownFiles();
const allFences = markdownFiles.flatMap(extractFences);

describe("docs examples — veyyon command lines parse with the real CLI", () => {
	const commands = collectVeyyonCommands(allFences);

	it("finds a meaningful number of command examples (extraction is alive)", () => {
		expect(commands.length).toBeGreaterThan(20);
	});

	it("every documented subcommand is registered and every launch flag is recognized", () => {
		const failures: string[] = [];
		for (const command of commands) {
			const first = command.argv[0];
			// A registered subcommand owns its flag parsing; the launch parser does
			// not apply. Any other first token — flag or positional prompt — goes
			// through the real launch parser, exactly like the shipped CLI.
			if (first && isSubcommand(first)) continue;
			const parsed = parseArgs([...command.argv]);
			if (parsed.unrecognizedFlags.length > 0) {
				failures.push(
					`${command.file}:${command.line}: unknown flag(s) ${parsed.unrecognizedFlags.join(", ")} in \`${command.raw}\``,
				);
			}
		}
		expect(failures).toEqual([]);
	});
});

describe("docs examples — mcpServers JSON blocks satisfy the real MCP validator", () => {
	const mcpBlocks = allFences.filter(
		fence =>
			(fence.lang === "json" || fence.lang === "jsonc") && fence.body.some(line => line.includes('"mcpServers"')),
	);

	it("finds mcp.json examples (extraction is alive)", () => {
		expect(mcpBlocks.length).toBeGreaterThan(3);
	});

	it("every example parses, every server validates, and $schema is the canonical URL", () => {
		const failures: string[] = [];
		for (const fence of mcpBlocks) {
			const source = fence.body.join("\n");
			let parsed: { $schema?: string; mcpServers?: Record<string, object> };
			try {
				parsed = JSON.parse(source);
			} catch (error) {
				failures.push(`${fence.file}:${fence.line}: invalid JSON — ${(error as Error).message}`);
				continue;
			}
			if (parsed.$schema !== undefined && parsed.$schema !== MCP_CONFIG_SCHEMA_URL) {
				failures.push(
					`${fence.file}:${fence.line}: $schema "${parsed.$schema}" is not the canonical ${MCP_CONFIG_SCHEMA_URL}`,
				);
			}
			for (const [name, config] of Object.entries(parsed.mcpServers ?? {})) {
				for (const error of validateServerConfig(name, config as never)) {
					failures.push(`${fence.file}:${fence.line}: ${error}`);
				}
			}
		}
		expect(failures).toEqual([]);
	});
});

describe("docs examples — keybinding action IDs exist in the registry", () => {
	// Inline-code `app.*` mentions and YAML example keys across all docs.
	const inlineActionPattern = /`(app\.[A-Za-z][A-Za-z0-9.]*)`/g;

	it("every documented app.* action ID is a real keybinding action", () => {
		const failures: string[] = [];
		// Only keybinding docs document action IDs; `app.*` elsewhere (browser
		// tool fields, config paths) is a different namespace.
		const keybindingDocs = markdownFiles.filter(file => /keybinding|hotkey/i.test(file));
		expect(keybindingDocs.length).toBeGreaterThan(0);
		for (const file of keybindingDocs) {
			const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf-8");
			const lines = text.split("\n");
			for (let i = 0; i < lines.length; i++) {
				for (const match of lines[i].matchAll(inlineActionPattern)) {
					if (!(match[1] in KEYBINDINGS)) {
						failures.push(`${file}:${i + 1}: unknown keybinding action \`${match[1]}\``);
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it("every YAML keybinding example maps real action IDs", () => {
		const failures: string[] = [];
		for (const fence of allFences) {
			if (fence.lang !== "yaml" && fence.lang !== "yml") continue;
			const source = fence.body.join("\n");
			if (!/^app\./m.test(source)) continue;
			let parsed: unknown;
			try {
				parsed = YAML.parse(source);
			} catch (error) {
				failures.push(`${fence.file}:${fence.line}: invalid YAML — ${(error as Error).message}`);
				continue;
			}
			if (typeof parsed !== "object" || parsed === null) continue;
			for (const key of Object.keys(parsed)) {
				if (key.startsWith("app.") && !(key in KEYBINDINGS)) {
					failures.push(`${fence.file}:${fence.line}: unknown keybinding action "${key}"`);
				}
			}
		}
		expect(failures).toEqual([]);
	});
});

describe("docs examples — config.yml keys exist in the settings schema", () => {
	const schemaPaths = new Set(Object.keys(SETTINGS_SCHEMA));
	const schemaPrefixes = new Set<string>();
	for (const settingPath of schemaPaths) {
		const segments = settingPath.split(".");
		for (let i = 1; i < segments.length; i++) {
			schemaPrefixes.add(segments.slice(0, i).join("."));
		}
	}

	/**
	 * A YAML fence is a config.yml example when the prose immediately above it
	 * names the file. Keybinding YAML (app.* keys) has its own check above.
	 */
	function isConfigYmlExample(fence: Fence): boolean {
		if (fence.lang !== "yaml" && fence.lang !== "yml") return false;
		// Keybinding maps (app.* keys, keybindings.yml) are validated above.
		if (fence.body.some(line => /^\s*app\./.test(line))) return false;
		const lines = fs.readFileSync(path.join(REPO_ROOT, fence.file), "utf-8").split("\n");
		for (let i = fence.line - 2; i >= Math.max(0, fence.line - 8); i--) {
			if (/config\.ya?ml/.test(lines[i])) return true;
		}
		return false;
	}

	/**
	 * Walk a parsed config example. A key path that matches a registered
	 * setting is a valid leaf (its value shape is owned by that setting); a
	 * path that is a prefix of registered settings recurses; anything else is
	 * a key the shipped Settings loader does not know.
	 */
	function collectUnknownKeys(node: unknown, prefix: string, unknown: string[]): void {
		if (prefix && schemaPaths.has(prefix)) return;
		if (prefix && !schemaPrefixes.has(prefix)) {
			unknown.push(prefix);
			return;
		}
		if (typeof node !== "object" || node === null || Array.isArray(node)) {
			// A bare value at a prefix-only path (e.g. `theme: dark`) is not a
			// registered setting either.
			unknown.push(prefix || "(root)");
			return;
		}
		for (const [key, value] of Object.entries(node)) {
			collectUnknownKeys(value, prefix ? `${prefix}.${key}` : key, unknown);
		}
	}

	const configExamples = allFences.filter(isConfigYmlExample);

	it("finds config.yml examples (extraction is alive)", () => {
		expect(configExamples.length).toBeGreaterThan(3);
	});

	it("every key in every config.yml example is a registered settings path", () => {
		const failures: string[] = [];
		for (const fence of configExamples) {
			const source = fence.body.join("\n");
			let parsed: unknown;
			try {
				parsed = YAML.parse(source);
			} catch (error) {
				failures.push(`${fence.file}:${fence.line}: invalid YAML — ${(error as Error).message}`);
				continue;
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
			const unknown: string[] = [];
			for (const [key, value] of Object.entries(parsed)) {
				collectUnknownKeys(value, key, unknown);
			}
			for (const key of unknown) {
				failures.push(`${fence.file}:${fence.line}: "${key}" is not a registered settings path`);
			}
		}
		expect(failures).toEqual([]);
	});
});

describe("docs examples — documented env vars are consumed in source", () => {
	const ENV_NAME_RE = /\b(?:VEYYON|OMP|PI)_[A-Z][A-Z0-9_]*\b/g;

	/** Strip the brand prefix so VEYYON_FOO / OMP_FOO / PI_FOO all key as FOO. */
	function envSuffix(name: string): string {
		return name.replace(/^(?:VEYYON|OMP|PI)_/, "");
	}

	/**
	 * Every env-var suffix any source file reads or writes, under any of the
	 * three prefixes (the env mirror makes them interchangeable at runtime).
	 */
	function collectSourceEnvSuffixes(): Set<string> {
		const suffixes = new Set<string>();
		const globs: Array<[string, string]> = [
			["packages", "*/src/**/*.{ts,tsx}"],
			["packages", "*/scripts/**/*.ts"],
			["packages", "*/test/**/*.{ts,tsx}"],
			["packages", "*/native/**/*.js"],
			["crates", "*/src/**/*.rs"],
			["scripts", "**/*.{ts,sh,ps1}"],
			["website", "**/*.{mjs,sh,ps1}"],
			["python", "**/*.{py,sh,yml,yaml}"],
		];
		for (const [dir, pattern] of globs) {
			const root = path.join(REPO_ROOT, dir);
			if (!fs.existsSync(root)) continue;
			for (const rel of new Bun.Glob(pattern).scanSync({ cwd: root })) {
				if (rel.includes("node_modules/")) continue;
				const text = fs.readFileSync(path.join(root, rel), "utf-8");
				for (const match of text.matchAll(ENV_NAME_RE)) {
					suffixes.add(envSuffix(match[0]));
				}
			}
		}
		return suffixes;
	}

	/**
	 * Docs legitimately name non-existent vars when DENYING them — the
	 * environment reference's "Never existed" table, "There is no X" call-outs,
	 * and removed-lever notes in internal docs. Skip a mention when its line
	 * reads as negation/removal rather than as a claim the var works.
	 */
	const NEGATION_RE = /\bno\s+`|never existed|removed|is gone|not shipped|does not exist|belonged to the removed/i;

	it("every VEYYON_/OMP_/PI_ env var named in the docs exists in source", () => {
		const sourceSuffixes = collectSourceEnvSuffixes();
		expect(sourceSuffixes.size).toBeGreaterThan(20);
		const failures: string[] = [];
		for (const file of markdownFiles) {
			const lines = fs.readFileSync(path.join(REPO_ROOT, file), "utf-8").split("\n");
			let specScope = false;
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].includes("Spec — not shipped")) specScope = true;
				if (specScope) continue;
				// Negation sentences wrap, so check one line either side too.
				if (
					NEGATION_RE.test(lines[i]) ||
					NEGATION_RE.test(lines[i - 1] ?? "") ||
					NEGATION_RE.test(lines[i + 1] ?? "")
				) {
					continue;
				}
				for (const match of lines[i].matchAll(ENV_NAME_RE)) {
					// `VEYYON_<NAME>` / `PI_FOO_*` placeholders are shape illustrations.
					const next = lines[i].slice((match.index ?? 0) + match[0].length);
					if (next.startsWith("<") || next.startsWith("*")) continue;
					if (!sourceSuffixes.has(envSuffix(match[0]))) {
						failures.push(`${file}:${i + 1}: env var ${match[0]} is not read anywhere in source`);
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});
});

describe("docs examples — documented slash commands exist in the builtin registry", () => {
	// A backticked single-token `/name` (optionally with subcommand/arg words
	// after it). Multi-segment paths (`/etc/veyyon/skills`) never match because
	// a second `/` breaks the token; the lookbehind stops a closing backtick
	// glued to prose (`file.md`/custom …) from posing as an opening one.
	// Scoped to the public handbook — elsewhere `/word` is usually a URL route
	// or filesystem path, and only the handbook promises the TUI surface.
	const SLASH_MENTION_RE = /(?<![\w.])`\/([a-z][a-z0-9_-]*)(?: [^`]*)?`/g;
	// Denial mentions ("There is no `/clone` command", "`/import` is **not** in
	// the registry", "(not `/side`)") are honest docs, not claims.
	const SLASH_NEGATION_RE = /\bnot?\s+`|\*\*not\*\*|does not exist|not shipped/i;

	const registered = new Set<string>();
	for (const command of BUILTIN_SLASH_COMMAND_DEFS) {
		registered.add(command.name);
		for (const alias of command.aliases ?? []) registered.add(alias);
	}

	it("the registry is alive", () => {
		expect(registered.size).toBeGreaterThan(30);
	});

	it("every backticked /command in the handbook is a registered builtin (or alias)", () => {
		const failures: string[] = [];
		let mentions = 0;
		for (const file of markdownFiles) {
			if (!file.startsWith("docs/handbook/src/")) continue;
			const lines = fs.readFileSync(path.join(REPO_ROOT, file), "utf-8").split("\n");
			let specScope = false;
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].includes("Spec — not shipped")) specScope = true;
				if (specScope) continue;
				if (SLASH_NEGATION_RE.test(lines[i])) continue;
				for (const match of lines[i].matchAll(SLASH_MENTION_RE)) {
					mentions++;
					if (!registered.has(match[1])) {
						failures.push(`${file}:${i + 1}: slash command /${match[1]} is not in the builtin registry`);
					}
				}
			}
		}
		expect(mentions).toBeGreaterThan(50);
		expect(failures).toEqual([]);
	});
});

describe("docs examples — tools reference names real tools", () => {
	// Every backticked snake_case token in the tools reference must be a real
	// tool: a BUILTIN_TOOLS / HIDDEN_TOOLS key, a sdk-registered custom tool
	// (scanned from `name: "…"` in src/tools), or `apply_patch` (the edit
	// tool's advertised name in that mode, edit/index.ts).
	const TOOLS_DOC = "docs/handbook/src/reference/tools.md";
	const TOKEN_RE = /`([a-z][a-z0-9_]*)`/g;
	// Argument/field names the page legitimately shows that are not tools.
	const NON_TOOL_TOKENS = new Set(["input"]);

	function collectToolNames(): Set<string> {
		const names = new Set<string>([...Object.keys(BUILTIN_TOOLS), ...Object.keys(HIDDEN_TOOLS), "apply_patch"]);
		const toolsRoot = path.join(REPO_ROOT, "packages/coding-agent/src/tools");
		for (const rel of new Bun.Glob("**/*.ts").scanSync({ cwd: toolsRoot })) {
			const text = fs.readFileSync(path.join(toolsRoot, rel), "utf-8");
			for (const match of text.matchAll(/\bname: "([a-z][a-z0-9_]*)"/g)) {
				names.add(match[1]);
			}
		}
		return names;
	}

	it("every backticked tool token in the tools reference exists", () => {
		const toolNames = collectToolNames();
		expect(toolNames.size).toBeGreaterThan(30);
		const failures: string[] = [];
		let mentions = 0;
		const lines = fs.readFileSync(path.join(REPO_ROOT, TOOLS_DOC), "utf-8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			for (const match of lines[i].matchAll(TOKEN_RE)) {
				if (NON_TOOL_TOKENS.has(match[1])) continue;
				mentions++;
				if (!toolNames.has(match[1])) {
					failures.push(`${TOOLS_DOC}:${i + 1}: \`${match[1]}\` is not a shipped tool name`);
				}
			}
		}
		expect(mentions).toBeGreaterThan(30);
		expect(failures).toEqual([]);
	});
});

describe("docs examples — inline dotted settings mentions are registered paths", () => {
	// Backticked dotted tokens in handbook prose (`advisor.enabled`,
	// `compaction.strategy`) whose first segment is a settings root must resolve
	// in SETTINGS_SCHEMA. This caught the phantom "docs alias" claims
	// (`compaction.threshold`, `compaction.type`) and `theme.symbols`
	// (real setting: `symbolPreset`). Fenced blocks are excluded — config.yml
	// fences have their own structural lane above, and other fences show code,
	// not settings paths.
	const MENTION_RE = /`([a-z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)+)`/g;
	// File names (`mcp.json`, `theme.ts`) share the dotted shape but end in an
	// extension; settings leaves never do.
	const FILE_EXT_RE =
		/\.(?:json|jsonc|ts|tsx|js|mjs|cjs|yml|yaml|md|toml|rs|py|sh|ps1|html|css|webp|png|svg|db|lock|txt|exe)$/;
	const NEGATION_RE = /\bnot?\s+(?:a\s+)?`|\*\*not\*\*|does not exist|not shipped|never existed|removed|is gone/i;

	const schemaPaths = new Set(Object.keys(SETTINGS_SCHEMA));
	const schemaRoots = new Set<string>();
	const schemaPrefixes = new Set<string>();
	for (const settingPath of schemaPaths) {
		const segments = settingPath.split(".");
		schemaRoots.add(segments[0]);
		for (let i = 1; i < segments.length; i++) {
			schemaPrefixes.add(segments.slice(0, i).join("."));
		}
	}

	/**
	 * A dotted token is valid when it is a registered leaf, a group prefix, a
	 * child of a map-valued leaf (`modelRoles.task` under the `modelRoles`
	 * setting), or a keybinding action ID (`tui.select.pageUp` — the `tui.*`
	 * action namespace overlaps the `tui.*` settings root).
	 */
	function isKnownDotted(token: string): boolean {
		if (schemaPaths.has(token) || schemaPrefixes.has(token)) return true;
		if (token in KEYBINDINGS) return true;
		const segments = token.split(".");
		for (let i = segments.length - 1; i >= 1; i--) {
			if (schemaPaths.has(segments.slice(0, i).join("."))) return true;
		}
		return false;
	}

	it("every settings-rooted dotted mention in handbook prose resolves in the schema", () => {
		const failures: string[] = [];
		let mentions = 0;
		for (const file of markdownFiles) {
			if (!file.startsWith("docs/handbook/src/")) continue;
			const lines = fs.readFileSync(path.join(REPO_ROOT, file), "utf-8").split("\n");
			let inFence = false;
			let specScope = false;
			for (let i = 0; i < lines.length; i++) {
				if (/^\s*(?:`{3,}|~{3,})/.test(lines[i])) {
					inFence = !inFence;
					continue;
				}
				if (inFence) continue;
				if (lines[i].includes("Spec — not shipped")) specScope = true;
				if (specScope) continue;
				if (NEGATION_RE.test(lines[i])) continue;
				for (const match of lines[i].matchAll(MENTION_RE)) {
					const token = match[1];
					if (FILE_EXT_RE.test(token)) continue;
					if (!schemaRoots.has(token.split(".")[0])) continue;
					mentions++;
					if (!isKnownDotted(token)) {
						failures.push(`${file}:${i + 1}: \`${token}\` is not a registered settings path`);
					}
				}
			}
		}
		expect(mentions).toBeGreaterThan(40);
		expect(failures).toEqual([]);
	});
});
