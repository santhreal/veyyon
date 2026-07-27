import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getAgentDir,
	normalizeProfileName,
	resolveStartupProfile,
} from "@veyyon/utils/dirs";

/**
 * PROF-5: a profile name is attacker-adjacent input — it arrives from an env var
 * (`VEYYON_PROFILE`), a config file, or a CLI flag, and it is used to BUILD A
 * FILESYSTEM PATH under `<configRoot>/profiles/<name>`. If a name containing
 * `..` or a path separator were accepted, the "profile directory" would resolve
 * outside the profiles root, and everything keyed to it — credentials, sessions,
 * settings — would be read from and written to somewhere it should never touch.
 *
 * `normalizeProfileName` is the single validation owner. These tests pin its
 * exact contract and, more importantly, pin the END-TO-END property that matters:
 * no accepted profile name can produce an agent directory outside the profiles
 * root. Asserting the regex alone would let a future refactor keep the regex and
 * lose the containment.
 */
describe("a profile name can never escape the profiles root", () => {
	let tempRoot = "";
	const KEYS = [
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
		"VEYYON_PROFILE",
		"VEYYON_CODING_AGENT_DIR",
		"VEYYON_CONFIG_DIR",
	];
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of KEYS) saved[key] = process.env[key];
		for (const key of KEYS) delete process.env[key];
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-profile-containment-"));
		process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), tempRoot);
		__resetDirsFromEnvForTests();
	});

	afterEach(() => {
		for (const key of KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		__resetDirsFromEnvForTests();
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	describe("names that must be REJECTED", () => {
		// Each entry is a real escape or footgun, not a hypothetical: `..` walks out,
		// separators walk anywhere, a NUL byte truncates the path at the syscall
		// boundary, and a trailing dot is silently stripped by Windows.
		const rejected: ReadonlyArray<[label: string, value: string]> = [
			["parent traversal", ".."],
			["current dir", "."],
			["nested traversal", "../../etc"],
			["posix separator", "work/child"],
			["leading posix separator", "/etc/passwd"],
			["windows separator", "work\\child"],
			["absolute windows path", "C:\\Windows"],
			["trailing dot (stripped by Windows)", "work."],
			["NUL byte", "work\u0000evil"],
			["newline", "work\nevil"],
			["windows reserved CON", "CON"],
			["windows reserved NUL", "NUL"],
			["windows reserved COM1", "COM1"],
			["windows reserved with extension", "con.txt"],
		];

		for (const [label, value] of rejected) {
			it(`rejects ${label}: ${JSON.stringify(value)}`, () => {
				expect(() => normalizeProfileName(value)).toThrow(/Invalid profile/);
			});
		}
	});

	describe("names that must be ACCEPTED", () => {
		it("accepts an ordinary name unchanged", () => {
			expect(normalizeProfileName("work")).toBe("work");
		});

		it("accepts hyphens, underscores and digits", () => {
			expect(normalizeProfileName("client-sandbox_2")).toBe("client-sandbox_2");
		});

		it("trims surrounding whitespace rather than rejecting it", () => {
			expect(normalizeProfileName("  work  ")).toBe("work");
		});

		it("treats an empty or whitespace-only value as the default profile", () => {
			expect(normalizeProfileName("")).toBeUndefined();
			expect(normalizeProfileName("   ")).toBeUndefined();
			expect(normalizeProfileName(undefined)).toBeUndefined();
		});

		it("treats the literal name `default` as the default profile", () => {
			expect(normalizeProfileName("default")).toBeUndefined();
		});
	});

	describe("end-to-end containment", () => {
		it("an accepted profile resolves INSIDE the profiles root", () => {
			process.env.VEYYON_PROFILE = "work";
			__resetDirsFromEnvForTests();

			const agentDir = path.resolve(getAgentDir());
			const profilesRoot = path.resolve(path.join(tempRoot, "profiles"));
			const rel = path.relative(profilesRoot, agentDir);

			// The containment property itself: not merely "the name looked fine", but
			// "the path it produced is under profiles/".
			expect(rel.startsWith("..")).toBe(false);
			expect(path.isAbsolute(rel)).toBe(false);
			expect(agentDir).toContain(`${path.sep}profiles${path.sep}work${path.sep}`);
		});

		/**
		 * The contract is deliberately TWO-LAYER, and both halves matter:
		 *
		 *  - Module-load resolution (`getAgentDir`, via `resolveStartupProfileSafe`)
		 *    must NOT throw: a bad env value must not crash a bare `import` with an
		 *    uncaught stack trace before the CLI's error handling exists. It falls back
		 *    to the DEFAULT profile — which is the containment-safe outcome, since the
		 *    resolved path stays under `profiles/`.
		 *  - Startup validation (`resolveStartupProfile`, called from `cli.ts`) DOES
		 *    throw, so the user gets a clean error instead of silently running in the
		 *    wrong profile.
		 *
		 * Pinning both halves is the point: keeping only the first would let an invalid
		 * profile silently become `default` (profile contamination for anyone relying on
		 * isolation), and keeping only the second would crash bare imports.
		 */
		it("a traversal profile name falls back to the contained default at module load, never escaping", () => {
			process.env.VEYYON_PROFILE = "../../escaped";
			__resetDirsFromEnvForTests();

			const agentDir = path.resolve(getAgentDir());
			const profilesRoot = path.resolve(path.join(tempRoot, "profiles"));
			const rel = path.relative(profilesRoot, agentDir);

			expect(rel.startsWith("..")).toBe(false);
			expect(agentDir).toContain(`${path.sep}profiles${path.sep}default${path.sep}`);
		});

		it("startup validation rejects the same traversal name loudly, so it is never silently ignored", () => {
			process.env.VEYYON_PROFILE = "../../escaped";
			__resetDirsFromEnvForTests();

			// This is the layer cli.ts calls; without it the fallback above would be a
			// silent wrong-profile run.
			expect(() => resolveStartupProfile()).toThrow(/Invalid profile/);
		});

		it("no directory is created outside the profiles root by a rejected name", () => {
			process.env.VEYYON_PROFILE = "../escaped";
			try {
				__resetDirsFromEnvForTests();
				getAgentDir();
			} catch {
				// expected
			}
			// The sibling that a successful escape would have created must not exist.
			expect(fs.existsSync(path.join(path.dirname(tempRoot), "escaped"))).toBe(false);
		});
	});
});
