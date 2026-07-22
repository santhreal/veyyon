import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	advisorConfigFilePath,
	discoverAdvisorConfigs,
	getOrCreateAdvisorProviderSessionId,
	loadWatchdogConfigFile,
	resolveAdvisorConfigEditPath,
	saveWatchdogConfigFile,
	serializeWatchdogConfig,
	slugifyAdvisorName,
	type WatchdogConfigDoc,
} from "@veyyon/coding-agent/advisor/config";

const parseYaml = (text: string): unknown =>
	(Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML.parse(text);

describe("discoverAdvisorConfigs", () => {
	let tmp: string;
	let agentDir: string;

	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-advisor-config-"));
		// Empty agent dir so the user-level search path can't pick up a real ~/.omp/WATCHDOG.yml.
		agentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-advisor-agentdir-"));
	});

	afterEach(async () => {
		await fsp.rm(tmp, { recursive: true, force: true });
		await fsp.rm(agentDir, { recursive: true, force: true });
	});

	it("parses advisors, the model thinking suffix, tool filtering, and shared instructions", async () => {
		const yaml = [
			"instructions: Shared baseline for all advisors.",
			"advisors:",
			"  - name: Architecture",
			"    model: x-ai/grok-code-fast:high",
			"    instructions: Watch module boundaries.",
			"  - name: Security Reviewer",
			"    tools: [read, definitely-not-a-tool]",
		].join("\n");
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), yaml);

		const { advisors, sharedInstructions } = await discoverAdvisorConfigs(tmp, agentDir);
		expect(advisors).toHaveLength(2);
		const [arch, sec] = advisors;
		expect(arch.name).toBe("Architecture");
		// The model selector (incl. the `:high` thinking suffix) is stored verbatim;
		// resolution happens later in the session, not here.
		expect(arch.model).toBe("x-ai/grok-code-fast:high");
		expect(arch.instructions).toBe("Watch module boundaries.");
		expect(sec.name).toBe("Security Reviewer");
		expect(sec.model).toBeUndefined();
		// The unknown/non-read-only tool is dropped; only `read` survives.
		expect(sec.tools).toEqual(["read"]);
		expect(sharedInstructions).toBe("Shared baseline for all advisors.");
	});

	it("distinguishes omitted tools, explicit no-tools, and invalid-only lists", async () => {
		const yaml = [
			"advisors:",
			"  - name: No Tools",
			"    tools: []",
			"  - name: Default Tools",
			"  - name: Invalid Only",
			"    tools: [reed]",
		].join("\n");
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), yaml);

		const { advisors } = await discoverAdvisorConfigs(tmp, agentDir);
		const noTools = advisors.find(a => a.name === "No Tools");
		const defaultTools = advisors.find(a => a.name === "Default Tools");
		const invalidOnly = advisors.find(a => a.name === "Invalid Only");

		expect(noTools?.tools).toEqual([]);
		expect(defaultTools?.tools).toBeUndefined();
		expect(invalidOnly?.tools).toBeUndefined();
	});

	// Regression: the project-level walk probed the dead brand's `.omp/` dir
	// only, so a `.veyyon/WATCHDOG.yml` (the native project config dir used by
	// secrets, agents, and extension roots) was silently invisible.
	it("discovers WATCHDOG.yml inside the project .veyyon/ config dir", async () => {
		const yaml = ["advisors:", "  - name: Dotdir Advisor"].join("\n");
		await fsp.mkdir(path.join(tmp, ".veyyon"), { recursive: true });
		await Bun.write(path.join(tmp, ".veyyon", "WATCHDOG.yml"), yaml);

		const { advisors } = await discoverAdvisorConfigs(tmp, agentDir);
		expect(advisors.map(a => a.name)).toEqual(["Dotdir Advisor"]);
	});

	it("does not read the dead brand's .omp/ project dir", async () => {
		await fsp.mkdir(path.join(tmp, ".omp"), { recursive: true });
		await Bun.write(path.join(tmp, ".omp", "WATCHDOG.yml"), ["advisors:", "  - name: Legacy Advisor"].join("\n"));

		const { advisors } = await discoverAdvisorConfigs(tmp, agentDir);
		expect(advisors).toEqual([]);
	});

	it("ignores a malformed YAML file without throwing", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), "advisors: [unclosed bracket");
		const result = await discoverAdvisorConfigs(tmp, agentDir);
		expect(result.advisors).toEqual([]);
		expect(result.sharedInstructions).toBeUndefined();
	});

	it("skips a file whose shape fails the schema (advisors must be a list)", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), "advisors: not-an-array");
		const result = await discoverAdvisorConfigs(tmp, agentDir);
		expect(result.advisors).toEqual([]);
	});

	it("returns an empty roster when no config file exists", async () => {
		const result = await discoverAdvisorConfigs(tmp, agentDir);
		expect(result.advisors).toEqual([]);
		expect(result.sharedInstructions).toBeUndefined();
	});
});

describe("slugifyAdvisorName", () => {
	it("lowercases and collapses non-alphanumeric runs to single hyphens", () => {
		expect(slugifyAdvisorName("Security Reviewer")).toBe("security-reviewer");
		expect(slugifyAdvisorName("  Arch/Boundaries!  ")).toBe("arch-boundaries");
	});

	it("falls back to 'advisor' when nothing alphanumeric survives", () => {
		expect(slugifyAdvisorName("!!!")).toBe("advisor");
	});

	it("trims edge dashes and strips non-ASCII letters to their ASCII skeleton", () => {
		// The slug is a lookup key: leading/trailing dashes must be trimmed, and non-ASCII
		// runs collapse to dashes so two visually distinct names cannot map to one key.
		expect(slugifyAdvisorName("My Advisor!")).toBe("my-advisor");
		expect(slugifyAdvisorName("  --Foo Bar--  ")).toBe("foo-bar");
		expect(slugifyAdvisorName("Café Ñoño")).toBe("caf-o-o");
	});

	it("passes an already-slug-shaped name through unchanged", () => {
		expect(slugifyAdvisorName("code-reviewer")).toBe("code-reviewer");
	});
});

describe("getOrCreateAdvisorProviderSessionId", () => {
	const primarySessionA = "018f8f5d-75b0-7cc6-8a6f-2f1c0b8e4c9d";
	const primarySessionB = "018f8f5d-75b1-7cc6-8a6f-2f1c0b8e4c9d";

	it("returns the generated UUIDv7 instead of a local advisor label", () => {
		const generated = "0193c8f2-7b1a-7c4d-9e2f-123456789abc";

		const providerSessionId = getOrCreateAdvisorProviderSessionId(
			new Map<string, string>(),
			primarySessionA,
			"security-advisor",
			() => generated,
		);

		expect(providerSessionId).toBe(generated);
		expect(providerSessionId).not.toContain("-advisor");
	});

	it("reuses the same generated UUIDv7 for repeated calls with the same primary session and slug", () => {
		const generatedIds = ["0193c8f2-7b1a-7c4d-9e2f-123456789abc", "0193c8f2-7b1b-7c4d-9e2f-123456789abc"];
		let nextGeneratedIdIndex = 0;
		const ids = new Map<string, string>();

		const first = getOrCreateAdvisorProviderSessionId(ids, primarySessionA, "architecture", () => {
			const generated = generatedIds[nextGeneratedIdIndex];
			if (!generated) throw new Error("unexpected generator call");
			nextGeneratedIdIndex += 1;
			return generated;
		});
		const second = getOrCreateAdvisorProviderSessionId(ids, primarySessionA, "architecture", () => {
			const generated = generatedIds[nextGeneratedIdIndex];
			if (!generated) throw new Error("unexpected generator call");
			nextGeneratedIdIndex += 1;
			return generated;
		});

		expect(first).toBe(generatedIds[0]);
		expect(second).toBe(generatedIds[0]);
		expect(nextGeneratedIdIndex).toBe(1);
	});

	it("creates distinct UUIDv7 values for different advisor slugs or primary sessions", () => {
		const generatedIds = [
			"0193c8f2-7b1a-7c4d-9e2f-123456789abc",
			"0193c8f2-7b1b-7c4d-9e2f-123456789abc",
			"0193c8f2-7b1c-7c4d-9e2f-123456789abc",
		];
		let nextGeneratedIdIndex = 0;
		const ids = new Map<string, string>();
		const nextGeneratedId = () => {
			const generated = generatedIds[nextGeneratedIdIndex];
			if (!generated) throw new Error("unexpected generator call");
			nextGeneratedIdIndex += 1;
			return generated;
		};

		const architecture = getOrCreateAdvisorProviderSessionId(ids, primarySessionA, "architecture", nextGeneratedId);
		const security = getOrCreateAdvisorProviderSessionId(ids, primarySessionA, "security", nextGeneratedId);
		const architectureForOtherSession = getOrCreateAdvisorProviderSessionId(
			ids,
			primarySessionB,
			"architecture",
			nextGeneratedId,
		);

		expect(architecture).toBe(generatedIds[0]);
		expect(security).toBe(generatedIds[1]);
		expect(architectureForOtherSession).toBe(generatedIds[2]);
		expect(new Set([architecture, security, architectureForOtherSession]).size).toBe(3);
	});

	it("rejects generated values that are not UUIDv7", () => {
		expect(() =>
			getOrCreateAdvisorProviderSessionId(
				new Map<string, string>(),
				primarySessionA,
				"architecture",
				() => "550e8400-e29b-41d4-a716-446655440000",
			),
		).toThrow("non-UUIDv7");
	});

	it("returns undefined when there is no primary session, so no provider conversation is created", () => {
		// Without a primary session there is nothing to key the advisor conversation to;
		// the resolver must return undefined rather than mint a dangling provider session.
		expect(getOrCreateAdvisorProviderSessionId(new Map(), undefined, "rev")).toBeUndefined();
	});

	it("names the offending value in the non-UUIDv7 rejection message", () => {
		expect(() => getOrCreateAdvisorProviderSessionId(new Map(), "s", "x", () => "not-a-uuid")).toThrow(
			"Advisor provider session id generator returned a non-UUIDv7 value",
		);
	});
});

describe("WATCHDOG.yml file round-trip", () => {
	let tmp: string;
	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-advisor-file-"));
	});
	afterEach(async () => {
		await fsp.rm(tmp, { recursive: true, force: true });
	});

	const doc: WatchdogConfigDoc = {
		instructions: 'Shared baseline.\nSecond line with: a colon and "quotes".',
		advisors: [
			{ name: "Architecture", model: "x-ai/grok-code-fast:high", instructions: "Watch module boundaries." },
			{ name: "Security", tools: ["read", "grep"] },
		],
	};

	it("saves and reloads a doc byte-equivalently (incl. multiline and special chars)", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, doc);
		const loaded = await loadWatchdogConfigFile(file);
		expect(loaded).toEqual(doc);
	});

	it("serializes block-style YAML that the discovery path also parses", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, doc);
		const text = await Bun.file(file).text();
		// Block style (not the flow `{...}` form), so it stays hand-editable.
		expect(text).toContain("advisors:");
		expect(text).not.toMatch(/^\{/);
		const { advisors, sharedInstructions } = await discoverAdvisorConfigs(tmp, tmp);
		expect(advisors.map(a => a.name)).toEqual(["Architecture", "Security"]);
		expect(sharedInstructions).toContain("Shared baseline.");
	});

	it("round-trips an explicit empty tools list without collapsing it into the default", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		const explicitNoToolsDoc: WatchdogConfigDoc = {
			advisors: [{ name: "No Tools", tools: [] }, { name: "Default Tools" }],
		};

		await saveWatchdogConfigFile(file, explicitNoToolsDoc);
		const serializedDoc = await loadWatchdogConfigFile(file);
		expect(serializedDoc).toEqual(explicitNoToolsDoc);

		const { advisors } = await discoverAdvisorConfigs(tmp, tmp);
		expect(advisors.find(a => a.name === "No Tools")?.tools).toEqual([]);
		expect(advisors.find(a => a.name === "Default Tools")?.tools).toBeUndefined();
	});

	it("removes the file when the doc is empty so legacy discovery resumes", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, doc);
		await saveWatchdogConfigFile(file, { advisors: [] });
		expect(await Bun.file(file).exists()).toBe(false);
		// Loading a missing file yields an empty doc, never throws.
		expect(await loadWatchdogConfigFile(file)).toEqual({ advisors: [] });
	});

	it("returns an empty serialization for an empty doc", () => {
		expect(serializeWatchdogConfig({ advisors: [] })).toBe("");
	});

	it("resolves project and user scope paths", () => {
		expect(advisorConfigFilePath("project", { projectDir: "/repo", agentDir: "/home/.omp" })).toBe(
			path.join("/repo", "WATCHDOG.yml"),
		);
		expect(advisorConfigFilePath("user", { projectDir: "/repo", agentDir: "/home/.omp" })).toBe(
			path.join("/home/.omp", "WATCHDOG.yml"),
		);
	});
});

describe("serializeWatchdogConfig field omission", () => {
	// The serializer decides which fields reach disk. Blank/whitespace fields must be
	// dropped so a hand-editable file stays clean, but an explicit empty `tools: []`
	// (meaning "no tools", distinct from the default subset) must survive, and an empty
	// roster under existing instructions must drop the `advisors` key entirely.
	it("omits blank fields but keeps an explicit empty tools list", () => {
		const text = serializeWatchdogConfig({
			instructions: "be nice",
			advisors: [
				{ name: "Rev", model: "", tools: undefined, instructions: "  " },
				{ name: "Sec", model: "gpt", tools: [], instructions: "check" },
			],
		});
		expect(parseYaml(text)).toEqual({
			instructions: "be nice",
			advisors: [{ name: "Rev" }, { name: "Sec", model: "gpt", tools: [], instructions: "check" }],
		});
		expect(text.endsWith("\n")).toBe(true);
	});

	it("drops the advisors key entirely when the roster is empty but instructions exist", () => {
		const text = serializeWatchdogConfig({ instructions: "shared", advisors: [] });
		expect(parseYaml(text)).toEqual({ instructions: "shared" });
	});
});

describe("resolveAdvisorConfigEditPath", () => {
	let tmp: string;
	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-advisor-resolve-"));
	});
	afterEach(async () => {
		await fsp.rm(tmp, { recursive: true, force: true });
	});

	const dirs = (d: string) => ({ projectDir: d, agentDir: d });

	it("defaults to .yml when neither file exists", async () => {
		expect(await resolveAdvisorConfigEditPath("project", dirs(tmp))).toBe(path.join(tmp, "WATCHDOG.yml"));
	});

	it("edits an existing .yaml in place when only it exists", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yaml"), "advisors: []\n");
		expect(await resolveAdvisorConfigEditPath("project", dirs(tmp))).toBe(path.join(tmp, "WATCHDOG.yaml"));
	});

	it("prefers the canonical .yml when both exist", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), "advisors: []\n");
		await Bun.write(path.join(tmp, "WATCHDOG.yaml"), "advisors: []\n");
		expect(await resolveAdvisorConfigEditPath("project", dirs(tmp))).toBe(path.join(tmp, "WATCHDOG.yml"));
	});
});

describe("loadWatchdogConfigFile with a broken file", () => {
	// The editor deliberately opens on an empty doc when it cannot read the file,
	// and saving an empty doc removes the file. That combination turns one syntax
	// error plus one visit to the editor into total loss of the user's advisors,
	// so the bytes are copied aside before the empty doc is handed back.
	let tmp: string;

	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "watchdog-broken-"));
	});

	afterEach(async () => {
		await fsp.rm(tmp, { recursive: true, force: true });
	});

	it("preserves a file with a YAML syntax error", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		const broken = ["advisors:", "  - name: Security", "    model: gpt: 4"].join("\n");
		await Bun.write(file, broken);

		const loaded = await loadWatchdogConfigFile(file);

		expect(loaded).toEqual({ advisors: [] });
		expect(await Bun.file(`${file}.corrupt`).text()).toBe(broken);
	});

	it("preserves a file that parses but does not match the schema", async () => {
		// Same hazard, different cause: a valid YAML document with the wrong shape
		// also yields an empty doc, and saving that empty doc removes the file.
		const file = path.join(tmp, "WATCHDOG.yml");
		const wrongShape = "advisors: not-a-list\n";
		await Bun.write(file, wrongShape);

		const loaded = await loadWatchdogConfigFile(file);

		expect(loaded).toEqual({ advisors: [] });
		expect(await Bun.file(`${file}.corrupt`).text()).toBe(wrongShape);
	});

	it("preserves a file that is not a mapping at all", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(file, "- just\n- a list\n");

		await loadWatchdogConfigFile(file);

		expect(await Bun.file(`${file}.corrupt`).text()).toBe("- just\n- a list\n");
	});

	it("preserves nothing for a valid file, so the normal path leaves no debris", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, { advisors: [{ name: "Security" }] });

		const loaded = await loadWatchdogConfigFile(file);

		expect(loaded.advisors.map(a => a.name)).toEqual(["Security"]);
		expect(await Bun.file(`${file}.corrupt`).exists()).toBe(false);
	});

	it("returns an empty doc for a missing file without creating a copy", async () => {
		const file = path.join(tmp, "absent.yml");

		expect(await loadWatchdogConfigFile(file)).toEqual({ advisors: [] });
		expect(await Bun.file(`${file}.corrupt`).exists()).toBe(false);
	});
});
