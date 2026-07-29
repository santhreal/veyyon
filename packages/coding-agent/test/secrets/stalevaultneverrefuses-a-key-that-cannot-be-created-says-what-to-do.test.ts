/**
 * Secret protection that cannot start must say so, not die mid-launch or start unprotected.
 *
 * THE BUG THIS LOCKS OUT. `loadOrCreateVaultKey` throws on any key-provisioning failure
 * (a key root that cannot be hardened, a symlinked or read-only `~/.veyyon`, an exotic
 * filesystem, anything occupying the key path). `sdk.ts` awaits it uncaught inside
 * `loadSecretRuntime`, which is itself awaited during session construction, so for anyone
 * with `secrets.enabled true` that was an uncatchable startup abort: veyyon died before the
 * second frame and nothing on screen said why.
 *
 * The fix keeps the failure FATAL and makes it ACTIONABLE. Both halves are load-bearing and
 * both are asserted here:
 *
 *   - Fatal, because degrading to a no-secrets session is fail-OPEN on a security control.
 *     Without a placeholder key there is no obfuscator, and the obfuscator is what REDACTS.
 *     Stored secrets merely become unavailable, which is survivable, but env-derived values
 *     this session would have redacted would reach the model, the transcript and the session
 *     file in the clear, silently, after the operator explicitly turned protection ON.
 *   - Actionable, because a raw rejected promise is not a decision anyone can act on.
 *
 * IF THIS REGRESSES: either veyyon goes back to dying with a bare stack (or nothing at all)
 * on a launch the operator cannot diagnose, or, far worse, it starts "successfully" with
 * redaction silently switched off. Do NOT make a failure here pass by letting the session
 * continue without a key. The last test is the one that catches that shortcut: the escape
 * hatch must be a decision the operator makes by hand, never one the code makes for them.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");
const roots = new Set<string>();

interface Fixture {
	readonly home: string;
	readonly project: string;
	readonly keyPath: string;
}

interface Run {
	readonly exitCode: number;
	readonly output: string;
}

async function fixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-vault-key-fatal-"));
	roots.add(root);
	const home = path.join(root, "home");
	const project = path.join(root, "project");
	await fs.mkdir(home, { recursive: true });
	await fs.mkdir(project, { recursive: true });
	return { home, project, keyPath: path.join(home, ".veyyon", "vault.key") };
}

/**
 * Run the real CLI against an isolated HOME, so the key root under test is the only one touched.
 *
 * The environment is built from scratch rather than spread from `Bun.env`: the test runner's own
 * environment carries loader settings that make the child fail to build, and inheriting provider
 * credentials would make these assertions depend on whose machine they run on.
 */
async function run(fixture: Fixture, args: string[]): Promise<Run> {
	const child = Bun.spawn([process.execPath, CLI, ...args], {
		cwd: fixture.project,
		env: { PATH: Bun.env.PATH ?? "", HOME: fixture.home, TERM: "dumb" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => child.kill(), 60_000);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { exitCode, output: stdout + stderr };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Occupy the key path with a directory. `loadOrCreateVaultKey` refuses to treat it as a key,
 * which reproduces the provisioning failure without needing a read-only mount or a root-owned
 * path that a test cannot create portably.
 */
async function breakKeyPath(fixture: Fixture): Promise<void> {
	await fs.mkdir(fixture.keyPath, { recursive: true });
}

afterEach(async () => {
	for (const root of roots) await fs.rm(root, { recursive: true, force: true });
	roots.clear();
});

describe("a session whose secret key cannot be created", () => {
	it("refuses to start, and the refusal names the key path and the way out", async () => {
		const f = await fixture();
		await run(f, ["config", "set", "secrets.enabled", "true"]);
		await breakKeyPath(f);

		const { exitCode, output } = await run(f, ["-p", "say hi"]);

		expect(exitCode).not.toBe(0);
		expect(output).toContain("Secret protection is enabled");
		// The two facts that make this a decision rather than a crash: WHERE the problem is,
		// and the exact command that starts veyyon without protection if that is the choice.
		expect(output).toContain(f.keyPath);
		expect(output).toContain("veyyon config set secrets.enabled false");
	});

	it("reports the underlying cause instead of swallowing it", async () => {
		const f = await fixture();
		await run(f, ["config", "set", "secrets.enabled", "true"]);
		await breakKeyPath(f);

		const { output } = await run(f, ["-p", "say hi"]);

		// Wrapping the provisioning error must not discard it: "could not be initialized" with
		// no reason sends the operator hunting. The chained cause is what names the real fault.
		expect(output).toContain("caused by:");
		expect(output).toContain("vault.key");
	});

	it("fails deliberately, with no stack trace and no unhandled rejection", async () => {
		const f = await fixture();
		await run(f, ["config", "set", "secrets.enabled", "true"]);
		await breakKeyPath(f);

		const { output } = await run(f, ["-p", "say hi"]);

		// An unwound promise is the exact shape of the bug. If the throw escapes uncaught again
		// the runtime prints an unhandled-rejection report, and stack frames come with it.
		expect(output).not.toMatch(/unhandled/i);
		expect(output).not.toMatch(/^\s+at\s+\S+/m);
	});

	it("does not fire when the key root is healthy and the vault is merely empty", async () => {
		const f = await fixture();
		await run(f, ["config", "set", "secrets.enabled", "true"]);

		const { output } = await run(f, ["-p", "say hi"]);

		// The adversarial case for a fail-closed guard is over-triggering. `secrets.enabled true`
		// with zero stored secrets is the ordinary state of a new install and must launch. This
		// asserts only the ABSENCE of the refusal, so it holds whether the provider answers,
		// rejects, or is unreachable, and needs no network of its own.
		expect(output).not.toContain("Secret protection is enabled");
	});

	it("honours the escape hatch it advertises, leaving the key path still broken", async () => {
		const f = await fixture();
		await run(f, ["config", "set", "secrets.enabled", "true"]);
		await breakKeyPath(f);
		const refused = await run(f, ["-p", "say hi"]);
		expect(refused.output).toContain("Secret protection is enabled");

		// Exactly the command the refusal printed, and nothing else: the key path stays occupied.
		await run(f, ["config", "set", "secrets.enabled", "false"]);
		const { output } = await run(f, ["-p", "say hi"]);

		// A message that tells the operator to run a command that does not actually help is worse
		// than no message. Same broken key, protection off, and the session gets past secret init.
		expect(output).not.toContain("Secret protection is enabled");
		await expect(fs.stat(f.keyPath).then(s => s.isDirectory())).resolves.toBe(true);
	});
});
