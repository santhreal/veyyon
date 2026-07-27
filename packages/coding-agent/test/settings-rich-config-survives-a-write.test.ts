/**
 * A real machine's config file, carried through one write, on disk.
 *
 * The existing settings suites each prove a PIECE against a small file: unknown
 * keys survive (`settings-unknown-key-preservation`), a malformed file is
 * quarantined (`settings-malformed-yaml`), a concurrent writer is not clobbered
 * (`settings-concurrent-write`). What none of them do is put a rich file in front
 * of the loader — every domain populated, an MCP server with a credential in its
 * env, keys from a newer build, a project override alongside it — and then check
 * the FILE after a single `set`. That composition is what an update does to a
 * config it did not write, and it is where a migration that is individually
 * correct still loses something: the file the user gets back is the product of
 * every rule at once.
 *
 * Four claims here are asserted nowhere else, and each is a way a user loses
 * something real:
 *
 *  1. The file keeps its 0600 mode. It holds credentials, and a write that
 *     replaces it by renaming a fresh temp over it takes the TEMP's mode — so
 *     "the permissions are fine" is a property of the writer's default, not of
 *     anything this codebase asserts about the config path.
 *  2. A symlinked config is written THROUGH the link. A dotfile manager points
 *     `config.yml` into a synced repo; replacing the LINK with a regular file
 *     silently unhooks the user's setup and their next sync overwrites it back.
 *  3. A per-project settings file is not folded into the global file. Project
 *     settings are an overlay; writing them into the global config would promote
 *     one repo's choices to every repo, permanently.
 *  4. A credential in an MCP server block comes back byte-identical, in place. A
 *     re-serialization that re-quotes or re-indents a secret is how a working
 *     server config stops working after an update.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as YAML from "yaml";
import { RICH_CONFIG } from "./helpers/rich-config-fixture";

const tempDirs: string[] = [];

beforeAll(async () => {
	await Settings.init({ inMemory: true });
});

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeAgentDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rich-config-"));
	tempDirs.push(dir);
	return dir;
}

/**
 * Wait for a settings write to actually reach disk.
 *
 * Settings batches saves behind a timer, so the file is only observable after that save runs. This used to
 * be a fixed 300ms sleep, which is a race dressed up as a wait: under the load of a full suite run the save
 * had not finished, the config on disk still had none of the new keys, and the corpus assertion failed with
 * `added: []` -- at a different seed each time and never when the file was run alone. `flush()` cancels the
 * pending timer, awaits an in-progress save and forces one if anything is still modified, so it returns when
 * the write is genuinely done rather than when a guessed interval has passed.
 */
async function settle(settings: Settings): Promise<void> {
	await settings.flush();
}

/** Seed a config, load it, write one unrelated setting, and return the file. */
async function roundTrip(options: { config?: string; mode?: number; symlinked?: boolean } = {}): Promise<{
	agentDir: string;
	configPath: string;
	text: string;
	parsed: Record<string, unknown>;
}> {
	const agentDir = await makeAgentDir();
	const configPath = path.join(agentDir, "config.yml");
	const target = options.symlinked ? path.join(agentDir, "dotfiles-config.yml") : configPath;
	await fs.writeFile(target, options.config ?? RICH_CONFIG, { mode: options.mode ?? 0o600 });
	if (options.symlinked) await fs.symlink(target, configPath);

	const settings = await Settings.loadIsolated({ agentDir });
	await settings.set("topP", 0.9);
	await settle(settings);

	const text = await fs.readFile(configPath, "utf8");
	return { agentDir, configPath, text, parsed: (YAML.parse(text) ?? {}) as Record<string, unknown> };
}

describe("a rich config carried through one write", () => {
	it("keeps every value the user set, across every domain", async () => {
		const { parsed } = await roundTrip();

		expect(parsed.temperature).toBe(0.7);
		expect(parsed.topK).toBe(40);
		expect(parsed.compaction).toMatchObject({ threshold: "85%", reserveTokens: 8000 });
		expect(parsed.display).toMatchObject({ showTokenUsage: true, cacheMissMarker: true });
		expect(parsed.argot).toMatchObject({ enabled: true, tokenBudget: 2048 });
		expect(parsed.keybindings).toMatchObject({ submit: "ctrl+enter" });
		expect(parsed.theme).toMatchObject({ dark: "titanium" });
	});

	/** A key from a newer build is not a mistake to clean up: downgrade, then
	 * upgrade again, and the user expects their setting to still be there. */
	it("keeps keys this build does not know, nested ones included", async () => {
		const { parsed } = await roundTrip();

		expect(parsed.futureFeature).toBe("from-a-newer-build");
		expect(parsed.futureBlock).toEqual({ nested: "alsoKept" });
	});

	it("applies the write it was asked for", async () => {
		const { parsed } = await roundTrip();

		expect(parsed.topP).toBe(0.9);
	});
});

describe("credentials in the file", () => {
	/** Re-serialization is the hazard: a token that comes back re-quoted, split,
	 * or re-indented is a server that worked before the update and does not now. */
	it("returns an MCP token byte-identical, in its original place", async () => {
		const { text, parsed } = await roundTrip();

		expect(text).toContain("API_TOKEN: sk-live-do-not-touch-me");
		const servers = parsed.mcpServers as Record<string, { command: string; args: string[]; env: object }>;
		expect(servers["paid-api"]).toMatchObject({
			command: "node",
			args: ["server.js"],
			env: { API_TOKEN: "sk-live-do-not-touch-me" },
		});
	});

	/**
	 * The write replaces the file by renaming a fresh temp over it, so the result
	 * carries the TEMP's mode rather than the original's. Nothing else asserts that
	 * the config path ends up owner-only, and it holds credentials.
	 */
	it("leaves the file readable by its owner only", async () => {
		const { configPath } = await roundTrip({ mode: 0o600 });

		expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
	});

	/**
	 * A config that was group- or world-readable comes back owner-only. Narrowing
	 * is deliberate here and worth pinning as the exact value rather than as "no
	 * read bits": this is the one file in the tree whose default the writer is
	 * allowed to impose over the user's, because it holds credentials, and a future
	 * change to `atomicWriteFilePreservingMode` on this path would be a regression
	 * that a "not widened" assertion would happily accept.
	 */
	it("narrows a group- or world-readable config back to owner-only", async () => {
		for (const seeded of [0o644, 0o664]) {
			const { configPath } = await roundTrip({ mode: seeded });
			const mode = (await fs.stat(configPath)).mode & 0o777;

			expect(mode.toString(8), `seeded ${seeded.toString(8)}`).toBe("600");
		}
	});
});

describe("a config that is a symlink", () => {
	/** A dotfile manager points config.yml into a synced repo. Replacing the LINK
	 * with a regular file unhooks that setup silently, and the next sync quietly
	 * puts the old content back. */
	it("stays a symlink", async () => {
		const { configPath } = await roundTrip({ symlinked: true });

		expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true);
	});

	it("writes through to the link's target", async () => {
		const { agentDir, parsed } = await roundTrip({ symlinked: true });

		const target = YAML.parse(await fs.readFile(path.join(agentDir, "dotfiles-config.yml"), "utf8"));
		expect(target.topP).toBe(0.9);
		expect(target.futureFeature).toBe("from-a-newer-build");
		expect(parsed.topP).toBe(0.9);
	});
});

describe("a project settings file alongside the global one", () => {
	/**
	 * Project settings are an OVERLAY: they apply while you are in that project.
	 * Folding them into the global file would promote one repo's choices to every
	 * repo, and the user would have no way to tell which of their globals they
	 * actually chose.
	 */
	it("does not fold the project's values into the global file", async () => {
		const agentDir = await makeAgentDir();
		const projectDir = await makeAgentDir();
		await fs.writeFile(path.join(agentDir, "config.yml"), RICH_CONFIG, { mode: 0o600 });
		await fs.mkdir(path.join(projectDir, ".veyyon"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".veyyon", "settings.json"),
			JSON.stringify({ temperature: 0.1, projectOnlyKey: "local" }),
		);

		const settings = await Settings.loadIsolated({ agentDir, cwd: projectDir });
		await settings.set("topP", 0.9);
		await settle(settings);

		const global = YAML.parse(await fs.readFile(path.join(agentDir, "config.yml"), "utf8"));
		expect(global.temperature).toBe(0.7); // the global value, not the project's 0.1
		expect(global.projectOnlyKey).toBeUndefined();
	});

	it("leaves the project file untouched", async () => {
		const agentDir = await makeAgentDir();
		const projectDir = await makeAgentDir();
		await fs.writeFile(path.join(agentDir, "config.yml"), RICH_CONFIG, { mode: 0o600 });
		await fs.mkdir(path.join(projectDir, ".veyyon"), { recursive: true });
		const projectPath = path.join(projectDir, ".veyyon", "settings.json");
		const before = JSON.stringify({ temperature: 0.1, projectOnlyKey: "local" });
		await fs.writeFile(projectPath, before);

		const settings = await Settings.loadIsolated({ agentDir, cwd: projectDir });
		await settings.set("topP", 0.9);
		await settle(settings);

		expect(await fs.readFile(projectPath, "utf8")).toBe(before);
	});
});

// ---------------------------------------------------------------------------
// The generated corpus
//
// The fixture above is ONE rich file, hand-written, and a hand-written fixture only
// covers the values whoever wrote it thought of. What actually breaks a config on
// update is a value that re-serializes differently from how the user typed it, and
// those are exactly the strings nobody puts in a fixture: a token that begins with `*`
// (a YAML alias), one containing `: ` (a mapping), one ending in a space, one that
// looks like a number or a bool, one holding a `#`, a newline, or a lone backslash.
//
// The corpus is generated from a seeded PRNG rather than `Math.random`, so a failure
// reproduces exactly from the seed printed in the assertion message.
// ---------------------------------------------------------------------------

/**
 * Deterministic 32-bit LCG. Same seed, same corpus, on every machine and run.
 *
 * The seed is scrambled and the first outputs discarded on purpose. A plain LCG seeded
 * with 1, 2, 3… moves its first output by only `1664525 / 2**32` per seed — about
 * 0.0004 — so 48 consecutive seeds picked the SAME element out of a 26-item list and the
 * "corpus" was 48 copies of one document. The coverage assertion below is what caught
 * that, which is why it exists.
 */
function makeRandom(seed: number): () => number {
	// Knuth's multiplicative hash spreads consecutive seeds across the whole range before
	// the LCG starts, and three discarded draws let the low bits mix.
	let state = Math.imul(seed >>> 0, 2_654_435_761) >>> 0;
	const next = () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
	next();
	next();
	next();
	return next;
}

/**
 * Values chosen because a serializer that treats them as YAML rather than as text
 * changes what the user's server receives. Each is a real token shape: base64 padding,
 * a bearer prefix, a URL, a JSON blob, a PEM fragment.
 */
const HOSTILE_SECRETS = [
	"*not-an-alias",
	"&not-an-anchor",
	"!!not-a-tag",
	"key: with-a-colon-space",
	"trailing-space ",
	" leading-space",
	"0123456789",
	"true",
	"null",
	"~",
	"12.0",
	"has # a hash",
	"has\ttab",
	"line-one\nline-two",
	"back\\slash",
	"quote'single",
	'quote"double',
	"{json: like}",
	"[bracketed]",
	"-----BEGIN KEY-----\nabc\n-----END KEY-----",
	`sk-live-${"x".repeat(200)}`,
	"ünïcödé-🔑",
	"%percent",
	"@at-sign",
	"`backtick`",
	"",
] as const;

/** Domains the generator may or may not include, so no single shape is always present. */
const OPTIONAL_DOMAINS: ReadonlyArray<[string, unknown]> = [
	["compaction", { threshold: "70%", reserveTokens: 4096 }],
	["display", { showTokenUsage: false, cacheMissMarker: true }],
	["argot", { enabled: false, tokenBudget: 512 }],
	["keybindings", { submit: "alt+enter", cancel: "ctrl+c" }],
	["theme", { dark: "porcelain", light: "titanium" }],
	["lsp", { formatOnWrite: true }],
];

interface GeneratedCase {
	seed: number;
	yaml: string;
	secret: string;
	unknownKey: string;
	unknownValue: string;
	domains: string[];
}

/** One config file: a hostile secret, a random set of domains, a key this build
 *  cannot know, and a comment the user wrote. */
function generateCase(seed: number): GeneratedCase {
	const random = makeRandom(seed);
	const secret = HOSTILE_SECRETS[Math.floor(random() * HOSTILE_SECRETS.length)] as string;
	const unknownKey = `futureKey${Math.floor(random() * 1_000_000)}`;
	const unknownValue = HOSTILE_SECRETS[Math.floor(random() * HOSTILE_SECRETS.length)] as string;
	const domains = OPTIONAL_DOMAINS.filter(() => random() < 0.6);
	const document: Record<string, unknown> = {
		temperature: 0.7,
		mcpServers: { generated: { command: "node", args: ["server.js"], env: { API_TOKEN: secret } } },
		[unknownKey]: unknownValue,
	};
	for (const [name, value] of domains) document[name] = value;
	// `YAML.stringify` produces whatever quoting each value needs, which is the point:
	// the file on disk is a legal document and the question is what survives a rewrite.
	return {
		seed,
		yaml: `# generated corpus case ${seed}\n${YAML.stringify(document)}`,
		secret,
		unknownKey,
		unknownValue,
		domains: domains.map(([name]) => name),
	};
}

const CORPUS_SIZE = 48;
const CORPUS = Array.from({ length: CORPUS_SIZE }, (_, index) => generateCase(index + 1));

describe("a generated corpus of rich configs, each carried through one write", () => {
	/**
	 * The corpus itself has to be worth running. A generator that produced 48 copies of
	 * the same document would make every assertion below pass while covering one case,
	 * so the shapes are counted before they are used.
	 */
	it("covers distinct secrets, unknown keys and domain sets", () => {
		expect(CORPUS).toHaveLength(CORPUS_SIZE);
		expect(new Set(CORPUS.map(one => one.secret)).size).toBeGreaterThan(8);
		expect(new Set(CORPUS.map(one => one.unknownKey)).size).toBe(CORPUS_SIZE);
		expect(new Set(CORPUS.map(one => one.domains.join(","))).size).toBeGreaterThan(8);
		// At least one case must carry each of the shapes that a YAML-naive rewrite
		// mangles, or the corpus is only nominally adversarial.
		const secrets = CORPUS.map(one => one.secret);
		expect(secrets.some(secret => secret.includes("\n"))).toBe(true);
		expect(secrets.some(secret => secret.startsWith("*"))).toBe(true);
		expect(secrets.some(secret => secret.endsWith(" "))).toBe(true);
	});

	/** The same seed produces the same file, so a failure below is reproducible from
	 *  the seed in its message rather than being a coin flip in CI. */
	it("regenerates identically from a seed", () => {
		expect(generateCase(7)).toEqual(generateCase(7));
		expect(generateCase(7).yaml).not.toBe(generateCase(8).yaml);
	});

	/**
	 * The property: for every case, the credential comes back as the SAME STRING, the
	 * unknown key survives, every seeded domain is intact, the requested write applied,
	 * and the file is owner-only. Any one of those failing for any case is a config the
	 * user loses on update.
	 */
	it("preserves the credential, the unknown key, the domains and the mode for every case", async () => {
		for (const one of CORPUS) {
			const { parsed, configPath } = await roundTrip({ config: one.yaml });
			const where = `seed ${one.seed} (secret ${JSON.stringify(one.secret)})`;

			const servers = parsed.mcpServers as Record<string, { env: Record<string, string> }>;
			expect(servers?.generated?.env?.API_TOKEN, where).toBe(one.secret);
			expect(parsed[one.unknownKey], where).toBe(one.unknownValue);
			for (const domain of one.domains) {
				expect(parsed[domain], `${where} domain ${domain}`).toEqual(
					OPTIONAL_DOMAINS.find(([name]) => name === domain)?.[1],
				);
			}
			expect(parsed.topP, where).toBe(0.9);
			expect(parsed.temperature, where).toBe(0.7);
			expect(((await fs.stat(configPath)).mode & 0o777).toString(8), where).toBe("600");
		}
	}, 120_000);

	/**
	 * The write must not GROW the document either. A rewrite that helpfully materialises
	 * every default the build knows about turns a twelve-line config into hundreds of
	 * lines the user never chose, and the next diff of their dotfiles is unreadable.
	 *
	 * `settingsMigrationVersion` is the ONE key the writer is allowed to add — it records
	 * which migrations have run, so it has to be in the file rather than inferred. It is
	 * listed explicitly rather than filtered out generically: the assertion's whole job is
	 * to fail the day a second bookkeeping key appears, and a loose "ignore keys we added"
	 * filter would accept exactly that.
	 */
	it("adds only the key it was asked to write, plus the migration marker", async () => {
		for (const one of CORPUS.slice(0, 12)) {
			const before = new Set(Object.keys(YAML.parse(one.yaml) as Record<string, unknown>));
			const { parsed } = await roundTrip({ config: one.yaml });
			const added = Object.keys(parsed).filter(key => !before.has(key));

			expect(added.sort(), `seed ${one.seed}`).toEqual(["settingsMigrationVersion", "topP"]);
		}
	}, 60_000);
});
