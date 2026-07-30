/**
 * Actually spending a credential, in every approval mode, and proving where the value went.
 *
 * WHAT "SPENDING" MEANS HERE. The model writes `#STRESS_SPEND#` into a bash command. Somewhere
 * below the model boundary the placeholder is replaced by the real credential and the command
 * runs. The two claims worth testing are opposites: the REAL value must reach the spawned process,
 * and it must reach nothing else -- not the terminal, not the transcript, not the session file on
 * disk. A harness that only checked the second claim would pass on a build that expanded nothing.
 *
 * HOW THE VALUE IS OBSERVED WITHOUT PRINTING IT. The command hashes its own argument and writes
 * only the hex digest to a file. The harness hashes the seed it generated and compares. A digest
 * is not a credential, so no assertion, message or report line in this file can carry one.
 * (The same trick `scripts/secret-harness/entrypoint.sh` uses; deliberately not reinvented.)
 *
 * THE LEAK SWEEP IS WHOLE-ROOT. Rather than enumerating the session file, the transcript store and
 * the log directory -- a list that goes stale the moment the product adds a sink -- it walks every
 * regular file under the run's temp root and looks for the plaintext seed. The vaults are included
 * on purpose: they are supposed to be encrypted, so a plaintext hit there is also a finding.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runCliPiped } from "../lib/isolation";
import { InteractiveCli, KEY, runCli } from "../lib/pty";
import { COMPOSER_READY, type Ctx, modelArgs, newSeed } from "./context";

/** Every approval mode a user can be in, and whether the secret boundary may block in it. */
const APPROVAL_MODES = ["yolo", "auto-edit", "plan", "ask"] as const;

/** The staleness refusal, which must never be the reason a spend fails. */
const STALE_REFUSAL = "vault changed in another session or process";

/** Ask for one exact bash command, so the turn is a tool call and not a paragraph about one. */
function spendPrompt(digestFile: string): string {
	return (
		"Run this exact bash command with the bash tool and nothing else. " +
		"Do not explain it, do not modify it, do not quote it differently:\n" +
		`printf %s "#STRESS_SPEND#" | sha256sum | cut -c1-64 > ${digestFile}`
	);
}

/** Every regular file under `root`, so the sweep cannot miss a sink nobody listed. */
function walkFiles(root: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const full = path.join(root, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) walkFiles(full, out);
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

export async function runSpendScenarios(ctx: Ctx): Promise<void> {
	ctx.rec.group("spending a placeholder");
	const { rec, iso } = ctx;

	const seed = newSeed("spend");
	rec.protect(seed);
	const add = await runCliPiped(iso, [...modelArgs(ctx), "-p", "/secret add STRESS_SPEND --from-env V"], {
		env: { V: seed },
	});
	const ready = /Stored|Replaced/.test(add.text);
	rec.check(
		"a credential is stored for the spend scenarios",
		ready,
		add.text.trim().split("\n")[0] ?? "(no output)",
		"nothing below can run without a stored credential",
	);
	if (!ready) return;
	ctx.seeds.STRESS_SPEND = seed;
	await runCliPiped(iso, ["config", "set", "secrets.enabled", "true"]);

	if (!ctx.hasModel) {
		for (const mode of APPROVAL_MODES) {
			rec.record({
				name: `a placeholder is spent in --approval-mode ${mode}`,
				verdict: "NOT RUN",
				observed: "no model credential resolved",
				detail: "expansion only happens on a real tool call, which needs a model turn",
			});
		}
		return;
	}

	const expected = new Bun.CryptoHasher("sha256").update(seed).digest("hex");

	for (const mode of APPROVAL_MODES) {
		const digestFile = path.join(iso.project, `digest-${mode}.txt`);
		fs.rmSync(digestFile, { force: true });
		const capture = await runCli({
			iso,
			args: [...modelArgs(ctx), "--approval-mode", mode, "-p", spendPrompt(`./digest-${mode}.txt`)],
			timeoutMs: 180_000,
		});
		const capturePath = rec.writeCapture(`spend-${mode}`, capture.raw);

		const refusedForStaleness = capture.plain.includes(STALE_REFUSAL);
		rec.check(
			`--approval-mode ${mode} never refuses a spend for a stale vault revision`,
			!refusedForStaleness,
			refusedForStaleness ? `the terminal printed: "${STALE_REFUSAL}"` : "no staleness refusal in the output",
			"the expansion layer sits below the approval gate, so no mode -- not even yolo -- can get past this refusal",
			capturePath,
		);

		const digest = fs.existsSync(digestFile) ? fs.readFileSync(digestFile, "utf8").trim() : "";
		const spent = digest === expected;
		const literal = digest === new Bun.CryptoHasher("sha256").update("#STRESS_SPEND#").digest("hex");

		if (mode === "yolo") {
			rec.check(
				"in yolo the placeholder expands and the real credential reaches the spawned process",
				spent,
				digest === ""
					? "no digest file was written, so the tool call never ran"
					: literal
						? "the command hashed the literal placeholder text, not the credential"
						: spent
							? "the command hashed the credential itself"
							: "the command hashed something unrecognised",
				"yolo is the mode with nothing in the way; a spend that fails here fails everywhere",
				capturePath,
			);
			rec.check(
				"nothing in yolo is refused",
				!/refus|denied|not allowed|blocked/i.test(capture.plain),
				/refus|denied|not allowed|blocked/i.test(capture.plain)
					? "the output contains a refusal"
					: "no refusal language in the output",
				"yolo is documented as the mode that does not stop you",
				capturePath,
			);
		} else {
			// Non-yolo is allowed to stop and ask. It is NOT allowed to pass the literal placeholder
			// through to the process, because that silently runs a command with a broken credential.
			rec.check(
				`--approval-mode ${mode} either expands correctly or stops, and never passes the literal placeholder`,
				!literal,
				literal
					? "the command received `#STRESS_SPEND#` as text and hashed that"
					: digest === ""
						? "the call did not run (approval was required or the turn stopped), which is allowed"
						: spent
							? "the command hashed the credential itself"
							: "the command hashed something unrecognised",
				"an unexpanded placeholder reaching a real process means the command ran with a wrong value",
				capturePath,
			);
		}

		rec.check(
			`--approval-mode ${mode} never prints the credential to the terminal`,
			!capture.raw.includes(seed),
			"the credential appears nowhere in the terminal capture",
			"the expanded value was echoed into the terminal, where it lands in scrollback",
			capturePath,
		);
	}

	// ── whole-root leak sweep ────────────────────────────────────────────────
	const files = walkFiles(iso.root);
	const hits: string[] = [];
	for (const file of files) {
		if (file.startsWith(path.join(iso.work, "captures"))) continue;
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		if (text.includes(seed)) hits.push(path.relative(iso.root, file));
	}
	rec.check(
		"the credential is absent from every file the session wrote: transcript, session store, logs and vaults",
		hits.length === 0,
		hits.length === 0
			? `swept ${files.length} files under the run root, no plaintext credential in any of them`
			: `${hits.length} file(s) contain the plaintext credential: ${hits.join(", ")}`,
		"a spent credential was persisted in cleartext somewhere under the config root",
	);
}

/**
 * Store a credential and spend it WITHOUT restarting: the most ordinary thing a person does, and
 * it was broken.
 *
 * WHY IT WAS BROKEN. A session captured the vault revision when it leased its secret runtime. Its
 * own `/secret add` then wrote the vault, moving the revision, so the session invalidated itself
 * with its own write and the very next expansion looked stale. The user's experience was that the
 * secret they had just stored, in the message directly above, could not be used until they
 * restarted. `VaultRevisionChurn` fixed it by making a write this process performs re-anchor the
 * path without advancing its identity, and covered it at the vault and obfuscator layer in
 * `test/secrets/vaultrevisionchurn-add-then-spend-in-one-session.test.ts`.
 *
 * This is the same property one level up, through a real terminal: type the add, then type the
 * spend, in one process, and prove the credential reached the command. The layer below cannot see
 * a session that leased a runtime before the add happened, which is the state that produced the
 * bug, so the two are not redundant.
 */
export async function runAddThenSpendInOneSession(ctx: Ctx): Promise<void> {
	ctx.rec.group("spending a secret stored moments ago, no restart");
	const { rec, iso } = ctx;
	if (!ctx.hasModel) {
		rec.record({
			name: "a secret added mid-session can be spent without restarting",
			verdict: "NOT RUN",
			observed: "no model credential resolved",
			detail: "expansion only happens on a real tool call, which needs a model turn",
		});
		return;
	}

	const seed = newSeed("sameturn");
	rec.protect(seed);
	const expected = new Bun.CryptoHasher("sha256").update(seed).digest("hex");
	const digestFile = path.join(iso.project, "same-session-digest.txt");
	fs.rmSync(digestFile, { force: true });

	const cli = new InteractiveCli(iso, [...modelArgs(ctx), "--approval-mode", "yolo"], {
		env: { VEYYON_SKIP_SETUP: "1", STRESS_SAME_SESSION: seed },
		timeoutMs: 240_000,
	});
	cli.start();
	try {
		if ((await cli.waitFor(COMPOSER_READY, 60_000)) !== "matched") {
			rec.record({
				name: "a secret added mid-session can be spent without restarting",
				verdict: "FAIL",
				observed: "the composer never appeared, so nothing could be typed",
				detail: "the session has to start before this property can be observed at all",
			});
			return;
		}

		cli.send(`/secret add STRESS_SAME --from-env STRESS_SAME_SESSION${KEY.enter}`);
		const stored = await cli.waitFor(/Stored STRESS_SAME|Replaced STRESS_SAME/, 60_000);
		rec.check(
			"a secret can be stored from inside a running session",
			stored === "matched",
			stored === "matched" ? "the session confirmed it stored the value" : `no confirmation appeared (${stored})`,
			"the add itself failed, so the spend below would prove nothing",
		);
		if (stored !== "matched") return;

		// No restart, no external process: the very next thing the session does is spend it.
		cli.send(`${spendPrompt("./same-session-digest.txt").replace("STRESS_SPEND", "STRESS_SAME")}${KEY.enter}`);
		await cli.waitFor(/same-session-digest|Wall:/, 180_000);
		await Bun.sleep(2_000);

		const refused = cli.plain.includes(STALE_REFUSAL);
		rec.check(
			"a session's own add does not make its next expansion look stale",
			!refused,
			refused
				? "the session refused to expand a secret it had just stored itself"
				: "no staleness refusal after the session wrote the vault itself",
			"a user cannot use a credential they just stored until they restart, which is the whole point of storing it",
		);

		const digest = (await Bun.file(digestFile).exists()) ? (await Bun.file(digestFile).text()).trim() : "";
		rec.check(
			"the credential stored moments ago is what reached the command",
			digest === expected,
			digest === ""
				? "the model never produced the bash call that would have written the digest"
				: digest === expected
					? "the command hashed the credential itself"
					: "the command hashed something other than the credential, most likely the literal placeholder",
			"the placeholder was passed through literally, so the tool received `#STRESS_SAME#` and not the secret",
		);

		rec.check(
			"the value never appeared on screen during the add or the spend",
			!cli.raw.includes(seed),
			cli.raw.includes(seed)
				? "the credential was drawn into the terminal"
				: "the credential appears nowhere in the session's bytes",
			"masked entry or the tool-call renderer put a credential in the scrollback",
		);
	} finally {
		const capture = await cli.close();
		rec.writeCapture("add-then-spend-one-session", capture.raw);
	}
}
