/**
 * The parts of `/secret` that only exist inside a live TUI.
 *
 * Masked entry, stored-name tab completion, and expiry that happens WHILE a session is up cannot
 * be reached from print mode: the first is gated on `isTTY`, the second is a completion popup, and
 * the third needs a process that stays alive across the lapse. Each one is driven by typing into a
 * real pseudo-terminal and reading the bytes the TUI wrote back.
 */
import { InteractiveCli, KEY } from "../lib/pty";
import { COMPOSER_READY, type Ctx, modelArgs, newSeed } from "./context";

/** Boot a TUI and wait until the composer is accepting input. */
async function bootTui(ctx: Ctx, extraArgs: readonly string[] = []): Promise<InteractiveCli | null> {
	const cli = new InteractiveCli(ctx.iso, [...modelArgs(ctx), ...extraArgs], {
		env: { VEYYON_SKIP_SETUP: "1" },
		timeoutMs: 180_000,
	});
	cli.start();
	const ready = await cli.waitFor(/ask anything|for commands/, 60_000);
	if (ready !== "matched") {
		await cli.close();
		return null;
	}
	return cli;
}

export async function runTerminalScenarios(ctx: Ctx): Promise<void> {
	ctx.rec.group("live TUI");
	const { rec } = ctx;

	const cli = await bootTui(ctx);
	if (cli === null) {
		rec.record({
			name: "the TUI reaches an interactive composer in a real terminal",
			verdict: "FAIL",
			observed: "the composer prompt never appeared within 60s of launch",
			detail: "every terminal-only scenario below depends on this",
		});
		return;
	}
	rec.check("the TUI reaches an interactive composer in a real terminal", true, "composer prompt drawn");

	try {
		// ── masked interactive entry ────────────────────────────────────────────
		const maskedSeed = newSeed("masked");
		rec.protect(maskedSeed);
		await cli.submit("/secret add STRESS_MASKED", { afterMs: 2_500 });
		const prompted = await cli.waitFor(/Paste the value for STRESS_MASKED/, 15_000);
		rec.check(
			"add with no value on the TUI surface opens a masked entry field naming the secret",
			prompted === "matched",
			prompted === "matched"
				? "the TUI drew: Paste the value for STRESS_MASKED. It is hidden as you type and stored encrypted."
				: `the masked prompt never appeared (${prompted})`,
			"the one entry form that keeps a credential out of shell history is unreachable",
		);

		if (prompted === "matched") {
			const beforeTyping = cli.raw.length;
			cli.send(maskedSeed);
			await Bun.sleep(1_200);
			const echoedWhileTyping = cli.raw.slice(beforeTyping).includes(maskedSeed);
			rec.check(
				"the masked field never echoes the credential as it is typed",
				!echoedWhileTyping,
				echoedWhileTyping ? "the value was echoed to the terminal" : "nothing readable was echoed while typing",
				"a credential typed into the masked field is visible on screen and in any scrollback",
			);
			cli.send(KEY.enter);
			const stored = await cli.waitFor(/Stored STRESS_MASKED in the profile vault/, 15_000);
			rec.check(
				"the masked field stores the credential and confirms it",
				stored === "matched",
				stored === "matched"
					? "Stored STRESS_MASKED in the profile vault, 1d left."
					: `no confirmation (${stored})`,
				"the masked entry path did not store the credential",
			);
			rec.check(
				"the credential typed into the masked field is absent from the entire terminal capture",
				!cli.raw.includes(maskedSeed),
				"the typed value appears nowhere in the session's bytes",
				"the masked value leaked into the terminal stream",
			);
			ctx.seeds.STRESS_MASKED = maskedSeed;
		}

		// ── stored-name tab completion ──────────────────────────────────────────
		await cli.submit("/secret list", { afterMs: 2_000 });
		cli.send(KEY.clearLine);
		await Bun.sleep(300);
		cli.send("/secret rm STRESS_MAS");
		await Bun.sleep(900);
		const beforeTab = cli.plain.length;
		cli.send(KEY.tab);
		await Bun.sleep(1_200);
		const afterTab = cli.plain.slice(beforeTab);
		rec.check(
			"tab completion on /secret rm offers a stored name",
			afterTab.includes("STRESS_MASKED"),
			afterTab.includes("STRESS_MASKED")
				? "tab expanded the partial name to STRESS_MASKED"
				: "tab produced no stored-name suggestion",
			"the operator has to retype an exact secret name from memory to remove it",
		);
		cli.send(KEY.escape);
		await Bun.sleep(300);
		cli.send(KEY.clearLine);
		await Bun.sleep(300);

		cli.send("/secret extend STRESS_MAS");
		await Bun.sleep(900);
		const beforeTab2 = cli.plain.length;
		cli.send(KEY.tab);
		await Bun.sleep(1_200);
		const afterTab2 = cli.plain.slice(beforeTab2);
		rec.check(
			"tab completion on /secret extend offers a stored name",
			afterTab2.includes("STRESS_MASKED"),
			afterTab2.includes("STRESS_MASKED")
				? "tab expanded the partial name to STRESS_MASKED"
				: "tab produced no stored-name suggestion",
			"extend has no completion even though it takes the same argument as rm",
		);
		cli.send(KEY.escape);
		await Bun.sleep(300);
		cli.send(KEY.clearLine);
		await Bun.sleep(300);

		// ── expiry DURING a live session ────────────────────────────────────────
		const expiringSeed = newSeed("expiring");
		rec.protect(expiringSeed);
		await cli.submit("/secret add STRESS_LAPSE", { afterMs: 2_000 });
		const lapsePrompt = await cli.waitFor(/Paste the value for STRESS_LAPSE/, 15_000);
		if (lapsePrompt === "matched") {
			cli.send(expiringSeed);
			await Bun.sleep(600);
			cli.send(KEY.enter);
			await cli.waitFor(/Stored STRESS_LAPSE/, 15_000);
			// The masked path has no --ttl, so shorten it from inside the same session.
			await cli.submit("/secret extend STRESS_LAPSE --ttl 20s", { afterMs: 2_500 });
			const shortened = cli.plain.includes("STRESS_LAPSE") && /20s/.test(cli.plain);
			if (shortened) {
				const beforeLapse = cli.plain.length;
				await Bun.sleep(24_000);
				await cli.submit("/secret list", { afterMs: 3_000 });
				const afterLapse = cli.plain.slice(beforeLapse);
				rec.check(
					"a secret that lapses inside a live session stops being listed by that same session",
					!afterLapse.includes("#STRESS_LAPSE#"),
					afterLapse.includes("#STRESS_LAPSE#")
						? "the lapsed secret is still listed by the session that outlived it"
						: "the lapsed secret is gone from the live session's list",
					"a running session keeps offering a credential that has already expired",
				);
				rec.check(
					"the session survives a secret expiring underneath it",
					!cli.exited && (await cli.waitFor(COMPOSER_READY, 5_000)) === "matched",
					cli.exited ? "the TUI exited when a live secret lapsed" : "the composer is still accepting input",
					"an expiry inside a live session takes the whole TUI down",
				);
			} else {
				rec.record({
					name: "a secret that lapses inside a live session stops being listed by that same session",
					verdict: "NOT RUN",
					observed: "/secret extend --ttl 20s did not shorten the lifetime",
					detail: "the scenario needs a secret whose lifetime ends during the run",
				});
			}
		} else {
			rec.record({
				name: "a secret that lapses inside a live session stops being listed by that same session",
				verdict: "NOT RUN",
				observed: "the masked prompt for STRESS_LAPSE never appeared",
				detail: "could not create the short-lived secret this scenario needs",
			});
		}
	} finally {
		const capture = await cli.close();
		rec.writeCapture("live-tui-session", capture.raw);
	}
}
