/**
 * `veyyon __complete <kind> [-- <prefix>]` — dynamic completion candidates.
 *
 * Hidden helper invoked by the generated shell completion scripts to resolve
 * values that can't be baked into the script: the live model catalog and
 * on-disk sessions. Output is one `value\tdescription` line per candidate
 * (tab-separated); shells that show descriptions parse the tab, bash uses the
 * first field. The import surface is kept deliberately narrow so a TAB press
 * doesn't pay for the full agent boot.
 */
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import { Command } from "@veyyon/utils/cli";
import { SETTINGS_SCHEMA } from "../config/settings-schema";
import { SessionManager } from "../session/session-manager";

/** Every kind this helper answers. Shared with the completion generator. */
export const COMPLETE_KINDS = ["models", "sessions", "settings", "setting-values"] as const;

export default class Complete extends Command {
	static hidden = true;
	static strict = false;

	async run(): Promise<void> {
		const argv = this.argv.filter(token => token !== "--");
		const kind = argv[0];
		const prefix = argv.length > 1 ? argv[argv.length - 1] : "";
		if (kind === "models") {
			completeModels(prefix);
		} else if (kind === "sessions") {
			await completeSessions(prefix);
		} else if (kind === "settings") {
			completeSettings(prefix);
		} else if (kind === "setting-values") {
			// `<key> <prefix>`: the key names the setting whose values to offer.
			completeSettingValues(argv[1] ?? "", argv.length > 2 ? prefix : "");
		} else {
			// A kind nobody serves must not look like a kind with no matches. The
			// generated scripts discard stderr, so this is for whoever runs the
			// helper by hand while working out why completion is empty.
			process.stderr.write(
				`Error: unknown completion kind ${kind ? `"${kind}"` : "(missing)"}; expected one of ${COMPLETE_KINDS.join(", ")}\n`,
			);
			process.exitCode = 1;
		}
	}
}

/** Strip control chars that would corrupt the tab-separated line protocol. */
function clean(text: string): string {
	return text.replace(/[\t\r\n]+/g, " ").trim();
}

function completeModels(prefix: string): void {
	const needle = prefix.toLowerCase();
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider as GeneratedProvider)) {
			// Offer both the fully-qualified `provider/id` and the bare `id`
			// (matches the fuzzy resolution `--model` accepts).
			const candidates = [`${model.provider}/${model.id}`, model.id];
			for (const candidate of candidates) {
				if (seen.has(candidate)) continue;
				seen.add(candidate);
				if (needle && !candidate.toLowerCase().includes(needle)) continue;
				lines.push(`${candidate}\t${model.provider}`);
			}
		}
	}
	lines.sort();
	if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
}

async function completeSessions(prefix: string): Promise<void> {
	const sessions = await SessionManager.list(process.cwd());
	const lines: string[] = [];
	for (const session of sessions) {
		if (prefix && !session.id.startsWith(prefix)) continue;
		const label = clean(session.title ?? session.firstMessage ?? "").slice(0, 72);
		lines.push(`${session.id}\t${label}`);
	}
	if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
}

/** The schema read structurally: its literal entries carry readonly tuples. */
const SCHEMA_ENTRIES = SETTINGS_SCHEMA as unknown as Record<
	string,
	{ type?: string; values?: readonly string[]; ui?: { label?: string; description?: string } } | undefined
>;

/**
 * Setting keys, so `veyyon config set <TAB>` offers the settings that exist.
 *
 * The schema is the one place a setting is declared, so completion cannot drift
 * from what `config set` actually accepts.
 */
function completeSettings(prefix: string): void {
	// Prefix, not substring: a setting is a dotted path the user types from the
	// left, and `up` substring-matching 40 unrelated keys is noise where
	// `startup.` narrowing to six is an answer. Model ids are matched loosely
	// because they are chosen by fragment, not typed out.
	const needle = prefix.toLowerCase();
	const lines: string[] = [];
	for (const key of Object.keys(SETTINGS_SCHEMA)) {
		if (needle && !key.toLowerCase().startsWith(needle)) continue;
		// The prose a user reads in the settings panel, so the tooltip a shell
		// shows says the same thing the UI does. Not every setting has one.
		const ui = SCHEMA_ENTRIES[key]?.ui;
		lines.push(`${key}\t${clean(ui?.description ?? ui?.label ?? "")}`);
	}
	lines.sort();
	if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * The values a given setting accepts.
 *
 * A boolean setting takes true or false and an enumerated one carries its own
 * list; anything else is free-form, and offering nothing is the honest answer.
 */
function completeSettingValues(key: string, prefix: string): void {
	const def = SCHEMA_ENTRIES[key];
	if (!def) return;
	const values = def.values ?? (def.type === "boolean" ? ["true", "false"] : undefined);
	if (!values) return;
	const needle = prefix.toLowerCase();
	const lines = values.filter(v => !needle || v.toLowerCase().startsWith(needle)).map(v => `${v}\t${key}`);
	if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
}
