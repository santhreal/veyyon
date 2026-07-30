/**
 * The reported crash, reproduced from the outside.
 *
 * THE CLAIM UNDER TEST. A live session holds a vault revision it read at startup. When a SECOND
 * process changes any vault, that revision goes stale. The product's expansion guard treats a
 * stale revision as a refusal rather than a cache miss, and it is reached from RENDER paths, so
 * the refusal is thrown where nothing catches it and the whole TUI unwinds. Two consequences a
 * user sees: an ordinary command with no `#NAME#` anywhere in it gets refused, and the session
 * dies instead of showing an error.
 *
 * WHY THIS HAS TO BE A REAL TERMINAL WITH TWO REAL PROCESSES. The staleness is a property of two
 * processes disagreeing about a file on disk, and the crash is a property of a throw escaping a
 * render pass. Neither exists when the guard is called directly from a unit test with a hand-built
 * vault, which is why this shipped: the layer was verified, the situation was not.
 *
 * EVERY SCENARIO HERE FAILS LOUDLY RATHER THAN HANGING. A dead TUI and a slow TUI look the same
 * from outside, so each step has a bounded wait and reports which of the two it saw.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createIsolatedRoot, destroyIsolatedRoot, type IsolatedRoot, runCliPiped } from "../lib/isolation";
import { InteractiveCli, KEY, stripAnsi } from "../lib/pty";
import { COMPOSER_READY, type Ctx, modelArgs, newSeed } from "./context";

/** The exact refusal the guard throws. Matched as a substring so wording changes still register. */
const STALE_REFUSAL = "vault changed in another session or process";

/** A crash leaves one of these in the stream, where a handled error would not. */
const UNWIND_MARKERS = [
	"Secret expansion was refused",
	"Unhandled error",
	"UnhandledPromiseRejection",
	"error: Secret expansion",
];

/**
 * What the persisted session store contains, which is the artifact that decides severity.
 *
 * The session file is what gets replayed to a provider. A credential on screen but NOT in the
 * store is a local exposure: scrollback, screen recordings, a shoulder. A credential IN the store
 * is outbound disclosure, because that text is what the next request carries. Those need
 * different responses, so the harness reads the store rather than guessing from the terminal.
 */
interface SessionStoreVerdict {
	/** Files inspected, so "clean" can be distinguished from "found nothing to inspect". */
	filesRead: number;
	/** The raw credential is persisted. Outbound disclosure. */
	hasCredential: boolean;
	/** The placeholder is persisted, which is what a correct build writes. */
	hasPlaceholder: boolean;
}

/** Recorded session state lives under the isolated HOME; sweep it all rather than name one path. */
export async function classifySessionStore(iso: IsolatedRoot, credential: string): Promise<SessionStoreVerdict> {
	const verdict: SessionStoreVerdict = { filesRead: 0, hasCredential: false, hasPlaceholder: false };
	const walk = (dir: string): string[] => {
		const found: string[] = [];
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return found;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) found.push(...walk(full));
			else if (entry.isFile() && /\.(jsonl?|db|txt)$/.test(entry.name)) found.push(full);
		}
		return found;
	};
	for (const file of walk(iso.home)) {
		let text: string;
		try {
			text = await Bun.file(file).text();
		} catch {
			continue; // binary or unreadable; the plaintext sweep in spend.ts covers those
		}
		verdict.filesRead += 1;
		if (text.includes(credential)) verdict.hasCredential = true;
		if (text.includes("#STRESS_STALE#")) verdict.hasPlaceholder = true;
	}
	return verdict;
}

/** Turn the two surfaces into the sentence a reader needs, naming the mechanism and the severity. */
export function describeLeak(store: SessionStoreVerdict): string {
	if (store.hasCredential) {
		return (
			"OUTBOUND DISCLOSURE: the credential is in the persisted session store as well as on screen, " +
			"so it is in what gets replayed to the provider."
		);
	}
	if (store.hasPlaceholder) {
		return (
			"DISPLAY-ONLY EXPOSURE: the session store holds the PLACEHOLDER, so the model wrote " +
			"`#STRESS_STALE#` and nothing went outward; veyyon's own display expander substituted the " +
			"value on the way to the screen. Screen and scrollback only."
		);
	}
	return `INCONCLUSIVE: swept ${store.filesRead} session file(s) and found neither the credential nor the placeholder.`;
}

async function bootTui(ctx: Ctx, extraArgs: readonly string[] = []): Promise<InteractiveCli | null> {
	const cli = new InteractiveCli(ctx.iso, [...modelArgs(ctx), ...extraArgs], {
		env: { VEYYON_SKIP_SETUP: "1" },
		timeoutMs: 240_000,
	});
	cli.start();
	if ((await cli.waitFor(COMPOSER_READY, 60_000)) !== "matched") {
		await cli.close();
		return null;
	}
	return cli;
}

/**
 * Change a vault from a different process, the way a second window or a script would.
 *
 * Returns the mutation's own output so a scenario can report a mutation that itself failed rather
 * than blaming the session under test for a state that was never created.
 */
async function mutateFromSecondProcess(ctx: Ctx, tag: string): Promise<{ ok: boolean; text: string }> {
	const seed = newSeed(`second-${tag}`);
	ctx.rec.protect(seed);
	const result = await runCliPiped(
		ctx.iso,
		[...modelArgs(ctx), "-p", `/secret add STRESS_SECOND_${tag} --from-env V`],
		{
			env: { V: seed },
		},
	);
	return { ok: /Stored|Replaced/.test(result.text), text: result.text.trim().split("\n")[0] ?? "" };
}

export async function runStaleVaultScenarios(ctx: Ctx): Promise<void> {
	ctx.rec.group("stale vault: the reported crash");
	const { rec } = ctx;

	if (!ctx.hasModel) {
		rec.record({
			name: "an ordinary command with no placeholder is not refused after another process changes the vault",
			verdict: "NOT RUN",
			observed: "no model credential resolved",
			detail: "the command has to become a real tool call, which needs a model turn",
		});
		return;
	}

	const cli = await bootTui(ctx, ["--approval-mode", "yolo"]);
	if (cli === null) {
		rec.record({
			name: "a session with a stored secret starts in a real terminal",
			verdict: "FAIL",
			observed: "the composer never appeared within 60s",
			detail: "the crash scenarios cannot be reached without a live session",
		});
		return;
	}

	try {
		// ── set the stage: this session holds a live secret and therefore a vault revision ──
		const liveSeed = newSeed("stale-live");
		rec.protect(liveSeed);
		await cli.submit("/secret add STRESS_STALE", { afterMs: 2_000 });
		if ((await cli.waitFor(/Paste the value for STRESS_STALE/, 15_000)) !== "matched") {
			rec.record({
				name: "a session with a stored secret starts in a real terminal",
				verdict: "FAIL",
				observed: "the masked entry prompt never appeared, so no secret could be stored in-session",
				detail: "the crash needs a session that has read a vault revision",
			});
			return;
		}
		cli.send(liveSeed);
		await Bun.sleep(600);
		cli.send(KEY.enter);
		const stored = await cli.waitFor(/Stored STRESS_STALE/, 15_000);
		rec.check(
			"a session with a stored secret starts in a real terminal",
			stored === "matched",
			stored === "matched" ? "Stored STRESS_STALE in the profile vault" : "the secret was not stored in-session",
			"could not reach the state the crash needs",
		);
		ctx.seeds.STRESS_STALE = liveSeed;
		await cli.settle();

		// ── a SECOND process changes the vault underneath the live session ──
		const mutation = await mutateFromSecondProcess(ctx, "A");
		rec.check(
			"a second process can change the vault while a session holds it open",
			mutation.ok,
			mutation.text || "(no output)",
			"the antagonist process could not mutate the vault, so nothing below is exercising staleness",
		);

		// ── THE REPORTED CRASH: an ordinary command with no placeholder anywhere in it ──
		const beforeOrdinary = cli.plain.length;
		await cli.submit('Run this exact bash command and nothing else: echo "$HOME"; echo ---; ls -la "$HOME"', {
			afterMs: 3_000,
		});
		await cli.settle(2_000, 60_000);
		const ordinary = cli.plain.slice(beforeOrdinary);
		const refusedOrdinary = ordinary.includes(STALE_REFUSAL);
		rec.check(
			"a command containing no placeholder is not refused after the vault changed elsewhere",
			!refusedOrdinary,
			refusedOrdinary
				? `the terminal printed: "${STALE_REFUSAL}" for a command with zero placeholders in it`
				: "the command ran without any staleness refusal",
			"a stale revision refuses text that has no secret in it at all, so an unrelated command is blocked",
			rec.writeCapture("crash-ordinary-command", cli.raw),
		);

		const diedOnOrdinary = cli.exited;
		rec.check(
			"the session survives an ordinary command after the vault changed elsewhere",
			!diedOnOrdinary,
			diedOnOrdinary
				? `the TUI exited (code ${cli.result?.exitCode ?? "none"}) instead of drawing a result`
				: "the TUI is still alive and drew a result",
			"the refusal is thrown on a render path, so it unwinds the whole session instead of failing one call",
			rec.writeCapture("crash-ordinary-command-exit", cli.raw),
		);

		if (cli.exited) {
			rec.record({
				name: "the remaining stale-vault scenarios",
				verdict: "NOT RUN",
				observed: "the session died on the previous scenario",
				detail: "cannot drive a session that is gone; fix the crash and rerun",
			});
			return;
		}

		const stillIdle = await cli.waitFor(COMPOSER_READY, 10_000);
		rec.check(
			"the composer still accepts input after the ordinary command",
			stillIdle === "matched",
			stillIdle === "matched" ? "the composer prompt is drawn again" : `the composer never came back (${stillIdle})`,
			"the session is wedged even though the process is alive",
		);

		// ── the same again, but WITH a placeholder: staleness must refresh, not refuse ──
		await mutateFromSecondProcess(ctx, "B");
		const beforePlaceholder = cli.plain.length;
		await cli.submit(
			"Run this exact bash command and nothing else: " +
				'printf %s "#STRESS_STALE#" | sha256sum | cut -c1-64 > ./spent-digest.txt',
			{ afterMs: 3_000 },
		);
		await cli.settle(2_000, 90_000);
		const withPlaceholder = cli.plain.slice(beforePlaceholder);
		const refusedPlaceholder = withPlaceholder.includes(STALE_REFUSAL);
		rec.check(
			"a placeholder-carrying command refreshes the runtime and spends, rather than refusing",
			!refusedPlaceholder,
			refusedPlaceholder
				? `the terminal printed: "${STALE_REFUSAL}" instead of refreshing and expanding`
				: "the placeholder command was not refused for staleness",
			"a stale revision is a cache miss, and the refresh is already scheduled on the line above the throw",
			rec.writeCapture("crash-placeholder-command", cli.raw),
		);
		rec.check(
			"the session survives a placeholder-carrying command after the vault changed elsewhere",
			!cli.exited,
			cli.exited ? `the TUI exited (code ${cli.result?.exitCode ?? "none"})` : "the TUI is still alive",
			"the expansion failure took the session down instead of failing one tool call",
		);

		// Whatever happened above, the value must not be anywhere in the stream.
		//
		// THE VERDICT DIAGNOSES ITSELF, and it has to. A whole-stream sweep can tell you a
		// credential is on screen but not HOW it got there, and the two possible causes need
		// opposite responses. When this first fired I read the terminal alone, saw the value in
		// assistant prose, and concluded the model had been handed it, which would have meant
		// disclosure to a provider. That was wrong, and the artifact that proves it wrong is the
		// SESSION FILE: it is what gets replayed outward, so what it contains is what a third
		// party could ever see. The model had written `#STRESS_STALE#`; veyyon's own display
		// expander substituted the value on the way to the screen.
		//
		// So the sweep now reads both surfaces and names the mechanism, and a future occurrence
		// tells the reader which defect they have instead of inviting the same wrong inference.
		const leakIndex = cli.raw.indexOf(liveSeed);
		const onDisk = await classifySessionStore(ctx.iso, liveSeed);
		rec.check(
			"no stored value ever reached the terminal during the stale-vault scenarios",
			leakIndex === -1,
			leakIndex === -1
				? "the live credential appears nowhere in the session's bytes"
				: `${describeLeak(onDisk)} On screen at byte ${leakIndex}, in this context: ` +
						JSON.stringify(
							stripAnsi(cli.raw.slice(Math.max(0, leakIndex - 120), leakIndex))
								.slice(-90)
								.trim(),
						),
			"a credential reached a surface it must never reach",
		);

		const spent = Bun.file(`${ctx.iso.project}/spent-digest.txt`);
		if (await spent.exists()) {
			const digest = (await spent.text()).trim();
			const expected = new Bun.CryptoHasher("sha256").update(liveSeed).digest("hex");
			rec.check(
				"the real credential, not the placeholder text, reached the spawned process",
				digest === expected,
				digest === expected
					? "the command hashed the credential itself"
					: "the command hashed something other than the credential",
				"the placeholder was passed through literally, so the tool received `#STRESS_STALE#` and not the secret",
			);
		} else {
			rec.record({
				name: "the real credential, not the placeholder text, reached the spawned process",
				verdict: "NOT RUN",
				observed: "the model never produced the bash call that would have written the digest",
				detail: "no digest file at ./spent-digest.txt after the turn settled",
			});
		}
	} finally {
		const capture = await cli.close();
		rec.writeCapture("stale-vault-session", capture.raw);
	}
}

/**
 * Cold launch: does the TUI come up at all, across every combination of the two settings that
 * decide whether the expansion guard is live?
 *
 * WHY A MATRIX AND NOT ONE CASE. The ticket, and the peer lane's first repro, both describe this
 * as "another process changed the vault". Driving the real binary through this matrix showed that
 * is not the trigger. On the pre-fix build the launch dies with the staleness refusal when secret
 * protection is ON, INCLUDING with a completely empty vault and no second process anywhere:
 *
 *     veyyon config set secrets.enabled true
 *     veyyon                                  # exit 1, 362 bytes, no TUI frame
 *
 * Turning on Hide Secrets bricks the next launch by itself. The only reason that is not a
 * permanent lockout today is a SECOND defect: the enable that `/secret add` announces as "saved
 * for the next one" never persists, so the setting that bricks you also fails to stick. A single
 * case would have found one cell of this and mis-attributed the cause, so every cell runs and
 * every cell is reported, including the ones that pass.
 *
 * Each row is an independent isolated root: a cold start is only cold once.
 */
const COLD_START_CASES = [
	{ name: "an empty vault with protection off", protection: false, store: false, remove: false },
	{ name: "an empty vault with protection ON", protection: true, store: false, remove: false },
	{ name: "a stored secret with protection off", protection: false, store: true, remove: false },
	{ name: "a stored secret with protection ON", protection: true, store: true, remove: false },
	{ name: "a secret stored and then removed by another process", protection: true, store: true, remove: true },
] as const;

export async function runColdStartAfterExternalChange(ctx: Ctx): Promise<void> {
	ctx.rec.group("cold start: does the TUI come up at all");
	const { rec } = ctx;

	for (const testCase of COLD_START_CASES) {
		// A fresh root per row. Reusing one would let an earlier row's vault decide a later one.
		const iso = await createIsolatedRoot("cold", ctx.auth);
		const caseCtx: Ctx = { ...ctx, iso };
		try {
			if (testCase.protection) await runCliPiped(iso, ["config", "set", "secrets.enabled", "true"]);
			if (testCase.store) {
				const seed = newSeed("cold");
				rec.protect(seed);
				await runCliPiped(iso, [...modelArgs(caseCtx), "-p", "/secret add STRESS_COLD --from-env V"], {
					env: { V: seed },
				});
			}
			if (testCase.remove) await runCliPiped(iso, [...modelArgs(caseCtx), "-p", "/secret rm STRESS_COLD"]);

			const cli = new InteractiveCli(iso, [...modelArgs(caseCtx), "--approval-mode", "yolo"], {
				env: { VEYYON_SKIP_SETUP: "1" },
				timeoutMs: 90_000,
			});
			cli.start();
			const ready = await cli.waitFor(COMPOSER_READY, 45_000);
			const capture = await cli.close();
			const capturePath = rec.writeCapture(`cold-start-${testCase.name.replace(/\s+/g, "-")}`, capture.raw);
			const marker = UNWIND_MARKERS.find(m => capture.plain.includes(m));

			rec.check(
				`a cold launch with ${testCase.name} reaches an interactive composer`,
				ready === "matched" && marker === undefined,
				ready === "matched"
					? marker === undefined
						? "the composer was drawn, no expansion error anywhere in the stream"
						: `the composer appeared but the stream carries "${marker}"`
					: `no composer: exit code ${capture.exitCode ?? "none"} after ${capture.plain.trim().length} bytes; ` +
							`the terminal showed "${capture.plain.trim().split("\n").filter(Boolean)[0]?.slice(0, 120) ?? ""}"`,
				"the session is unusable from the first frame, with no input and nothing the user can do about it",
				capturePath,
			);
		} finally {
			destroyIsolatedRoot(iso);
		}
	}
}

/**
 * The root cause, pinned directly rather than through its symptom.
 *
 * `VaultRevisionChurn` traced the startup lockout to the revision fingerprint stat'ing the vault's
 * PARENT DIRECTORIES. A directory's mtime and ctime move whenever any entry inside it is created
 * or removed, and veyyon's own startup churns all three parents constantly: SQLite creates and
 * deletes `-wal` and `-shm` around every connection, plus `sessions/`, `cache/`, `blobs/`. So the
 * revision captured at lease time was stale before the first frame drew, with nothing about the
 * vault having changed at all. Their fix makes the fingerprint a function of the vault FILE alone.
 *
 * HOW THIS OBSERVES IT WITHOUT A FINGERPRINT READOUT. There is no `secret revision` command and
 * inventing one to test with would be testing a thing users do not have. Instead this rides the
 * property's user-visible consequence: when the revision moves under a live session, the session
 * says so, with "The secret vault changed in another session or process". That notice is the only
 * externally visible evidence the fingerprint moved, so a run where nothing touched the vault and
 * the notice never appears is a run where the fingerprint held still.
 *
 * The dwell is the point of the whole scenario. It waits out a SQLite checkpoint, the exact event
 * that used to move the revision, so a reintroduced directory stat fails here rather than a year
 * from now in somebody's terminal.
 */
const STALENESS_NOTICE = /vault changed in another session or process/i;

export async function runRevisionStabilityScenarios(ctx: Ctx): Promise<void> {
	ctx.rec.group("revision: only the vault file may move it");
	const { rec } = ctx;
	if (!ctx.hasModel) {
		rec.record({
			name: "the revision holds still across a cold start that never touched the vault",
			verdict: "NOT RUN",
			observed: "no model resolved, so no turn can be run to surface the notice",
			detail: "run with --auth link",
		});
		return;
	}

	for (const withSecret of [false, true]) {
		const label = withSecret ? "a vault holding a secret" : "an EMPTY vault";
		const iso = await createIsolatedRoot("revision", ctx.auth);
		const caseCtx: Ctx = { ...ctx, iso };
		try {
			await runCliPiped(iso, ["config", "set", "secrets.enabled", "true"]);
			if (withSecret) {
				const seed = newSeed("revision");
				rec.protect(seed);
				await runCliPiped(iso, [...modelArgs(caseCtx), "-p", "/secret add STRESS_REV --from-env V"], {
					env: { V: seed },
				});
			}

			const cli = new InteractiveCli(iso, [...modelArgs(caseCtx), "--approval-mode", "yolo"], {
				env: { VEYYON_SKIP_SETUP: "1" },
				timeoutMs: 120_000,
			});
			cli.start();
			const ready = await cli.waitFor(COMPOSER_READY, 60_000);
			// A build that dies at startup never gets a composer, and driving a dead PTY throws
			// inside the harness instead of recording the verdict. That is exactly the pre-fix
			// build's behavior, so this branch is load-bearing for the negative control.
			if (ready === "matched") {
				// Long enough for SQLite to checkpoint and drop the -wal it created on the way in.
				// Nothing in this window touches the vault.
				await Bun.sleep(4_000);
				// A turn, so the session actually consults the runtime and would report staleness.
				cli.send(`echo revision-probe${KEY.enter}`);
				await cli.waitFor(/revision-probe/, 60_000);
			}
			const capture = await cli.close();
			const capturePath = rec.writeCapture(`revision-stability-${withSecret ? "stored" : "empty"}`, capture.raw);

			const moved = STALENESS_NOTICE.test(capture.plain);
			rec.check(
				`the revision of ${label} holds still across a cold start that never touched it`,
				ready === "matched" && !moved,
				ready !== "matched"
					? `the composer never appeared (${ready}), so the property could not be observed`
					: moved
						? "the session reported the vault changed, with nothing having touched the vault"
						: "no staleness notice after a full startup and a SQLite checkpoint",
				"something outside the vault file is being fingerprinted again, which is the exact cause of the startup lockout",
				capturePath,
			);
		} finally {
			destroyIsolatedRoot(iso);
		}
	}
}

/** Two sessions against one vault, writing at the same time. */
export async function runConcurrencyScenarios(ctx: Ctx): Promise<void> {
	ctx.rec.group("concurrency: two processes, one vault");
	const { rec } = ctx;

	const seedA = newSeed("concurrent-a");
	const seedB = newSeed("concurrent-b");
	rec.protect(seedA, seedB);

	await runCliPiped(ctx.iso, [...modelArgs(ctx), "-p", "/secret add STRESS_CONCUR_A --from-env V"], {
		env: { V: seedA },
	});

	// One adds while the other removes, started together so their vault transactions overlap.
	const [adder, remover] = await Promise.all([
		runCliPiped(ctx.iso, [...modelArgs(ctx), "-p", "/secret add STRESS_CONCUR_B --from-env V"], {
			env: { V: seedB },
		}),
		runCliPiped(ctx.iso, [...modelArgs(ctx), "-p", "/secret rm STRESS_CONCUR_A"]),
	]);

	rec.check(
		"a concurrent add succeeds cleanly",
		/Stored STRESS_CONCUR_B/.test(adder.text),
		adder.text.trim().split("\n")[0] ?? "(no output)",
		"a simultaneous add failed or reported something other than a store",
	);
	rec.check(
		"a concurrent remove succeeds cleanly",
		/Removed STRESS_CONCUR_A/.test(remover.text),
		remover.text.trim().split("\n")[0] ?? "(no output)",
		"a simultaneous remove failed",
	);

	const list = await runCliPiped(ctx.iso, [...modelArgs(ctx), "-p", "/secret list"]);
	const hasB = list.text.includes("#STRESS_CONCUR_B#");
	const hasA = list.text.includes("#STRESS_CONCUR_A#");
	rec.check(
		"both concurrent writes landed: the added name is present and the removed one is gone",
		hasB && !hasA,
		`after the overlap, list shows STRESS_CONCUR_B=${hasB} STRESS_CONCUR_A=${hasA}`,
		"one of two overlapping vault transactions was lost",
	);
	rec.check(
		"neither concurrent process printed a stored value",
		!adder.text.includes(seedB) && !remover.text.includes(seedA) && !list.text.includes(seedB),
		"no seeded value in either process's output",
		"a credential value was printed during concurrent access",
	);
}
