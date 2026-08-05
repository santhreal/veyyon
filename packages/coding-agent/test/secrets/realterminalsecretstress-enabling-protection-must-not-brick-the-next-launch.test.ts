/**
 * Locks out the startup lockout: turning secret protection ON must never stop the CLI from
 * starting.
 *
 * THE BUG. `assertFreshForExpansion` in `src/sdk.ts` threw when the vault revision captured at
 * lease time no longer matched, and startup rendering calls it. The revision moved on its own
 * because the fingerprint stat'd the vault's PARENT DIRECTORIES, and veyyon's own startup creates
 * and deletes entries in all three of them (SQLite `-wal` and `-shm` files, `sessions/`,
 * `cache/`). So the lease was invalid before the first frame drew. The result:
 *
 *     veyyon config set secrets.enabled true
 *     veyyon                                  # exit 1, no TUI, "Secret expansion was refused"
 *
 * WHAT BREAKS IF THIS REGRESSES. Every user who turns on Hide Secrets is locked out of the TUI
 * completely, from the first frame, with no input and no way back except editing config by hand.
 *
 * READ THIS BEFORE CHANGING THE FIRST CASE. It reproduces with an EMPTY VAULT: no secret is ever
 * stored, no second process runs, no placeholder is ever expanded. That is the whole point. The
 * bug was reported as "the vault changed in another session", and it is not; it needs no vault at
 * all. Adding a secret to that case to make it "more realistic" destroys exactly what it proves
 * and turns it into a duplicate of the third case. Leave it empty.
 *
 * WHY THIS DRIVES THE REAL BINARY. The unit layer is covered by the `vaultrevisionchurn-*` suites,
 * which pin `revision()` directly. Neither can see this bug: it only appears when a real process
 * writes its real state directories during a real startup. The cost of the churn was never a
 * wrong revision in isolation, it was a dead terminal, so the assertion has to be "the terminal
 * came up".
 *
 * NO CREDENTIALS REQUIRED. The CLI is launched with an empty auth root, so it reaches the "no
 * usable credentials" warning rather than a composer. That is fine and deliberate: the refusal
 * this test is about is printed BEFORE any of that and kills the process, so "did it get as far
 * as complaining about credentials" is a sound, hermetic, offline proxy for "it started".
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import {
	createIsolatedRoot,
	destroyIsolatedRoot,
	type IsolatedRoot,
	runCliPiped,
	useCliEntry,
	vaultPath,
} from "../../../../scripts/secret-stress/lib/isolation";
import { InteractiveCli } from "../../../../scripts/secret-stress/lib/pty";

/** The message the bug printed instead of drawing a terminal. */
const REFUSAL = "Secret expansion was refused";

/**
 * Proof the process got past startup: it drew a frame.
 *
 * ONE LITERAL, and the strict one. The refusal this file is about kills the process before any
 * frame exists, so the warning that no model is usable is only ever printed by a process that
 * got as far as rendering, which is exactly the claim each case makes.
 *
 * This was briefly widened to also accept the composer's "ask anything", because a workstation
 * running Ollama has a usable model with no auth root at all and drew a composer on a supposedly
 * empty root, so all five cases hung here. The fix belonged in the harness, not the assertion:
 * `createIsolatedRoot(label, "none")` now points the keyless local providers at a closed port,
 * so a root with no credentials really has no model on any machine. Accepting two frames made
 * the marker weaker for no gain once that hole was shut, so it is back to one.
 */
const REACHED_STARTUP = "No models are available";

/** Startup on a cold temp root has to load the model registry, which is not instant. */
const LAUNCH_TIMEOUT_MS = 60_000;

const roots: IsolatedRoot[] = [];

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) destroyIsolatedRoot(root);
	}
});

/** A machine of its own per case: a cold start is only cold once, and roots must not share a vault. */
async function isolatedMachine(label: string): Promise<IsolatedRoot> {
	useCliEntry(new URL("../../src/cli.ts", import.meta.url).pathname);
	const root = await createIsolatedRoot(label, "none");
	roots.push(root);
	return root;
}

/** Launch the TUI and report what the terminal actually received. */
async function launchTui(root: IsolatedRoot): Promise<{ refused: boolean; reachedStartup: boolean; text: string }> {
	const cli = new InteractiveCli(root, [], {
		env: { VEYYON_SKIP_SETUP: "1" },
		timeoutMs: LAUNCH_TIMEOUT_MS,
	});
	cli.start();
	// Either outcome is a burst of output; wait for the process to say anything substantial.
	await cli.waitFor(new RegExp(`${REFUSAL}|${REACHED_STARTUP}`), LAUNCH_TIMEOUT_MS - 10_000);
	const capture = await cli.close();
	return {
		refused: capture.plain.includes(REFUSAL),
		reachedStartup: capture.plain.includes(REACHED_STARTUP),
		text: capture.plain.trim(),
	};
}

async function enableProtection(root: IsolatedRoot): Promise<void> {
	const result = await runCliPiped(root, ["config", "set", "secrets.enabled", "true"]);
	expect(result.exitCode, `enabling protection failed: ${result.text}`).toBe(0);
}

/**
 * Run one `/secret` subcommand in its own process.
 *
 * The dummy API key is there because the CLI resolves a model before it dispatches a prompt, even
 * for a slash command that will never call one. It makes the registry resolvable and nothing
 * more; no request is issued, so the test stays offline. The TUI launches in {@link launchTui}
 * deliberately do NOT get it, because "no usable credentials" is the marker proving startup ran.
 *
 * `--from-env` is not a style choice: a noninteractive surface refuses an inline value outright,
 * so it is the only form that works from a piped process.
 */
async function secretCommand(root: IsolatedRoot, command: string, seed?: string): Promise<void> {
	const env: Record<string, string> = { ANTHROPIC_API_KEY: "not-a-real-key-no-request-is-made" };
	if (seed !== undefined) env.SEED_VALUE = seed;
	const result = await runCliPiped(root, ["-p", command], { env });
	expect(result.exitCode, `\`${command}\` failed: ${result.text}`).toBe(0);
}

describe("enabling secret protection must not brick the next launch", () => {
	/**
	 * THE REPRO, and the smallest one that exists. Two commands, an empty vault, one process.
	 * Do not add a secret here. See the file header.
	 */
	it("starts with protection on and a vault that has never held a secret", async () => {
		const root = await isolatedMachine("empty-protected");
		await enableProtection(root);

		const launch = await launchTui(root);

		expect(launch.refused, `the TUI died at startup instead of drawing:\n${launch.text}`).toBe(false);
		expect(launch.reachedStartup).toBe(true);
	}, 120_000);

	/**
	 * The control that makes the case above mean something. If protection OFF also failed, the
	 * test would be measuring a broken harness rather than this bug.
	 */
	it("starts with protection off, which is the setting that always worked", async () => {
		const root = await isolatedMachine("empty-unprotected");

		const launch = await launchTui(root);

		expect(launch.refused).toBe(false);
		expect(launch.reachedStartup).toBe(true);
	}, 120_000);

	/** Protection on with a real stored secret: the state a user is actually in day to day. */
	it("starts with protection on and a secret stored in the vault", async () => {
		const root = await isolatedMachine("stored-protected");
		await enableProtection(root);
		await secretCommand(
			root,
			"/secret add STARTUP_TOKEN --from-env SEED_VALUE",
			"startup-token-value-not-a-real-credential",
		);

		const launch = await launchTui(root);

		expect(launch.refused, `the TUI died at startup instead of drawing:\n${launch.text}`).toBe(false);
		expect(launch.reachedStartup).toBe(true);
	}, 120_000);

	/**
	 * The case the bug was originally FILED as: a second process really did change the vault
	 * before this one started. It has to keep working, but note it is no longer special; it now
	 * passes for the same reason the empty-vault case does.
	 */
	it("starts after a second process added and removed a secret", async () => {
		const root = await isolatedMachine("externally-changed");
		await enableProtection(root);
		await secretCommand(
			root,
			"/secret add TRANSIENT_TOKEN --from-env SEED_VALUE",
			"transient-token-value-not-a-real-credential",
		);
		await secretCommand(root, "/secret rm TRANSIENT_TOKEN");

		const launch = await launchTui(root);

		expect(launch.refused, `the TUI died at startup instead of drawing:\n${launch.text}`).toBe(false);
		expect(launch.reachedStartup).toBe(true);
	}, 120_000);

	/**
	 * Adversarial: the vault FILE is gone, deleted under the session after a secret was stored.
	 * This is the largest possible revision change short of corruption, so if anything still
	 * fingerprints something other than the file's own contents, it shows up here.
	 *
	 * NOT COVERED HERE, deliberately: a vault whose bytes are present but unparseable. That does
	 * still take the terminal down (exit 1, "is not valid JSON", no frame), which is the same
	 * class of defect as this file's but a different cause, in a different lane's file. It is
	 * reported separately rather than asserted here, because a test in this suite that accepted a
	 * dead terminal would contradict the suite's own thesis.
	 */
	it("starts with protection on after the vault file is deleted underneath it", async () => {
		const root = await isolatedMachine("deleted-protected");
		await enableProtection(root);
		await secretCommand(
			root,
			"/secret add DOOMED_TOKEN --from-env SEED_VALUE",
			"doomed-token-value-not-a-real-credential",
		);
		fs.unlinkSync(vaultPath(root, "profile"));

		const launch = await launchTui(root);

		expect(launch.refused, `a deleted vault took the terminal down:\n${launch.text}`).toBe(false);
		expect(launch.reachedStartup).toBe(true);
	}, 120_000);
});
