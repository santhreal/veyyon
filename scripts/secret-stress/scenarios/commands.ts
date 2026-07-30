/**
 * Every `/secret` subcommand, in a real terminal, in every state it can be in.
 *
 * These run the CLI's print mode (`-p "/secret ..."`) inside a PTY. Print mode is a real user
 * surface (it is how `/secret` is scripted, and it is the "noninteractive" surface the command's
 * own help branches on), and running it through a terminal rather than a pipe is what makes the
 * `isTTY` branches take the same path a person's terminal takes.
 *
 * Terminal-only behaviour -- masked entry, tab completion, the live TUI -- is in `terminal.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runCliPiped, vaultPath } from "../lib/isolation";
import { runCli } from "../lib/pty";
import { type Ctx, modelArgs, newSeed } from "./context";

/** Run one `/secret ...` invocation in a PTY and file its capture. */
async function secret(ctx: Ctx, tag: string, line: string, env: Record<string, string> = {}) {
	const capture = await runCli({ iso: ctx.iso, args: [...modelArgs(ctx), "-p", line], env });
	return { ...capture, capturePath: ctx.rec.writeCapture(tag, capture.raw) };
}

/** First line of real content, for the one-line "what the terminal did" column. */
function firstMeaningfulLine(text: string): string {
	const line = text
		.split("\n")
		.map(l => l.trim())
		.find(l => l.length > 0);
	return line === undefined ? "(no output)" : line.slice(0, 160);
}

/**
 * The harness's own safety proof, run before anything is stored.
 *
 * If any of these fail the run aborts, because every later scenario stores, rotates and DELETES
 * credentials, and a run that is not isolated would be doing that to the operator's real vault.
 */
export async function runIsolationSelfChecks(ctx: Ctx): Promise<boolean> {
	ctx.rec.group("isolation");
	const { iso, rec } = ctx;

	const insideHome = iso.agentDir.startsWith(`${iso.home}${path.sep}`);
	rec.check(
		"resolved agent dir is inside the run's temp home",
		insideHome,
		`veyyon config path -> ${iso.agentDir}`,
		`agent dir escaped the temp home ${iso.home}; destructive scenarios would hit a real vault`,
	);

	// THE CHECK THAT KEEPS THIS HARNESS HONEST. `PtySession.startArgv`'s `env` MERGES into the
	// parent environment instead of replacing it, so a `VEYYON_*` variable exported by the shell
	// that launched the harness reaches the child. This repo's own agent sessions export
	// `VEYYON_PROFILE` and an absolute `VEYYON_CODING_AGENT_DIR` pointing at the developer's real
	// profile. The first version of this harness inherited both and quietly wrote its test secrets
	// under a `work` profile it never asked for. Every child is now launched through `env -i`, and
	// this reads the child's actual environment back through the PTY to prove it.
	const envProbe = await runCli({ iso, args: ["config", "path"], timeoutMs: 30_000 });
	const ptyAgentDir = envProbe.plain
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.startsWith("/"))
		.at(-1);
	rec.check(
		"a PTY-launched child resolves the isolated agent dir, not one inherited from the parent shell",
		ptyAgentDir === iso.agentDir,
		`the terminal child reported ${ptyAgentDir ?? "(nothing)"}`,
		`a VEYYON_* variable from the surrounding shell reached the child; expected ${iso.agentDir}`,
		rec.writeCapture("isolation-pty-agent-dir", envProbe.raw),
	);

	const secondProcess = await runCliPiped(iso, ["config", "path"]);
	rec.check(
		"a second, pipe-backed process resolves the same isolated agent dir",
		secondProcess.stdout.trim() === iso.agentDir,
		`second process reported ${secondProcess.stdout.trim() || "(nothing)"}`,
		`the two spawners disagree; expected ${iso.agentDir}`,
	);

	const emptyList = await secret(ctx, "isolation-empty-vault", "/secret list");
	const startsEmpty = emptyList.plain.includes("No active secrets");
	rec.check(
		"the run starts with an empty vault",
		startsEmpty,
		firstMeaningfulLine(emptyList.plain),
		"a vault that is not empty at the start means the run is reading a real one",
		emptyList.capturePath,
	);
	// `#NAME#` is the literal the empty-vault help prints to teach the placeholder syntax, so it is
	// the one token that is NOT evidence of a foreign vault. Everything else is.
	const foreignPlaceholder = [...emptyList.plain.matchAll(/#[A-Z0-9_]{4,64}#/g)]
		.map(match => match[0])
		.find(token => token !== "#NAME#");
	rec.check(
		"the empty vault names no secret at all",
		foreignPlaceholder === undefined,
		foreignPlaceholder === undefined
			? "the only placeholder token printed is the #NAME# in the help text"
			: `a real placeholder token appeared: ${foreignPlaceholder}`,
		`saw ${foreignPlaceholder} before this run stored anything, so the run is reading a vault it does not own`,
		emptyList.capturePath,
	);

	return insideHome && startsEmpty;
}

/** `/secret add` in every entry form the product documents. */
export async function runAddScenarios(ctx: Ctx): Promise<void> {
	ctx.rec.group("add: entry forms");
	const { rec } = ctx;

	const inlineSeed = newSeed("inline");
	rec.protect(inlineSeed);
	const inline = await secret(ctx, "add-inline-noninteractive", `/secret add STRESS_INLINE ${inlineSeed}`);
	const refusedInline = /refuses inline credentials/i.test(inline.plain);
	rec.check(
		"inline value on a noninteractive surface is refused, and the refusal explains the alternative",
		refusedInline && inline.plain.includes("--from-env"),
		firstMeaningfulLine(inline.plain),
		"print mode accepted a credential that would be retained in shell history",
		inline.capturePath,
	);
	rec.check(
		"the refusal never echoes the value it refused",
		!inline.raw.includes(inlineSeed),
		"the inline value does not appear anywhere in the terminal capture",
		"the refused value was printed back to the terminal",
		inline.capturePath,
	);

	const envSeed = newSeed("fromenv");
	rec.protect(envSeed);
	const fromEnv = await secret(ctx, "add-from-env", "/secret add STRESS_ENV --from-env STRESS_ENV_VAR", {
		STRESS_ENV_VAR: envSeed,
	});
	ctx.seeds.STRESS_ENV = envSeed;
	rec.check(
		"--from-env stores the variable's value and names the vault it landed in",
		fromEnv.plain.includes("Stored STRESS_ENV in the profile vault"),
		firstMeaningfulLine(fromEnv.plain),
		"the confirmation did not name the scope the credential was written to",
		fromEnv.capturePath,
	);
	rec.check(
		"the add confirmation never shows the stored value",
		!fromEnv.raw.includes(envSeed),
		"the stored value does not appear anywhere in the terminal capture",
		"the value was echoed by the confirmation",
		fromEnv.capturePath,
	);

	const missingEnv = await secret(
		ctx,
		"add-missing-env-var",
		"/secret add STRESS_MISSING --from-env NOT_SET_ANYWHERE",
	);
	rec.check(
		"--from-env naming an unset variable says so instead of storing an empty secret",
		/is not set in this process/i.test(missingEnv.plain),
		firstMeaningfulLine(missingEnv.plain),
		"an unset variable did not produce an actionable error",
		missingEnv.capturePath,
	);

	const noValue = await secret(ctx, "add-no-value-noninteractive", "/secret add STRESS_NOVALUE");
	const cannotPrompt = /--from-env/.test(noValue.plain) && !/Stored STRESS_NOVALUE/.test(noValue.plain);
	rec.check(
		"add with no value on a noninteractive surface refuses and points at --from-env",
		cannotPrompt,
		firstMeaningfulLine(noValue.plain),
		"print mode either stored an empty value or tried to prompt where it cannot mask input",
		noValue.capturePath,
	);

	const shortValue = await secret(ctx, "add-too-short-value", "/secret add STRESS_SHORT --from-env STRESS_SHORT_VAR", {
		STRESS_SHORT_VAR: "abc",
	});
	rec.check(
		"a value below the substitution minimum is refused with the reason",
		/under the 8-character minimum/i.test(shortValue.plain),
		firstMeaningfulLine(shortValue.plain),
		"a value too short to substitute safely was accepted",
		shortValue.capturePath,
	);
}

/** Global, profile and project scopes, including the same name at two of them. */
export async function runScopeScenarios(ctx: Ctx): Promise<void> {
	ctx.rec.group("scope");
	const { rec, iso } = ctx;

	const globalSeed = newSeed("global");
	const projectSeed = newSeed("project");
	rec.protect(globalSeed, projectSeed);

	const addGlobal = await secret(ctx, "scope-global", "/secret add STRESS_GLOBAL --from-env G --scope global", {
		G: globalSeed,
	});
	ctx.seeds.STRESS_GLOBAL = globalSeed;
	rec.check(
		"--scope global writes the global vault and says so",
		addGlobal.plain.includes("Stored STRESS_GLOBAL in the global vault"),
		firstMeaningfulLine(addGlobal.plain),
		"the global scope was not honoured or not reported",
		addGlobal.capturePath,
	);
	rec.check(
		"the global vault file lands at the cross-profile config root",
		fs.existsSync(vaultPath(iso, "global")),
		`expected a vault at ${vaultPath(iso, "global")}`,
		"no vault file was created for the global scope",
	);

	const addProject = await secret(ctx, "scope-project", "/secret add STRESS_PROJECT --from-env P --scope project", {
		P: projectSeed,
	});
	ctx.seeds.STRESS_PROJECT = projectSeed;
	rec.check(
		"--scope project writes the project vault and says so",
		addProject.plain.includes("Stored STRESS_PROJECT in the project vault"),
		firstMeaningfulLine(addProject.plain),
		"the project scope was not honoured or not reported",
		addProject.capturePath,
	);
	rec.check(
		"the project vault file lands under the working directory, not the home",
		fs.existsSync(vaultPath(iso, "project")),
		`expected a vault at ${vaultPath(iso, "project")}`,
		"no vault file was created for the project scope",
	);

	// Same name at two scopes. `VAULT_SCOPES` is widest-first so the narrowest wins; the operator
	// has to be able to see WHICH one is live, otherwise they cannot tell which credential a
	// placeholder will spend.
	const wideSeed = newSeed("shadow-global");
	const narrowSeed = newSeed("shadow-project");
	rec.protect(wideSeed, narrowSeed);
	await secret(ctx, "scope-shadow-global", "/secret add STRESS_SHADOW --from-env S1 --scope global", { S1: wideSeed });
	const narrow = await secret(ctx, "scope-shadow-project", "/secret add STRESS_SHADOW --from-env S2 --scope project", {
		S2: narrowSeed,
	});
	ctx.seeds.STRESS_SHADOW = narrowSeed;
	rec.check(
		"the same name at a narrower scope is stored rather than rejected as a duplicate",
		narrow.plain.includes("Stored STRESS_SHADOW in the project vault"),
		firstMeaningfulLine(narrow.plain),
		"a project-scope entry could not shadow a global one of the same name",
		narrow.capturePath,
	);

	const list = await secret(ctx, "scope-shadow-list", "/secret list");
	const shadowRows = list.plain.split("\n").filter(line => line.includes("#STRESS_SHADOW#"));
	rec.check(
		"/secret list shows exactly one row for a shadowed name, and it is the narrower scope",
		shadowRows.length === 1 && /\bproject\b/.test(shadowRows[0] ?? ""),
		shadowRows.length === 0 ? "no row for the shadowed name" : shadowRows.map(r => r.trim()).join(" | "),
		`expected one project-scope row, saw ${shadowRows.length}`,
		list.capturePath,
	);
}

/** Every TTL form, including one that lapses while a session is up (that one lives in `terminal.ts`). */
export async function runTtlScenarios(ctx: Ctx): Promise<void> {
	ctx.rec.group("ttl");
	const { rec } = ctx;
	const seed = newSeed("ttl");
	rec.protect(seed);

	const defaultTtl = await secret(ctx, "ttl-default", "/secret add STRESS_TTL_DEFAULT --from-env T", { T: seed });
	rec.check(
		"a TTL-less add reports the configured default lifetime rather than silently never expiring",
		/Stored STRESS_TTL_DEFAULT in the profile vault, 1d left\./.test(defaultTtl.plain),
		firstMeaningfulLine(defaultTtl.plain),
		"the default lifetime was not applied or not reported",
		defaultTtl.capturePath,
	);

	const numeric = await secret(ctx, "ttl-numeric", "/secret add STRESS_TTL_30M --from-env T --ttl 30m", { T: seed });
	rec.check(
		"an explicit numeric TTL is honoured and echoed back in the same units",
		/Stored STRESS_TTL_30M in the profile vault, 30m left\./.test(numeric.plain),
		firstMeaningfulLine(numeric.plain),
		"an explicit --ttl was not applied or was reported in different units",
		numeric.capturePath,
	);

	const never = await secret(ctx, "ttl-never", "/secret add STRESS_TTL_NEVER --from-env T --ttl never", { T: seed });
	rec.check(
		"--ttl never stores a secret with no expiry and says 'never expires'",
		/Stored STRESS_TTL_NEVER in the profile vault, never expires\./.test(never.plain),
		firstMeaningfulLine(never.plain),
		"--ttl never was rejected or reported as a finite lifetime",
		never.capturePath,
	);

	const invalid = await secret(ctx, "ttl-invalid", "/secret add STRESS_TTL_BAD --from-env T --ttl banana", {
		T: seed,
	});
	const refused = /--ttl needs a valid lifetime/.test(invalid.plain) && !/Stored STRESS_TTL_BAD/.test(invalid.plain);
	rec.check(
		"an unparseable TTL refuses the whole add instead of falling back to a default",
		refused,
		firstMeaningfulLine(invalid.plain),
		"an invalid --ttl either stored the secret anyway or gave no usable message",
		invalid.capturePath,
	);
}

/** Re-adding an existing name, and names that normalise onto each other. */
export async function runRotationScenarios(ctx: Ctx): Promise<void> {
	ctx.rec.group("rotation and name normalisation");
	const { rec } = ctx;

	const first = newSeed("rot1");
	const second = newSeed("rot2");
	rec.protect(first, second);

	await secret(ctx, "rotate-first", "/secret add STRESS_ROTATE --from-env R1", { R1: first });
	const rotated = await secret(ctx, "rotate-second", "/secret add STRESS_ROTATE --from-env R2", { R2: second });
	ctx.seeds.STRESS_ROTATE = second;
	rec.check(
		"re-adding an existing name reports Replaced, not Stored",
		rotated.plain.includes("Replaced STRESS_ROTATE in the profile vault"),
		firstMeaningfulLine(rotated.plain),
		"rotation was reported as a fresh store, so the operator cannot tell they overwrote a credential",
		rotated.capturePath,
	);
	rec.check(
		"the rotation confirmation states the previous value is gone",
		/previous value is gone/i.test(rotated.plain),
		rotated.plain
			.split("\n")
			.map(l => l.trim())
			.filter(Boolean)
			.slice(0, 2)
			.join(" / ")
			.slice(0, 160),
		"nothing told the operator the old credential was destroyed",
		rotated.capturePath,
	);
	rec.check(
		"neither the old nor the new value appears in the rotation output",
		!rotated.raw.includes(first) && !rotated.raw.includes(second),
		"no stored value in the terminal capture",
		"a credential value reached the terminal during rotation",
		rotated.capturePath,
	);

	// `normaliseSecretName` uppercases and folds `-`/space to `_`, so these are ONE name.
	const lower = newSeed("gh-lower");
	const upper = newSeed("gh-upper");
	rec.protect(lower, upper);
	const added = await secret(ctx, "normalise-lowercase-hyphen", "/secret add github-token --from-env GHL", {
		GHL: lower,
	});
	rec.check(
		"a lowercase hyphenated name is normalised to the uppercase underscore spelling",
		added.plain.includes("STRESS") === false && /GITHUB_TOKEN/.test(added.plain),
		firstMeaningfulLine(added.plain),
		"the stored name was not normalised, so the placeholder the model must write is unpredictable",
		added.capturePath,
	);
	const collided = await secret(ctx, "normalise-collision", "/secret add GITHUB_TOKEN --from-env GHU", { GHU: upper });
	ctx.seeds.GITHUB_TOKEN = upper;
	rec.check(
		"the normalised spelling collides with the hyphenated one and reports a replacement",
		collided.plain.includes("Replaced GITHUB_TOKEN"),
		firstMeaningfulLine(collided.plain),
		"github-token and GITHUB_TOKEN were treated as two different secrets",
		collided.capturePath,
	);
	const list = await secret(ctx, "normalise-collision-list", "/secret list");
	const ghRows = list.plain.split("\n").filter(line => line.includes("#GITHUB_TOKEN#"));
	rec.check(
		"only one entry exists for the two spellings",
		ghRows.length === 1,
		ghRows.map(r => r.trim()).join(" | ") || "(no row)",
		`expected exactly one GITHUB_TOKEN row, saw ${ghRows.length}`,
		list.capturePath,
	);
}

/** `/secret list` over the whole range of vault states and name shapes. */
export async function runListScenarios(ctx: Ctx): Promise<void> {
	ctx.rec.group("list");
	const { rec } = ctx;
	const seed = newSeed("list");
	rec.protect(seed);

	const many = await secret(ctx, "list-many", "/secret list");
	const rows = many.plain.split("\n").filter(line => /^\s*#[A-Z0-9_]+#/.test(line));
	rec.check(
		"a populated vault renders one aligned row per live secret under a header",
		rows.length >= 5 && many.plain.includes("PLACEHOLDER") && many.plain.includes("SCOPE"),
		`${rows.length} placeholder rows under a PLACEHOLDER/SCOPE/EXPIRES header`,
		`expected at least 5 rows and a header, saw ${rows.length} rows`,
		many.capturePath,
	);
	rec.check(
		"the table never prints a stored value",
		!ctx.rec.redact(many.raw).includes("<REDACTED-SEEDED-VALUE>"),
		"no seeded value appears in the list output",
		"a stored value appeared in /secret list",
		many.capturePath,
	);

	// Column alignment as a property: every table row must put SCOPE at the same column.
	const tableLines = many.plain.split("\n").filter(line => /^\s{2}(PLACEHOLDER|#)/.test(line));
	const scopeColumns = new Set(
		tableLines.map(line => {
			const match = /^\s{2}\S+\s{2,}/.exec(line);
			return match === null ? -1 : match[0].length;
		}),
	);
	rec.check(
		"the header and every row start the SCOPE column at the same terminal cell",
		scopeColumns.size === 1 && !scopeColumns.has(-1),
		`SCOPE column starts at ${[...scopeColumns].join(", ")}`,
		"the table is misaligned in a real terminal",
		many.capturePath,
	);

	// Longest legal name: MAX_SECRET_NAME_LENGTH is 64, and the widest cell the table reserves is
	// `#` + 64 + `#`. A name at the limit must round-trip through storage and rendering uncut.
	const maxName = `A${"X".repeat(63)}`;
	const maxAdd = await secret(ctx, "list-max-length-name", `/secret add ${maxName} --from-env L`, { L: seed });
	rec.check(
		"a name at the 64-character limit is accepted",
		maxAdd.plain.includes(`Stored ${maxName}`),
		firstMeaningfulLine(maxAdd.plain),
		"the longest legal name was rejected",
		maxAdd.capturePath,
	);
	const maxList = await secret(ctx, "list-max-length-render", "/secret list");
	rec.check(
		"the longest legal name renders in full, uncut, in a 120-column terminal",
		maxList.plain.includes(`#${maxName}#`),
		maxList.plain.includes(`#${maxName}#`)
			? "the full 66-cell placeholder is present"
			: "the placeholder was truncated",
		"a legal name was elided by the table, so the operator cannot copy the placeholder",
		maxList.capturePath,
	);

	const overLong = `B${"Y".repeat(64)}`;
	const overAdd = await secret(ctx, "list-over-length-name", `/secret add ${overLong} --from-env L`, { L: seed });
	rec.check(
		"a name past the limit is refused rather than silently truncated onto a neighbour",
		!overAdd.plain.includes("Stored"),
		firstMeaningfulLine(overAdd.plain),
		"an over-length name was accepted, which can alias two secrets onto one placeholder",
		overAdd.capturePath,
	);

	// Wide characters: the documented alphabet is ASCII only, so this must be a clean refusal and
	// not a mojibake row that breaks the table's column arithmetic.
	const wideAdd = await secret(ctx, "list-wide-character-name", "/secret add 秘密トークン --from-env L", { L: seed });
	rec.check(
		"a wide-character name is refused with a message naming the legal alphabet",
		!wideAdd.plain.includes("Stored") && /[Aa]-?Z|letters|characters/.test(wideAdd.plain),
		firstMeaningfulLine(wideAdd.plain),
		"a non-ASCII name was accepted or refused without explaining the rule",
		wideAdd.capturePath,
	);

	// Near expiry: a 1-minute lifetime is past the 90% warning threshold within seconds of storage
	// only if we wait, so store one that is ALREADY most of the way through by extending a short one.
	const nearAdd = await secret(ctx, "list-near-expiry-add", "/secret add STRESS_NEAR --from-env L --ttl 20s", {
		L: seed,
	});
	if (nearAdd.plain.includes("Stored STRESS_NEAR")) {
		await Bun.sleep(19_000);
		const nearList = await secret(ctx, "list-near-expiry-render", "/secret list");
		const nearRow = nearList.plain.split("\n").find(line => line.includes("#STRESS_NEAR#"));
		rec.check(
			"a secret in its last tenth of life is flagged in the STATUS column with an actionable footer",
			nearRow !== undefined && /expires soon|past halfway/.test(nearRow) && /\/secret extend/.test(nearList.plain),
			nearRow === undefined ? "the near-expiry row was gone from the table" : nearRow.trim(),
			"nothing warned the operator that a live credential is about to lapse",
			nearList.capturePath,
		);
		await Bun.sleep(3_000);
		const expiredList = await secret(ctx, "list-expired-render", "/secret list");
		rec.check(
			"an expired secret disappears from the table instead of being offered as spendable",
			!expiredList.plain.includes("#STRESS_NEAR#"),
			expiredList.plain.includes("#STRESS_NEAR#") ? "the expired row is still listed" : "the expired row is gone",
			"an expired credential is still presented as active",
			expiredList.capturePath,
		);
	} else {
		rec.record({
			name: "a secret in its last tenth of life is flagged in the STATUS column",
			verdict: "NOT RUN",
			observed: firstMeaningfulLine(nearAdd.plain),
			detail: "the 20s-TTL entry this scenario needs could not be stored",
			capture: nearAdd.capturePath,
		});
	}
}

/** `/secret rm` and `/secret extend`, including on names that are not there. */
export async function runRemoveExtendScenarios(ctx: Ctx): Promise<void> {
	ctx.rec.group("rm and extend");
	const { rec } = ctx;
	const seed = newSeed("rmext");
	rec.protect(seed);

	await secret(ctx, "extend-setup", "/secret add STRESS_EXTEND --from-env E --ttl 30m", { E: seed });
	const extended = await secret(ctx, "extend-ok", "/secret extend STRESS_EXTEND --ttl 7d");
	rec.check(
		"extend restates the new lifetime and the scope it applied to",
		/STRESS_EXTEND in the profile vault now lasts 7d from now \(7d left\)/.test(extended.plain),
		firstMeaningfulLine(extended.plain),
		"extend did not confirm the new lifetime, so the operator cannot tell it worked",
		extended.capturePath,
	);

	const extendMissing = await secret(ctx, "extend-missing", "/secret extend STRESS_NO_SUCH_NAME --ttl 7d");
	rec.check(
		"extend on an unknown name says the name is unknown and points at /secret list",
		/No secret named STRESS_NO_SUCH_NAME is stored/.test(extendMissing.plain) &&
			/\/secret list/.test(extendMissing.plain),
		firstMeaningfulLine(extendMissing.plain),
		"extend on a missing name gave no actionable message",
		extendMissing.capturePath,
	);

	const removed = await secret(ctx, "rm-ok", "/secret rm STRESS_EXTEND");
	rec.check(
		"rm confirms the removal and names the scope it removed from",
		/Removed STRESS_EXTEND from the profile vault/.test(removed.plain),
		firstMeaningfulLine(removed.plain),
		"rm did not confirm which vault it changed",
		removed.capturePath,
	);
	const afterRemove = await secret(ctx, "rm-verify", "/secret list");
	rec.check(
		"a removed secret is gone from the next process's list",
		!afterRemove.plain.includes("#STRESS_EXTEND#"),
		afterRemove.plain.includes("#STRESS_EXTEND#") ? "the removed row is still listed" : "the removed row is gone",
		"rm did not persist",
		afterRemove.capturePath,
	);

	const rmMissing = await secret(ctx, "rm-missing", "/secret rm STRESS_NO_SUCH_NAME");
	rec.check(
		"rm on an unknown name says the name is unknown rather than reporting a successful no-op",
		/No secret named STRESS_NO_SUCH_NAME is stored/.test(rmMissing.plain),
		firstMeaningfulLine(rmMissing.plain),
		"rm on a missing name reported success or gave no usable message",
		rmMissing.capturePath,
	);
}

/** Protection off, protection on with an empty vault, and a vault file that has been tampered with. */
export async function runProtectionScenarios(ctx: Ctx): Promise<void> {
	ctx.rec.group("protection and vault integrity");
	const { rec, iso } = ctx;

	const enabled = await runCliPiped(iso, ["config", "get", "secrets.enabled"]);
	const claimedPersist = "Secret protection was off, so it is now on for this session and saved for the next one.";
	rec.check(
		"the enable that /secret add announces as 'saved for the next one' is actually saved",
		enabled.stdout.trim() === "true",
		`after many successful adds each printing "${claimedPersist}", config get secrets.enabled = ${enabled.stdout.trim() || "(empty)"}`,
		"every add claims protection is now on and persisted, but a later process reads it as off, so the next session " +
			"does not obfuscate placeholders at all",
	);

	// Protection ON with nothing stored: the reassurance must not turn into a warning that the
	// operator has lost something.
	await runCliPiped(iso, ["config", "set", "secrets.enabled", "true"]);
	const freshIsoList = await secret(ctx, "protection-on-empty-vault", "/secret list");
	rec.check(
		"with protection on and entries present, /secret list stops printing the 'protection is OFF' banner",
		!freshIsoList.plain.includes("Secret protection is OFF"),
		freshIsoList.plain.includes("Secret protection is OFF")
			? "the OFF banner is still printed after protection was turned on"
			: "no OFF banner",
		"the banner contradicts the stored setting",
		freshIsoList.capturePath,
	);

	// A hand-edited vault. The product's own parser calls this out as a case it must not treat as
	// an empty vault, because silently starting empty would make a placeholder expand to nothing.
	const projectVault = vaultPath(iso, "project");
	const original = fs.readFileSync(projectVault, "utf8");
	fs.writeFileSync(projectVault, `${original.slice(0, Math.max(1, original.length - 12))}CORRUPTED"}`, {
		mode: 0o600,
	});
	const malformed = await secret(ctx, "protection-malformed-vault", "/secret list");
	const named = malformed.plain.includes("vault") || malformed.plain.includes("Vault");
	rec.check(
		"a hand-edited vault file is reported, not silently treated as empty",
		named && !/^\s*No active secrets/m.test(malformed.plain),
		firstMeaningfulLine(malformed.plain),
		"a corrupted vault produced a clean 'no secrets' screen, so an operator cannot tell their " +
			"credentials became unreadable",
		malformed.capturePath,
	);
	fs.writeFileSync(projectVault, original, { mode: 0o600 });
	const restored = await secret(ctx, "protection-vault-restored", "/secret list");
	rec.check(
		"restoring the vault bytes restores the entries, so the failure above was the tampering and nothing else",
		restored.plain.includes("#STRESS_PROJECT#"),
		firstMeaningfulLine(restored.plain),
		"the vault did not recover after the original bytes were put back",
		restored.capturePath,
	);
}
