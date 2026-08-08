/**
 * Print the secret manager, one state per section.
 *
 * The manager is the surface `/secret manager` reserves the grammar's only word for, and it is
 * the one place several states that never coexist have to look like the same screen: a healthy
 * table, a destructive confirmation, an inline field, and a vault that cannot be read at all.
 * Whether those read as one card is a thing you see, not a thing the string assertions in
 * `test/modes/components/secret-manager.test.ts` can answer.
 *
 * Run:
 *     bun scripts/demos/render-secret-manager.ts --width 100 |
 *       bun scripts/demos/render-proof.ts --out /tmp/secret-manager --width 100 --scale 3
 *
 * The vault is a real one in a temp directory, not a stub, so what renders is what the component
 * loads through its own code path. Lifetimes are whole days measured from the moment the vault is
 * written, so the EXPIRES column reads the same on every run: a proof you cannot re-take
 * identically is not a proof. Do not pin the component's clock without pinning the vault's too,
 * which is a mistake this file made once and the image caught. A 7-day secret rendered `205d
 * left`, because the entry was written against the real clock and measured against a fixed one.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SecretManager } from "../../packages/coding-agent/src/modes/components/secret-manager";
import { theme } from "../../packages/coding-agent/src/modes/theme/theme";
import { SecretAuditLog, secretAuditPath } from "../../packages/coding-agent/src/secrets/audit";
import { renderLog } from "../../packages/coding-agent/src/secrets/secret-command";
import {
	resolveVaultLocations,
	SecretVault,
	type VaultLocations,
	vaultPathFor,
} from "../../packages/coding-agent/src/secrets/vault";
import { stripAnsi } from "../../packages/utils/src/index";
import { flag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
// One section per proof. The card has two dozen states now, and a single image holding all of
// them is 5000 pixels tall and legible in none of them, so a proof of one state renders only
// that state: `--only "recording switched off"`. Absent, every section is printed as before.
const only = flag("only", "");
await initRender(themeName, { settings: true });

// No clock override. See the header: the component and the vault must share one.

const home = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-proof-home-"));
const project = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-proof-proj-"));
const locations = resolveVaultLocations({
	globalConfigRoot: home,
	agentDir: path.join(home, "profiles", "default"),
	cwd: project,
});

const vault = new SecretVault(locations);
await vault.add({ name: "GITHUB_TOKEN", value: "ghp_proofCredential000001", scope: "profile", ttl: 7 * 86_400_000 });
await vault.add({ name: "DEPLOY_KEY", value: "dpl_proofCredential000002", scope: "project", ttl: 30 * 86_400_000 });
await vault.add({ name: "STRIPE_KEY", value: "sk_proofCredential0000003", scope: "global", ttl: null });

// A populated expansion record, so the Log view renders rows rather than its empty state. The
// spread of tools and command lengths is deliberate: a log is a table, and a table only shows
// whether it is aligned when its cells disagree about width.
const auditLog = new SecretAuditLog(secretAuditPath(locations));
auditLog.record({
	at: Date.parse("2026-07-31T09:14:02Z"),
	tool: "bash",
	command: "curl -H 'Authorization: bearer #GITHUB_TOKEN#' https://api.github.com/user/repos",
	secrets: ["#GITHUB_TOKEN#"],
});
auditLog.record({
	at: Date.parse("2026-07-31T09:15:40Z"),
	tool: "bash",
	command: "ssh -i #DEPLOY_KEY# deploy@prod",
	secrets: ["#DEPLOY_KEY#"],
});
auditLog.record({
	at: Date.parse("2026-07-31T11:02:19Z"),
	tool: "fetch",
	command: "POST https://api.stripe.com/v1/charges with #STRIPE_KEY# and #GITHUB_TOKEN#",
	secrets: ["#STRIPE_KEY#", "#GITHUB_TOKEN#"],
});
await auditLog.flush();

/**
 * What a section may vary about the card it renders.
 *
 * The degenerate states are degenerate about the VAULT and the LOG, not about which keys are
 * pressed, so a section that could only drive keystrokes could not reach them at all: an empty
 * roster and a log with no records are properties of the files behind the card.
 */
interface SectionOptions {
	/** A vault of its own, for a state the shared three-secret vault cannot express. */
	locations?: VaultLocations;
	/**
	 * The expansion log the card is handed.
	 *
	 * `null` is recording switched OFF, which is a different card from a log that recorded
	 * nothing, and the pair of them is most of what the two empty-log sections below are for.
	 */
	auditLog?: SecretAuditLog | null;
	/** Columns to paint at, for a state that only misbehaves on a card too narrow for its table. */
	width?: number;
	/**
	 * Rows to size the card against.
	 *
	 * Absent, the card reads `process.stdout.rows`, which is UNDEFINED down a pipe and falls back
	 * to 24. A 24-row card is the compact one: it sheds its horizontal padding and so paints two
	 * columns WIDER than the same card on an ordinary 40-row terminal. A body line that overflows
	 * at 40 rows therefore fits at 24, which is how an overflowing line stayed invisible in every
	 * proof taken here. Naming the height is what makes the section reproduce the operator's card.
	 */
	terminalHeight?: number;
	/**
	 * The environment `f` reads, so an env scene paints the same bytes on every machine.
	 *
	 * Absent, the flow reads the real `process.env`, and a proof whose content depends on whoever
	 * ran it is not a proof.
	 */
	readEnv?: (variable: string) => string | undefined;
}

/** A fresh manager over the shared vault, or over whatever `options` names instead. */
async function manager(options: SectionOptions = {}): Promise<SecretManager> {
	const component = new SecretManager({
		vault: new SecretVault(options.locations ?? locations),
		auditLog: options.auditLog === null ? undefined : (options.auditLog ?? auditLog),
		...(options.terminalHeight === undefined ? {} : { terminalHeight: options.terminalHeight }),
		...(options.readEnv === undefined ? {} : { readEnv: options.readEnv }),
	});
	await component.settled();
	return component;
}

const lines: string[] = [];

/**
 * Render one state.
 *
 * `before` runs BEFORE the component is constructed, which is the whole reason it exists: the
 * manager loads the vault as it comes up, so a section that corrupts the file from inside `drive`
 * corrupts it after the load and renders the healthy table instead. That produced a proof of the
 * repair state that was really a second copy of the list, and only the image showed it.
 */
async function section(
	title: string,
	drive: (component: SecretManager) => Promise<void> | void,
	before?: () => Promise<void>,
	options: SectionOptions = {},
): Promise<void> {
	if (!title.includes(only)) return;
	await before?.();
	const component = await manager(options);
	await drive(component);
	await component.settled();
	lines.push(theme.fg("dim", title), ...component.render(options.width ?? width), "");
}

// The everyday state. Three secrets across all three scopes, so the SCOPE column is exercised
// rather than showing one repeated word, and one entry that never expires beside two that do.
await section("the list, three secrets across three scopes:", () => {});

// THE HOVER PAIR. The section above is the same card with no pointer on it, so the two together
// show what the pointer adds and nothing else. The card has to be rendered BEFORE the motion
// event, because it records the geometry a hit test needs while it paints.
await section("the list, pointer resting on the first row:", component => {
	const painted = component.render(width);
	const row = painted.findIndex(line => stripAnsi(line).includes("#"));
	// SGR-1006 motion with no button held, one-based on the wire.
	component.handleInput(`\x1b[<35;30;${row + 1}M`);
});

// The destructive path. Rendered because it is the one action that cannot be undone and the
// question a proof answers is whether the card still reads as the same surface while it asks.
await section("revoke, awaiting confirmation:", component => {
	component.handleInput("r");
});

// An inline field over the table. Two of these exist (extend and rename) and they share a
// layout, so rendering one is enough to judge whether a field reads as part of the card.
await section("rename, field open on the selected row:", component => {
	component.handleInput("n");
});

// THE DIFFERENTIAL this change exists for. The Log view used to be `renderLog`, the transcript
// the non-interactive `/secret log` prints, split on newline and dropped into the card. The
// "before" below is that exact string, so the pair is a real contrast and not a redraw of the
// same thing: unaligned, two rows per record, a header sentence counting what the body repeats.
const transcriptTitle = "the log, BEFORE (the CLI transcript pasted into the card):";
if (transcriptTitle.includes(only)) {
	const { records: proofRecords, malformed: proofMalformed } = await auditLog.read({ limit: 40 });
	lines.push(
		theme.fg("dim", transcriptTitle),
		...renderLog(proofRecords, { malformed: proofMalformed, path: auditLog.path, now: Date.now() }).split("\n"),
		"",
	);
}

// And the same records as a table: one row each, columns measured across every record, and the
// selected record's command in full underneath so the WHERE column can truncate without losing it.
await section("the log, AFTER (a table over the same records):", component => {
	component.handleInput("\t");
});

// THE SEARCH PAIR. The first section above is the unfiltered table, so this is its counterpart:
// the same vault narrowed by a query, with the matched run highlighted inside the placeholder and
// a line under the table saying how much is hidden. A single filtered frame would not show that
// the filter did anything, which is why the two are read together.
await section("the list, narrowed by a search:", async component => {
	component.handleInput("/");
	await component.settled();
	for (const character of "key") component.handleInput(character);
	component.handleInput("\r");
});

// A search that matched nothing, which must NOT read as an empty vault. This is the pair for the
// onboarding empty state, and the whole point is that the two say different things.
await section("the list, a search that matched nothing:", async component => {
	component.handleInput("/");
	await component.settled();
	for (const character of "zzz") component.handleInput(character);
	component.handleInput("\r");
});

// Sorted by expiry rather than by name. Contrast with the first section: the never-expiring entry
// has to sit at the BOTTOM under soonest-first, which is the ordering a null expiry gets wrong.
await section("the list, sorted by expiry:", component => {
	component.handleInput("s");
	component.handleInput("s");
});

// The detail panel, the only surface in the product that shows when a credential was stored and
// what it has been spent on. Its counterpart is every section above, none of which can say either.
await section("the list, with the detail panel open:", component => {
	component.handleInput("i");
});

// The add flow's FIRST field. It asks for the value, not the name, and the field is masked: this
// image is the standing proof of that ordering, which is the defect that once stored the string
// GITHUB_TOKEN as a live credential.
await section("storing a credential, the first field:", component => {
	component.handleInput("a");
});

// The same flow's second field, unmasked, so the pair shows the value is hidden and the name is
// not. One frame alone cannot show that the masking is conditional.
await section("storing a credential, the second field:", async component => {
	component.handleInput("a");
	await component.settled();
	for (const character of "ghp_valueTypedIntoTheField") component.handleInput(character);
	component.handleInput("\r");
});

// THE ENV PAIR, and it only means anything beside the masked field above. `f` asks for the NAME of
// an environment variable, unmasked, so what the operator types is readable; `a` asks for the
// credential and hides it. Two frames, one key apart, showing that the manager has an entry form
// where the credential is never typed and never drawn.
await section(
	"storing a credential from an environment variable, the first field:",
	component => {
		component.handleInput("f");
	},
	undefined,
	{ readEnv: variable => (variable === "GITHUB_TOKEN" ? "ghp_readOutOfTheEnvironment" : undefined) },
);

// The refusal, which NAMES the variable. Every other refusal on this card withholds what was typed
// because it is a credential; this one must echo it, or a typo in a variable name is indistinguishable
// from a variable the shell never exported.
await section(
	"storing a credential from an environment variable, the variable is not set:",
	async component => {
		component.handleInput("f");
		await component.settled();
		for (const character of "GITHUB_TOEKN") component.handleInput(character);
		component.handleInput("\r");
	},
	undefined,
	{ readEnv: () => undefined },
);

// The move confirmation, which names both scopes and never the value.
await section("moving a credential to another scope:", component => {
	component.handleInput("m");
});

// THE LOG-NARROWING PAIR. Three sections, and they only mean anything together: the whole log,
// then that same log narrowed to one credential, then narrowed again by a search within it. A
// single shot of a filtered table proves nothing, because a table showing two rows looks exactly
// like a log that only ever recorded two uses. The contrast is the proof, and the notice line
// above the rows is the thing being judged: it is what stops a narrowed log from reading as
// complete.
await section("the log, every recorded use (OFF):", async component => {
	component.handleInput("\t");
	await component.settled();
});

await section("the log, narrowed to one credential with `u` (ON):", async component => {
	// `u` is pressed in the Secrets view, on the selected row, and switches to the Log itself.
	component.render(width);
	component.handleInput("u");
	await component.settled();
});

await section("the log, that credential's uses searched with `/` (ON, composed):", async component => {
	// Down one row first, onto the credential with TWO uses. Composing on a credential with one
	// use would show "1 of 3" before and after the search, and prove nothing about composing.
	component.render(width);
	component.handleInput("j");
	component.handleInput("u");
	await component.settled();
	component.handleInput("/");
	await component.settled();
	component.handleInput("api.github.com");
	component.handleInput("\r");
	await component.settled();
});

// The key map. The footer can only carry the first few actions, so this is where the rest live.
await section("the key map:", component => {
	component.handleInput("?");
});

// ============================================================================
// The degenerate states.
//
// Everything above is a card with something in it. These are the cards an operator meets on a
// fresh profile, after a search that missed, and on a terminal too narrow for the table, and
// they are the states nobody looks at because nobody has to seed them by accident. Each one
// gets its own vault so the sections above keep painting the three secrets they are the proof
// of, and so a corrupted or empty file here cannot leak into them.
// ============================================================================

const freshHome = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-proof-fresh-home-"));
const freshProject = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-proof-fresh-proj-"));
const freshLocations = resolveVaultLocations({
	globalConfigRoot: freshHome,
	agentDir: path.join(freshHome, "profiles", "default"),
	cwd: freshProject,
});
// Created and flushed, so the file EXISTS and holds nothing. An absent file and an empty one
// both read back as zero records, and the card has to name the path either way.
const freshLog = new SecretAuditLog(secretAuditPath(freshLocations));
await freshLog.flush();

// EVERY SECTION BELOW PINS 40 ROWS. See `SectionOptions.terminalHeight`: a piped render is a
// 24-row compact card, which is two columns wider than the card an operator on an ordinary
// terminal sees, and the whole subject here is what happens to a line that does not fit.
const DEGENERATE_ROWS = 40;

// The onboarding card. Nothing is stored, so no row action can act on anything, and the footer
// is the thing being judged: a chip offering `r revoke` here points at nothing.
await section("an empty vault, nothing stored yet:", () => {}, undefined, {
	locations: freshLocations,
	auditLog: freshLog,
	terminalHeight: DEGENERATE_ROWS,
});

// THE EMPTY-LOG PAIR. Recording is ON here and OFF below, and the two must not read the same:
// "no credential has been spent" is evidence, and "nothing is being recorded" is the absence of
// it. The path is the payload of the first one, so a path the card cuts in half is the defect.
await section(
	"the log, nothing recorded yet:",
	async component => {
		component.handleInput("\t");
		await component.settled();
	},
	undefined,
	{ locations: freshLocations, auditLog: freshLog, terminalHeight: DEGENERATE_ROWS },
);

await section(
	"the log, recording switched off:",
	async component => {
		component.handleInput("\t");
		await component.settled();
	},
	undefined,
	{ locations: freshLocations, auditLog: null, terminalHeight: DEGENERATE_ROWS },
);

const edgeHome = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-proof-edge-home-"));
const edgeProject = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-proof-edge-proj-"));
const edgeLocations = resolveVaultLocations({
	globalConfigRoot: edgeHome,
	agentDir: path.join(edgeHome, "profiles", "default"),
	cwd: edgeProject,
});
const edgeVault = new SecretVault(edgeLocations);
// Sorted A to Z the unspent one is first, so it is the row the cursor rests on when the card
// opens and `u` needs no navigation to reach it.
await edgeVault.add({ name: "BACKUP_TOKEN", value: "bkp_proofCredential00001", scope: "profile", ttl: 7 * 86_400_000 });
await edgeVault.add({ name: "SPENT_TOKEN", value: "spt_proofCredential00002", scope: "project", ttl: 7 * 86_400_000 });
const edgeLog = new SecretAuditLog(secretAuditPath(edgeLocations));
edgeLog.record({
	at: Date.parse("2026-07-31T09:14:02Z"),
	tool: "bash",
	command: "curl -H 'Authorization: bearer #SPENT_TOKEN#' https://api.github.com/user/repos",
	secrets: ["#SPENT_TOKEN#"],
});
// A TOOL NAME IN WIDE CHARACTERS. An MCP server names its own tools, so this column is the one
// cell of the log table whose text is neither veyyon's nor bounded to ASCII. Every cell right of
// it is positioned by padding this one, which is what makes a mis-measured pad a broken table
// rather than a cosmetic wobble.
edgeLog.record({
	at: Date.parse("2026-07-31T10:31:44Z"),
	tool: "mcp__文書__検索",
	command: "search --index prod --token #SPENT_TOKEN#",
	secrets: ["#SPENT_TOKEN#"],
});
await edgeLog.flush();

// `u` ON A CREDENTIAL THAT HAS NEVER BEEN SPENT. This is the answer to "what breaks if I revoke
// this", and the answer is "nothing" — which the card has to SAY, because an empty table under a
// heading is indistinguishable from a table that failed to load.
await section(
	"the log, narrowed with `u` to a credential never spent:",
	async component => {
		component.render(width);
		component.handleInput("u");
		await component.settled();
	},
	undefined,
	{ locations: edgeLocations, auditLog: edgeLog, terminalHeight: DEGENERATE_ROWS },
);

// A search that matched nothing, in the LOG. Its counterpart is "the list, a search that matched
// nothing" above: the roster has explained this state for a while and the log has not.
await section(
	"the log, a search that matched nothing:",
	async component => {
		component.handleInput("\t");
		await component.settled();
		component.handleInput("/");
		await component.settled();
		component.handleInput("zzz");
		component.handleInput("\r");
		await component.settled();
	},
	undefined,
	{ locations: edgeLocations, auditLog: edgeLog, terminalHeight: DEGENERATE_ROWS },
);

// The alignment proof for the wide tool name. Two records whose TOOL cells disagree about width
// in CELLS but not in code units, which is the disagreement a `padEnd` cannot see.
await section(
	"the log, a tool named in wide characters:",
	async component => {
		component.handleInput("\t");
		await component.settled();
	},
	undefined,
	{ locations: edgeLocations, auditLog: edgeLog, terminalHeight: DEGENERATE_ROWS },
);

// THE NARROW PAIR. 60 columns is a split pane and 40 is a phone-sized terminal; both have to keep
// the border closed and the columns apart rather than overlapping into each other.
await section("the list on a 60-column card:", () => {}, undefined, {
	width: 60,
	terminalHeight: DEGENERATE_ROWS,
});
await section("the list on a 40-column card:", () => {}, undefined, {
	width: 40,
	terminalHeight: DEGENERATE_ROWS,
});

// The repair state. A vault that cannot be read is the reason the manager has to be more than a
// table: it is now the only surface in a terminal that can move a broken file aside.

await section(
	"an unreadable vault, offering the repair:",
	() => {},
	() => Bun.write(vaultPathFor(locations, "profile"), "this is not a vault").then(() => {}),
);

process.stdout.write(`${lines.join("\n")}\n`);
for (const dir of [home, project, freshHome, freshProject, edgeHome, edgeProject]) {
	await fs.rm(dir, { recursive: true, force: true });
}
