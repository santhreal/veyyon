/**
 * ONE-PLACE lock for the Claude Code version this client identifies itself as.
 *
 * Why this suite exists: three modules build a user-agent from one version, and they deliberately build
 * DIFFERENT ones. The Anthropic provider sends `claude-cli/<version> (external, local-agent,
 * agent-sdk/<sdk>)`, the usage client sends `claude-cli/<version> (external, cli)`, and the OAuth bootstrap
 * sends `claude-code/<version>`. Three shapes, one version, and the version is the part that has to agree.
 *
 * The failure if it drifts is not an error. Every request still goes out; they simply carry fingerprints that
 * disagree with each other, which is exactly the inconsistency a server-side check is looking for. Nothing in
 * this repository would notice, because each module's own tests assert its own header against its own copy.
 *
 * The version used to be declared in `@veyyon/ai`'s Anthropic provider, which reaches 310 modules: the whole
 * streaming stack, the model catalogue and the error taxonomy. The OAuth controller and the usage client
 * wanted nothing else from there, so each paid 310 modules to learn a version string. Both now name
 * `@veyyon/catalog/wire/anthropic`, which has no imports.
 *
 * So the cases below do three things: pin the owner, prove the two consumers reach it through the LEAF rather
 * than through the provider (a distinction the type system cannot make, since both re-export the same value),
 * and prove no fourth copy of the version exists anywhere in the workspace.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CLAUDE_CODE_VERSION } from "@veyyon/catalog/wire/anthropic";

const PACKAGES = path.join(import.meta.dir, "..", "..");
const OWNER = path.join("catalog", "src", "wire", "anthropic.ts");

/** Every `.ts` under `packages/<pkg>/src`, which is the set a "nowhere in this repo" claim has to cover. */
function sourceFiles(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "vendor" || entry.name === "dist") continue;
			sourceFiles(full, found);
		} else if (entry.name.endsWith(".ts")) {
			found.push(full);
		}
	}
	return found;
}

const SOURCES: Array<readonly [string, string]> = fs
	.readdirSync(PACKAGES, { withFileTypes: true })
	.filter(entry => entry.isDirectory())
	.map(entry => path.join(PACKAGES, entry.name, "src"))
	.filter(dir => fs.existsSync(dir))
	.flatMap(dir => sourceFiles(dir))
	.map(file => [path.relative(PACKAGES, file), fs.readFileSync(file, "utf-8")] as const);

describe("the Claude Code version has one owner", () => {
	/**
	 * NON-VACUITY, first. Every case below is of the form "no file does X", and an empty file list answers
	 * all of them for free. The owner is named because a scan that cannot find the file the suite is about
	 * cannot find anybody else's either.
	 */
	it("reads the workspace, and finds the owner in it", () => {
		expect(SOURCES.length).toBeGreaterThan(500);
		expect(SOURCES.map(([relative]) => relative)).toContain(OWNER);
	});

	/**
	 * The value itself, pinned. Not because the number matters to this repository, but because it is the
	 * thing every other assertion here is about: a suite that scanned for a version it no longer knew would
	 * quietly stop finding copies of it.
	 */
	it("is a version string the owner exports", () => {
		expect(CLAUDE_CODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});

	/**
	 * No second copy of the literal, anywhere. This is the case that catches the failure this suite exists
	 * for: someone bumping the version in one user-agent and not the others, which no behavioural test would
	 * catch since each module asserts its own header against its own copy.
	 */
	it("nobody spells the version as a literal", () => {
		const offenders = SOURCES.filter(([relative]) => relative !== OWNER)
			.filter(([, source]) => source.includes(`"${CLAUDE_CODE_VERSION}"`))
			.map(([relative]) => relative);

		expect(
			offenders,
			`import CLAUDE_CODE_VERSION from @veyyon/catalog/wire/anthropic instead of spelling ${CLAUDE_CODE_VERSION}`,
		).toEqual([]);
	});

	/**
	 * NON-VACUITY for the rule above: the detector really matches the literal when it is there.
	 *
	 * A clean scan cannot tell a working detector from a broken one, and the pattern here is built from a
	 * runtime value, so a change to how the owner writes the constant could silently stop it matching.
	 */
	it("the literal detector matches the owner's own declaration", () => {
		const owner = SOURCES.find(([relative]) => relative === OWNER);
		expect(owner).toBeDefined();
		expect(owner?.[1]).toContain(`"${CLAUDE_CODE_VERSION}"`);
	});
});

describe("the two cheap consumers name the leaf, not the provider", () => {
	/**
	 * Asserted as the SPECIFIER, because reach is the only difference and the type system cannot see it.
	 * `../../providers/anthropic` re-exports the same value under the same name, so both spellings compile,
	 * behave identically, and differ by 207 modules.
	 */
	it("the OAuth controller imports the version from the leaf", () => {
		const source = fs.readFileSync(path.join(PACKAGES, "ai", "src", "registry", "oauth", "anthropic.ts"), "utf-8");

		expect(source).toContain('from "@veyyon/catalog/wire/anthropic"');
		expect(source).not.toContain('from "../../providers/anthropic"');
	});

	/** The same fact for the usage client, which was paying the same 310 modules for the same string. */
	it("the usage client imports the version from the leaf", () => {
		const source = fs.readFileSync(path.join(PACKAGES, "ai", "src", "usage", "claude.ts"), "utf-8");

		expect(source).toContain('from "@veyyon/catalog/wire/anthropic"');
		expect(source).not.toContain('from "../providers/anthropic"');
	});

	/**
	 * And the owner stays a leaf. The whole saving is that importing this module costs one module; an owner
	 * that grows a runtime import is an owner that stopped being cheap, and nothing else here would notice.
	 */
	it("the owner imports nothing at runtime", () => {
		const source = fs.readFileSync(path.join(PACKAGES, OWNER), "utf-8");
		const runtimeImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s*["']([^"']+)["']/gm)];

		expect(runtimeImports.map(match => match[1])).toEqual([]);
	});
});

/**
 * The interpolation this suite looks for, spelled once.
 *
 * A template literal with an escaped brace, which produces the identical text without being an
 * interpolation itself. The plain-string spelling is what `noTemplateCurlyInString` exists to catch:
 * a string that LOOKS interpolated and is not is almost always a bug, and this file is the rare place
 * where the un-interpolated form is the point, since it is searching source text for it.
 */
const VERSION_INTERPOLATION = `$\{claudeCodeVersion}`;

/** The three user-agent shapes, each built from the one version. Deliberately different from each other. */
const USER_AGENT_SHAPES: ReadonlyArray<readonly [string, string]> = [
	["ai/src/providers/anthropic.ts", `claude-cli/${VERSION_INTERPOLATION} (external, local-agent`],
	["ai/src/usage/claude.ts", `claude-cli/${VERSION_INTERPOLATION} (external, cli)`],
	["ai/src/registry/oauth/anthropic.ts", `claude-code/${VERSION_INTERPOLATION}`],
];

describe("the three user-agents are built from the one version", () => {
	/**
	 * Each of the three is a DIFFERENT shape on purpose, so the contract is not that the strings match: it is
	 * that each interpolates the shared version rather than restating it. Asserted against source text
	 * because two of the three are module-private constants with no exported form to read.
	 */
	it.each(USER_AGENT_SHAPES)("%s interpolates the version", (relative, expected) => {
		const source = fs.readFileSync(path.join(PACKAGES, relative), "utf-8");

		expect(source).toContain(expected);
	});

	/**
	 * The three shapes are distinct, which is what makes the version the only shared part. If two of them
	 * ever became identical, one of the modules would be sending the wrong client's fingerprint, and the
	 * case above would still pass because both would still interpolate the version.
	 */
	it("the three shapes differ from each other", () => {
		expect(new Set(USER_AGENT_SHAPES.map(([, shape]) => shape)).size).toBe(3);
	});

	/**
	 * NON-VACUITY for the escaped spelling above: it really produces the text it stands for. A template
	 * literal that lost its escape would interpolate to nothing, every `toContain` would search for
	 * `claude-cli/ (external, cli)`, and the whole block would go quietly green on nothing.
	 */
	it("the placeholder is the literal text, not an interpolation", () => {
		expect(VERSION_INTERPOLATION).toBe("$" + "{claudeCodeVersion}");
		expect(VERSION_INTERPOLATION.length).toBe(20);
	});
});
