import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Contracts: which `.env` file wins when two of them set the same key.
 *
 * WHY THIS SUITE EXISTS. Four files can set a variable, and the order between them is a product decision
 * a user relies on: a project's `.env` overrides your machine's, and your machine's overrides the profile
 * defaults. The order is
 *
 *     the real environment  >  <cwd>/.env  >  <agentDir>/.env  >  <configRoot>/.env  >  $HOME/.env
 *
 * and it used to be enforced by one loop applying the four parsed files in that sequence with
 * `if (!Bun.env[key])`, which is correct exactly because the sequence is the priority order.
 *
 * THE SPLIT BROKE THAT ARRANGEMENT AND HAD TO REBUILD IT. `$HOME/.env` moved into `src/dotenv-home.ts` so
 * that `src/dirs.ts` could see a home-level `VEYYON_CODING_AGENT_DIR` before it caches every path (see
 * `dotenv-reaches-the-resolver-through-any-import.test.ts` for the silent wrong directory that motivated
 * it). That makes the LOWEST-priority layer the FIRST one applied, so a first-writer-wins loop would have
 * quietly inverted home against the other three: a key set in both `$HOME/.env` and `<agentDir>/.env` would
 * start resolving to the home value. Nothing would have failed, and nothing in the old suite covered it.
 *
 * The rebuild is a recorded set: phase one exports the keys it injected, and phase two may displace exactly
 * those and nothing else, removing each from the set as it goes so the next (lower-priority) file cannot
 * displace it again. Every case below is one pair from that order, asserted on the resolved VALUE rather
 * than on which loop ran, because the value is what a user sees.
 *
 * SUBPROCESSES, because this is module-load behaviour: the environment is applied once per realm, so a
 * second case in the same process would read the first case's result.
 */

const UTILS_SRC = path.join(import.meta.dir, "..", "src");
const KEY = "VEYYON_DOTENV_PRECEDENCE_PROBE";

let root = "";

interface Layers {
	/** `<cwd>/.env`, which Bun itself applies before any module runs. */
	readonly project?: string;
	readonly agent?: string;
	readonly configRoot?: string;
	readonly home?: string;
	/** A value already in the real environment, which must beat every file. */
	readonly real?: string;
}

/**
 * Write the requested layers, then read the key back in a fresh process that imports the barrel.
 *
 * Each call gets its own home so the layers of one case cannot leak into another. The agent dir is pinned
 * through `VEYYON_CODING_AGENT_DIR`; the config root is NOT pinnable and is `<home>/.veyyon/profiles/default`,
 * which the last case in this file resolves in-process rather than trusting. That was measured, not assumed:
 * the first version of this fixture wrote the config-root layer under `XDG_CONFIG_HOME/veyyon/...` on the
 * assumption that the resolver is XDG-based, the file landed where nothing reads it, and two "prefers X over
 * $HOME" cases failed because only the home layer had been applied.
 */
async function resolveKeyWith(layers: Layers): Promise<string> {
	const caseHome = fs.mkdtempSync(path.join(root, "case-"));
	const caseWork = path.join(caseHome, "work");
	const caseAgent = path.join(caseHome, "agent");
	const caseConfig = path.join(caseHome, ".veyyon", "profiles", "default");
	for (const dir of [caseWork, caseAgent, caseConfig]) fs.mkdirSync(dir, { recursive: true });

	const write = (dir: string, value: string | undefined) => {
		if (value === undefined) return;
		fs.writeFileSync(path.join(dir, ".env"), `${KEY}=${value}\n`);
	};
	write(caseHome, layers.home);
	write(caseAgent, layers.agent);
	write(caseConfig, layers.configRoot);
	write(caseWork, layers.project);

	const script = path.join(caseWork, "probe.ts");
	fs.writeFileSync(
		script,
		[
			`import ${JSON.stringify(path.join(UTILS_SRC, "index.ts"))};`,
			`console.log(Bun.env[${JSON.stringify(KEY)}] ?? "(unset)");`,
		].join("\n"),
	);

	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: caseHome,
		VEYYON_CODING_AGENT_DIR: caseAgent,
	};
	if (layers.real !== undefined) env[KEY] = layers.real;

	const proc = Bun.spawn(["bun", "run", script], { cwd: caseWork, env, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(code, `probe process failed:\n${err}`).toBe(0);
	return out.trim();
}

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-precedence-"));
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("the .env layer that wins", () => {
	/** The floor: one file, and it is applied. Without this every case below could pass on an unset key. */
	it("applies $HOME/.env when nothing else sets the key", async () => {
		expect(await resolveKeyWith({ home: "from-home" })).toBe("from-home");
	});

	it("applies <configRoot>/.env when nothing else sets the key", async () => {
		expect(await resolveKeyWith({ configRoot: "from-config-root" })).toBe("from-config-root");
	});

	it("applies <agentDir>/.env when nothing else sets the key", async () => {
		expect(await resolveKeyWith({ agent: "from-agent-dir" })).toBe("from-agent-dir");
	});

	it("applies <cwd>/.env when nothing else sets the key", async () => {
		expect(await resolveKeyWith({ project: "from-project" })).toBe("from-project");
	});

	/**
	 * THE PAIR THE SPLIT COULD HAVE INVERTED. `$HOME/.env` is applied first now and is the lowest priority,
	 * so this is the case that fails if the displacement record is dropped or if phase two goes back to
	 * first-writer-wins.
	 */
	it("prefers <agentDir>/.env over $HOME/.env", async () => {
		expect(await resolveKeyWith({ home: "from-home", agent: "from-agent-dir" })).toBe("from-agent-dir");
	});

	it("prefers <configRoot>/.env over $HOME/.env", async () => {
		expect(await resolveKeyWith({ home: "from-home", configRoot: "from-config-root" })).toBe("from-config-root");
	});

	it("prefers <cwd>/.env over $HOME/.env", async () => {
		expect(await resolveKeyWith({ home: "from-home", project: "from-project" })).toBe("from-project");
	});

	/**
	 * And the order among the three phase-two layers is unchanged. These never moved, but they are the
	 * reason the displacement has to be REMOVED from the record as it happens: with the key still marked as
	 * home-injected, `<configRoot>/.env` would be allowed to displace the value `<agentDir>/.env` had just
	 * written, and the lowest-priority file of the three would win.
	 */
	it("prefers <agentDir>/.env over <configRoot>/.env", async () => {
		expect(await resolveKeyWith({ configRoot: "from-config-root", agent: "from-agent-dir" })).toBe("from-agent-dir");
	});

	it("prefers <cwd>/.env over <agentDir>/.env", async () => {
		expect(await resolveKeyWith({ agent: "from-agent-dir", project: "from-project" })).toBe("from-project");
	});

	/** All four at once, which is the whole order in one assertion. */
	it("resolves the full stack to the project's value", async () => {
		expect(
			await resolveKeyWith({
				home: "from-home",
				configRoot: "from-config-root",
				agent: "from-agent-dir",
				project: "from-project",
			}),
		).toBe("from-project");
	});

	/**
	 * A real environment variable beats every file, including through the displacement rule. This is the
	 * case that would break if phase two treated "already set" as "safe to overwrite": an operator who
	 * exports a variable for one command must not have it silently replaced by a file.
	 */
	it("prefers the real environment over every file", async () => {
		expect(
			await resolveKeyWith({
				real: "from-the-environment",
				home: "from-home",
				configRoot: "from-config-root",
				agent: "from-agent-dir",
				project: "from-project",
			}),
		).toBe("from-the-environment");
	});

	/**
	 * The three phase-two layers must not be able to displace a key that came from the real environment
	 * merely because a home file also set it. The displacement record holds keys phase one INJECTED, and a
	 * key already present was never injected, so it is not in the set.
	 */
	it("keeps the real environment even when $HOME/.env sets the same key", async () => {
		expect(await resolveKeyWith({ real: "from-the-environment", home: "from-home", agent: "from-agent-dir" })).toBe(
			"from-the-environment",
		);
	});

	/** Nothing set anywhere stays unset, so no case above can be satisfied by a stray default. */
	it("leaves the key unset when no layer mentions it", async () => {
		expect(await resolveKeyWith({})).toBe("(unset)");
	});
});

describe("the fixture itself", () => {
	/**
	 * NON-VACUITY for the whole file, and it has already earned it. Every case above writes two of its four
	 * layers into directories the fixture PREDICTS: `<home>/agent` via `VEYYON_CODING_AGENT_DIR`, and
	 * `<home>/.veyyon/profiles/default` for the config root. If either prediction is wrong the file lands
	 * where nothing reads it, and the damage is asymmetric: an "applies X" case fails loudly with `(unset)`,
	 * but a "prefers X over $HOME" case keeps PASSING, because home is the only layer that was really
	 * applied and home is the value it was told to expect. The first version of this fixture had exactly that
	 * bug for the config root, which it assumed was XDG-derived. So the two paths are resolved in-process and
	 * compared, and a layout change fails here rather than hollowing out nine cases in silence.
	 */
	it("pins the agent dir and the config root the layers are written into", async () => {
		const caseHome = fs.mkdtempSync(path.join(root, "dirs-"));
		const caseAgent = path.join(caseHome, "agent");
		const caseWork = path.join(caseHome, "work");
		fs.mkdirSync(caseAgent);
		fs.mkdirSync(caseWork);
		const script = path.join(caseWork, "probe.ts");
		fs.writeFileSync(
			script,
			[
				`import { getAgentDir, getConfigRootDir } from ${JSON.stringify(path.join(UTILS_SRC, "index.ts"))};`,
				// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${...} belongs to the child program this writes out and runs.
				"console.log(`${getAgentDir()}\\n${getConfigRootDir()}`);",
			].join("\n"),
		);

		const proc = Bun.spawn(["bun", "run", script], {
			cwd: caseWork,
			env: { PATH: process.env.PATH ?? "", HOME: caseHome, VEYYON_CODING_AGENT_DIR: caseAgent },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code, `probe process failed:\n${err}`).toBe(0);
		const [resolvedAgent, resolvedConfigRoot] = out.trim().split("\n");

		expect(resolvedAgent).toBe(caseAgent);
		expect(resolvedConfigRoot).toBe(path.join(caseHome, ".veyyon", "profiles", "default"));
	});
});
