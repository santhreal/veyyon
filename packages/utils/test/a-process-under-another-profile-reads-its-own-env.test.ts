import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Contract: a veyyon process started by another veyyon process under a different profile runs on its
 * own profile's `.env` layers, never on the parent's.
 *
 * WHY THIS SUITE EXISTS. `/profile <name>` and `/resume` of another profile's session relaunch veyyon
 * with the parent's environment plus `VEYYON_PROFILE`, and `veyyon --profile <name>` run from a tool's
 * shell inherits the session's environment the same way. That environment held every variable the
 * parent had set from its `<configRoot>/.env` and `<agentDir>/.env`, and an inherited variable outranks
 * every `.env` file, so the child ran on the parent profile's credentials: a key both profiles set
 * resolved to the parent's value, and a key only the parent's profile set leaked into the child.
 *
 * THE CLASS THIS CLOSES is any per-profile `.env` layer surviving into a process under another
 * profile, however many veyyon processes it passed through. The check is in the child, where the
 * layers are applied, so it holds for every spawn site. Both per-profile layers are swept against
 * every direction between a named profile and the default one, and a chain carries a record through
 * a same-profile process before crossing. The negative controls: a same-profile child keeps the
 * values, and a variable the real environment set, or the parent changed at run time, still reaches
 * the child.
 * A variable set out of the parent profile's configuration at run time (the Exa key in
 * `<agentDir>/mcp.json`) goes through `setProfileEnv` and is dropped under another profile the same way.
 *
 * WHAT IT DOES NOT CATCH: a spawn that rewrites `VEYYON_DOTENV_ORIGIN` or strips it while keeping the
 * variables it describes.
 *
 * SUBPROCESSES, because the `.env` layers are applied once per process at module load.
 */

const UTILS_INDEX = path.join(import.meta.dir, "..", "src", "index.ts");
const KEY = "VEYYON_RELAUNCH_DOTENV_PROBE";
const LAYERS = ["agent", "configRoot"] as const;
type Layer = (typeof LAYERS)[number];
const DIRECTIONS = [
	{ parent: "work", child: "oss" },
	{ parent: "work", child: "default" },
	{ parent: "default", child: "work" },
] as const;

let root = "";

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "relaunch-dotenv-"));
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function layerDir(configRoot: string, profile: string, layer: Layer): string {
	const profileRoot = path.join(configRoot, "profiles", profile);
	return layer === "agent" ? path.join(profileRoot, "agent") : profileRoot;
}

interface Chain {
	/** The profile of each process; each one starts the next with its own environment. */
	profiles: readonly string[];
	layer: Layer;
	/** Profiles whose layer sets no value for the key. */
	unset?: readonly string[];
	/** A value for the key already in the first process's real environment. */
	real?: string;
	/** A value the first process assigns at run time before starting the next. */
	runtime?: string;
	/** A value the first process sets out of its profile's configuration before starting the next. */
	profileConfig?: string;
}

/** The key's value in each process of the chain. */
async function runChain(spec: Chain): Promise<string[]> {
	const caseRoot = fs.mkdtempSync(path.join(root, "case-"));
	const configRoot = path.join(caseRoot, "config");
	fs.mkdirSync(path.join(caseRoot, "home"));
	for (const profile of new Set(spec.profiles)) {
		const dir = layerDir(configRoot, profile, spec.layer);
		fs.mkdirSync(dir, { recursive: true });
		if (!spec.unset?.includes(profile)) fs.writeFileSync(path.join(dir, ".env"), `${KEY}=${profile}-value\n`);
	}
	const script = path.join(caseRoot, "probe.ts");
	fs.writeFileSync(
		script,
		`import { setProfileEnv } from ${JSON.stringify(UTILS_INDEX)};
const key = ${JSON.stringify(KEY)};
const [depth, ...rest] = process.argv.slice(2);
if (depth === "0") {
	const runtime = ${JSON.stringify(spec.runtime ?? null)};
	if (runtime !== null) process.env[key] = runtime;
	const profileConfig = ${JSON.stringify(spec.profileConfig ?? null)};
	if (profileConfig !== null) setProfileEnv(key, profileConfig);
}
const values = [Bun.env[key] ?? "(unset)"];
if (rest.length > 0) {
	// What a relaunch or a tool's shell does: the whole environment, with the next profile selected.
	const child = Bun.spawnSync([process.execPath, import.meta.path, String(Number(depth) + 1), ...rest.slice(1)], {
		env: { ...process.env, VEYYON_PROFILE: rest[0] },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (child.exitCode !== 0) throw new Error(child.stderr.toString());
	values.push(...JSON.parse(child.stdout.toString()));
}
console.log(JSON.stringify(values));
`,
	);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: path.join(caseRoot, "home"),
		VEYYON_CONFIG_DIR: configRoot,
		VEYYON_PROFILE: spec.profiles[0] ?? "",
	};
	if (spec.real !== undefined) env[KEY] = spec.real;
	const proc = Bun.spawn([process.execPath, "run", script, "0", ...spec.profiles.slice(1)], {
		cwd: caseRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(code, `probe process failed:\n${err}`).toBe(0);
	return JSON.parse(out.trim()) as string[];
}

describe("a veyyon process started under another profile", () => {
	for (const layer of LAYERS) {
		for (const { parent, child } of DIRECTIONS) {
			it(`reads ${child}'s ${layer} .env, not ${parent}'s`, async () => {
				expect(await runChain({ profiles: [parent, child], layer })).toEqual([`${parent}-value`, `${child}-value`]);
			});
		}
	}

	it("does not inherit a variable its own profile leaves unset", async () => {
		expect(await runChain({ profiles: ["work", "oss"], layer: "agent", unset: ["oss"] })).toEqual([
			"work-value",
			"(unset)",
		]);
	});

	it("drops the parent's values after passing through a same-profile process", async () => {
		expect(await runChain({ profiles: ["work", "work", "oss"], layer: "agent", unset: ["oss"] })).toEqual([
			"work-value",
			"work-value",
			"(unset)",
		]);
	});

	it("keeps a variable the real environment set", async () => {
		expect(await runChain({ profiles: ["work", "oss"], layer: "agent", real: "shell-value" })).toEqual([
			"shell-value",
			"shell-value",
		]);
	});

	it("keeps a variable the parent changed at run time", async () => {
		expect(await runChain({ profiles: ["work", "oss"], layer: "agent", runtime: "runtime-value" })).toEqual([
			"runtime-value",
			"runtime-value",
		]);
	});

	it("drops a variable the parent set from its profile's configuration", async () => {
		expect(
			await runChain({
				profiles: ["work", "oss"],
				layer: "agent",
				unset: ["work", "oss"],
				profileConfig: "config-value",
			}),
		).toEqual(["config-value", "(unset)"]);
	});

	it("keeps a variable the parent set from its profile's configuration under the same profile", async () => {
		expect(
			await runChain({ profiles: ["work", "work"], layer: "agent", unset: ["work"], profileConfig: "config-value" }),
		).toEqual(["config-value", "config-value"]);
	});
});
