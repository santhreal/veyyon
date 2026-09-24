/**
 * Autocomplete and inline-hint builders for the builtin slash commands.
 *
 * These answer what a command's ARGUMENT may be, which is a different question from what the
 * command does, and they are read by the TUI materialiser rather than by a handler.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getActiveProfile, getProjectDir, listProfiles } from "@veyyon/utils";
import type { AutocompleteItem } from "@veyyon/utils/autocomplete";
import { SECRET_TUI_SUBCOMMANDS } from "../secrets/secret-command";
import { expandTilde } from "../tools/core/path-utils";
import type { SubcommandDef } from "./types";

/**
 * Build getArgumentCompletions from declarative subcommand definitions.
 * Returns subcommand names filtered by prefix in the dropdown.
 *
 * A subcommand typed in full that takes no argument offers nothing: with the
 * list open, Enter accepts the highlighted item instead of submitting, so
 * `/room new` followed by Enter would only add a space and wait for a second
 * Enter. With nothing offered, the one Enter runs it.
 */
export function buildArgumentCompletions(subcommands: SubcommandDef[]): (prefix: string) => AutocompleteItem[] | null {
	return (argumentPrefix: string) => {
		if (argumentPrefix.includes(" ")) return null; // past the subcommand
		const lower = argumentPrefix.toLowerCase();
		const matching = subcommands.filter(s => s.name.startsWith(lower));
		if (matching.length === 1 && matching[0]!.name === lower && !matching[0]!.usage) return null;
		const matches = matching.map(s => ({
			value: `${s.name} `,
			label: s.name,
			description: s.description,
			hint: s.usage,
		}));
		return matches.length > 0 ? matches : null;
	};
}

/**
 * Build getInlineHint from declarative subcommand definitions.
 * Shows remaining completion + usage as dim ghost text after cursor.
 */
export function buildSubcommandInlineHint(subcommands: SubcommandDef[]): (argumentText: string) => string | null {
	return (argumentText: string) => {
		const trimmed = argumentText.trimStart();
		const spaceIndex = trimmed.indexOf(" ");

		if (spaceIndex === -1) {
			// Still typing subcommand name — show remaining chars + usage
			const prefix = trimmed.toLowerCase();
			if (prefix.length === 0) return null;
			const match = subcommands.find(s => s.name.startsWith(prefix));
			if (!match) return null;
			const remaining = match.name.slice(prefix.length);
			return remaining + (match.usage ? ` ${match.usage}` : "");
		}

		// Subcommand typed — show remaining usage params
		const subName = trimmed.slice(0, spaceIndex).toLowerCase();
		const afterSub = trimmed.slice(spaceIndex + 1);
		const sub = subcommands.find(s => s.name === subName);
		if (!sub?.usage) return null;

		if (afterSub.length > 0) {
			const usageParts = sub.usage.split(" ");
			const inputParts = afterSub.trim().split(/\s+/);
			const remaining = usageParts.slice(inputParts.length);
			return remaining.length > 0 ? remaining.join(" ") : null;
		}

		return sub.usage;
	};
}

/**
 * Build getInlineHint for commands with a simple static hint string.
 * Shows the hint only when no arguments have been typed yet.
 */
export function buildStaticInlineHint(hint: string): (argumentText: string) => string | null {
	return (argumentText: string) => (argumentText.trim().length === 0 ? hint : null);
}

/**
 * Build getArgumentCompletions for /profile: existing profile names (marked
 * active/switch) plus the verb subcommands.
 */
export function buildProfileArgumentCompletions(): (prefix: string) => Promise<AutocompleteItem[] | null> {
	return async (argumentPrefix: string) => {
		const prefix = argumentPrefix.trimStart();
		if (prefix.includes(" ")) return null;
		const { readProfileDisplayName } = await import("../cli/profile-cli");
		const active = getActiveProfile() ?? "default";
		const items: AutocompleteItem[] = [];
		for (const profile of listProfiles()) {
			if (!profile.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
			const display = await readProfileDisplayName(profile.name === "default" ? undefined : profile.name);
			items.push({
				value: profile.name,
				label: profile.name,
				description:
					(profile.name === active ? "active" : "switch (fresh session)") +
					(display && display !== profile.name ? ` (${display})` : ""),
			});
		}
		for (const sub of ["list", "new ", "create ", "switch ", "rename to ", "rm ", "delete "]) {
			if (sub.startsWith(prefix.toLowerCase())) {
				items.push({ value: sub, label: sub.trim(), description: "" });
			}
		}
		return items.length > 0 ? items : null;
	};
}

/**
 * Argument completion for `/secret`, one entry per subcommand the terminal parses.
 *
 * DERIVED, NOT LISTED. `SECRET_TUI_SUBCOMMANDS` is built from the parser's own table of reserved
 * words, so a subcommand cannot be typeable and unoffered. A hand-written menu beside a separate
 * help text is two lists that drift, and the drift is not cosmetic: a verb the help advertises and
 * the terminal does not parse is stored as a credential instead of run.
 *
 * NAMES ARE NEVER OFFERED. Completing the names of stored secrets would render part of the vault on
 * a keystroke, and under the verbless grammar it once also stored the whole suggestion as a
 * credential when the verb turned out not to parse. `/secret list` is where names are read, on
 * purpose and in one place.
 *
 * The prefix filter is what keeps the menu out of a paste: a pasted credential arrives as one
 * insert, so the prefix is the entire token and matches nothing. Only a hand-typed word that is
 * genuinely the start of a subcommand opens the dropdown.
 */
export const secretArgumentCompletions = (argumentPrefix: string): AutocompleteItem[] | null => {
	if (argumentPrefix.includes(" ")) return null; // past the subcommand
	const prefix = argumentPrefix.toLowerCase();
	const matches = SECRET_TUI_SUBCOMMANDS.filter(sub => sub.name.startsWith(prefix)).map(sub => ({
		value: sub.usage === "" ? sub.name : `${sub.name} `,
		label: sub.name,
		description: sub.description,
		hint: sub.usage === "" ? undefined : sub.usage,
	}));
	return matches.length > 0 ? matches : null;
};

/**
 * The ghost text after `/secret`, which is the only thing on screen before anything is typed.
 *
 * Two hints, because the two moments want different sentences. Empty line: the declared summary of
 * the whole grammar, since the operator has been given a blank field and needs to know a value can
 * go straight into it. Mid-word: the usage of the subcommand being typed, so `/secret ex` completes
 * itself and says it wants a name and a lifetime.
 */
export function buildSecretInlineHint(inlineHint: string | undefined): (argumentText: string) => string | null {
	return (argumentText: string) => {
		const trimmed = argumentText.trimStart();
		if (trimmed.length === 0) return inlineHint ?? null;
		if (trimmed.includes(" ")) {
			const typed = trimmed.slice(0, trimmed.indexOf(" ")).toLowerCase();
			const exact = SECRET_TUI_SUBCOMMANDS.find(sub => sub.name === typed);
			// Only while the argument is still just the verb: past that the operator is typing a name
			// or a credential, and a hint that keeps naming the usage overwrites nothing but reads as
			// if the line were incomplete.
			return exact !== undefined && trimmed.trimEnd() === typed && exact.usage !== "" ? exact.usage : null;
		}
		const match = SECRET_TUI_SUBCOMMANDS.find(sub => sub.name.startsWith(trimmed.toLowerCase()));
		if (match === undefined) return null;
		const remaining = match.name.slice(trimmed.length);
		return match.usage === "" ? remaining : `${remaining} ${match.usage}`;
	};
}

/**
 * Build getArgumentCompletions that suggests directories relative to the
 * current project directory. Used by /move so users can Tab-complete the
 * destination directory.
 */
export function buildDirectoryArgumentCompletions(): (prefix: string) => Promise<AutocompleteItem[] | null> {
	return async (argumentPrefix: string) => {
		const prefix = argumentPrefix.trim();

		const cwd = getProjectDir();
		const expandedPrefix = expandTilde(prefix);
		const isAbsolute = path.isAbsolute(expandedPrefix);

		let searchDir: string;
		let searchPrefix: string;
		if (
			prefix === "" ||
			prefix === "." ||
			prefix === "./" ||
			prefix === ".." ||
			prefix === "../" ||
			prefix === "~" ||
			prefix === "~/" ||
			prefix === "/"
		) {
			searchDir = isAbsolute ? expandedPrefix : path.join(cwd, expandedPrefix);
			searchPrefix = "";
		} else if (expandedPrefix.endsWith("/")) {
			searchDir = isAbsolute ? expandedPrefix : path.join(cwd, expandedPrefix);
			searchPrefix = "";
		} else {
			const dir = path.dirname(expandedPrefix);
			searchDir = isAbsolute ? dir : path.join(cwd, dir);
			searchPrefix = path.basename(expandedPrefix);
		}

		try {
			const entries = await fs.readdir(searchDir, { withFileTypes: true });
			const suggestions: AutocompleteItem[] = [];
			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) continue;
				if (entry.name === ".git") continue;

				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						isDirectory = (await fs.stat(path.join(searchDir, entry.name))).isDirectory();
					} catch {
						continue;
					}
				}
				if (!isDirectory) continue;

				const absoluteValue = path.join(searchDir, entry.name);
				const displayValue = buildDirectoryCompletionDisplayValue(prefix, absoluteValue, cwd);
				suggestions.push({ value: displayValue, label: `${entry.name}/` });
			}
			suggestions.sort((a, b) => a.label.localeCompare(b.label));
			return suggestions.length > 0 ? suggestions : null;
		} catch {
			// Completion for a half-typed path, re-run on every keystroke: the directory named by an
			// incomplete prefix usually does not exist yet, so failing to list it is the norm rather than an
			// error. Null means "no suggestions", and nothing is cached, so the next keystroke tries again.
			return null;
		}
	};
}

export function buildDirectoryCompletionDisplayValue(prefix: string, absoluteValue: string, cwd: string): string {
	// Preserve the user's prefix style where possible, but always return a
	// value that /move can resolve (absolute or relative) without escaping.
	const normalized = path.normalize(absoluteValue);

	if (prefix.startsWith("~/")) {
		const home = os.homedir();
		const homeRelative = path.relative(home, normalized);
		return `~/${homeRelative.replaceAll("\\", "/")}/`;
	}
	if (prefix === "~") {
		const home = os.homedir();
		const homeRelative = path.relative(home, normalized);
		return `~/${homeRelative.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("/")) {
		return `${normalized.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("./")) {
		const relative = path.relative(cwd, normalized);
		return `./${relative.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("../")) {
		const relative = path.relative(cwd, normalized);
		return `${relative.replaceAll("\\", "/")}/`;
	}
	if (prefix === "..") {
		const relative = path.relative(cwd, normalized);
		return `${relative.replaceAll("\\", "/")}/`;
	}

	// Default: relative to cwd.
	const relative = path.relative(cwd, normalized);
	return `${relative.replaceAll("\\", "/")}/`;
}
