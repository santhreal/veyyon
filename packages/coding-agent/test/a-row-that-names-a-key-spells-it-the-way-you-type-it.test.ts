/**
 * WHY THIS SUITE EXISTS.
 *
 * A row that names a key is instruction, and the instruction has to match the
 * thing you do. You type `ctrl+o`, lowercase, so that is how the row spells it.
 * The product spelled it eleven other ways instead: `Ctrl+O`, `Ctrl-O`, `^O`,
 * `Esc`, `ESC`, `escape`, `Enter`, `⏎`, `Shift+Tab`, `PgUp`, `Press Enter`. The
 * settings selector alone carried twenty-nine of them and the model hub
 * seventeen, so two adjacent rows of one screen disagreed about the shape of the
 * same keyboard.
 *
 * THE CLASS. Every key a surface names in a row — a footer chip, an inline hint,
 * a placeholder, an empty-state line, a status message — is lowercase and
 * `+`-joined, with `/` between alternatives. It is purely a matter of CASE:
 * `Press esc to cancel it first.` keeps its verb, because a full sentence reads
 * as a sentence; a bare hint row drops it, because `esc cancel` is the chip
 * grammar the footline already uses.
 *
 * THE BOUNDARY, and there are five registers this rule does NOT reach:
 *
 * - The keybinding TABLE. `/hotkeys`, the settings list and the generated
 *   `keybindings.yml` reference render through `formatKeyHints`, which is title
 *   case on purpose: a two-column table of `Ctrl+O` reads as a table, and the
 *   register split is pinned by an arm below rather than left to habit.
 * - Log and telemetry text, which no user reads in a row.
 * - Code comments and test titles, which are prose about the product.
 * - A setting's LABEL (`Double-Escape Action`), which is a title.
 * - Text written for the model: a tool schema description, a scraper note.
 *
 * And the English words. `Enter a unique name for this server:` is a verb,
 * `Tab worker is busy` is a noun, `## Space Info` is a heading, `*** End Patch`
 * is a patch marker. Twelve of the forty exempt strings below are the mcp
 * wizard's prompts, all of them the verb.
 *
 * WHAT IT DOES NOT CATCH. A row naming a key nobody bound: the sweep reads
 * spelling, not liveness, and its sibling
 * `modes/utils/no-surface-writes-a-hint-out-by-hand.test.ts` owns that half. A
 * bare `enter`/`esc` in a prose row is still a literal there, deliberately —
 * `tui.select.cancel` resolves to two keys, so reading it live would print
 * `escape/ctrl+c close` in ninety-eight chip labels. And a key spelled correctly
 * but named wrongly for what it does, which no scan can see.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatKeyHints, type KeybindingsConfig, KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { buildComposerShortcuts } from "@veyyon/coding-agent/modes/components/composer-shortcuts";
import { keyHint, primaryKeyHint } from "@veyyon/coding-agent/modes/utils/key-hint";
import { resetKeybindingsForTests, setKeybindings } from "@veyyon/tui";

/** The two trees that draw rows. `tui/` prefixes the second so the keys cannot collide. */
const ROOTS: ReadonlyArray<{ prefix: string; dir: string }> = [
	{ prefix: "", dir: path.resolve(import.meta.dir, "../src") },
	{ prefix: "tui/", dir: path.resolve(import.meta.dir, "../../tui/src") },
];

/**
 * A key NAME in the shape this rule rejects: a named key title-cased, or any
 * modifier joined with `+`. Lowercase `ctrl+o` and `esc` do not match, which is
 * the whole point — the rule is about case, so the detector is about case.
 */
const KEY = /\b(Esc|Escape|Enter|Backspace|Del|PgUp|PgDn|Tab|Space|End)\b|\b(Ctrl|Alt|Shift|Cmd|Super|Meta)\+/;

/** A double-quoted or backtick string literal, escapes included. */
const STRING = /"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;

/**
 * Strings that carry a title-cased key name for a reason, keyed by file, with
 * the exact strings pinned.
 *
 * Keyed by file AND by string, unlike a plain file exemption: `settings-selector.ts`
 * and `mcp-add-wizard.ts` draw real rows as well, so excusing the whole file would
 * excuse the next offender in the surface that had twenty-nine of them.
 */
const EXEMPT: Record<string, { why: string; strings: readonly string[] }> = {
	"cli/auth-broker-cli.ts": {
		why: "The verb: a numbered prompt asking for a choice.",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${…} is source text this suite pins, not an interpolation here
		strings: ["Enter number (1-${providers.length}): "],
	},
	"cli/gallery-fixtures/web.ts": {
		why: "A fixture stack frame quoting a class name, `Tab.waitFor`.",
		strings: ["    at Tab.waitFor (browser/tab.ts:212:13)"],
	},
	"config/keybinding-defs.ts": {
		why: "The binding table's own description of a push-to-talk gesture, in table register.",
		strings: ["Toggle speech-to-text (default gesture: hold Space)"],
	},
	"config/settings-domains/global.ts": {
		why: "The verb, in a setting's description sentence about replacing a stored token.",
		strings: [
			"Bearer token for the auth broker. Write-only: a stored token shows as a mask and is never echoed. Enter a new value to replace it, leave the mask to keep it, or clear the field to delete it.",
		],
	},
	"config/settings-domains/interaction.ts": {
		why: "A setting's label, which is a title rather than an instruction.",
		strings: ["Double-Escape Action"],
	},
	"edit/apply-patch/markers.ts": {
		why: "A patch marker's exact bytes; the file format decides its case.",
		strings: ["*** End of File"],
	},
	"edit/apply-patch/parser.ts": {
		why: "The same marker, quoted back in the error that a patch is missing it.",
		strings: ["The last line of the patch must be '*** End Patch'"],
	},
	"edit/renderer.ts": {
		why: "The same marker again, in the renderer's copy of that message.",
		strings: ["The last line of the patch must be '*** End Patch'"],
	},
	"extensibility/custom-commands/bundled/review/index.ts": {
		why: "The verb, prompting for review instructions.",
		strings: ["Enter custom review instructions"],
	},
	"modes/components/mcp-add-wizard.ts": {
		why: "Twelve field prompts, every one of them the verb `Enter <a thing>`.",
		strings: [
			"Enter a unique name for this server:",
			"Enter the command to run:",
			"Enter command arguments (space-separated):",
			"Enter the server URL:",
			"Enter the environment variable name:",
			"Enter the HTTP header name:",
			"Enter the OAuth authorization endpoint:",
			"Enter the OAuth token endpoint:",
			"Enter your OAuth client ID:",
			"Enter your OAuth client secret:",
			"Enter OAuth scopes (space-separated):",
			"Enter your API key or token:",
		],
	},
	"modes/components/settings-selector.ts": {
		why: "The verb, in the help text for a numeric field.",
		strings: ["Enter a positive number. Decimals round down. Clear the field to make this provider unlimited."],
	},
	"modes/utils/hotkeys-markdown.ts": {
		why: "The `/hotkeys` table itself, which is the register this rule is defined against.",
		strings: [
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${…} is source text this suite pins, not an interpolation here
			'| \\`${key(bindings, "tui.editor.cursorLineEnd")}\\` | End of line |',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${…} is source text this suite pins, not an interpolation here
			'| \\`${key(bindings, "tui.input.newLine")}\\` / \\`Alt+Enter\\` | New line |',
			"| Hold `Space` | Speech-to-text (push-to-talk): hold to record, release to transcribe |",
		],
	},
	"tools/ask.ts": {
		why: "The verb, prompting the operator for an answer.",
		strings: ["Enter your response:"],
	},
	"tools/browser.ts": {
		why: "The noun: a browser tab, in text written for the model.",
		strings: [
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${…} is source text this suite pins, not an interpolation here
			"Tab: ${truncateForPrompt(tabName)}",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${…} is source text this suite pins, not an interpolation here
			"Tab ${JSON.stringify(name)} is bound to a different browser (${describeKind(existing.browser.kind)}). Close it first.",
		],
	},
	"tools/browser/tab-supervisor.ts": {
		why: "The same noun, in six supervisor errors the model reads.",
		strings: [
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${…} is source text this suite pins, not an interpolation here
			"Tab ${JSON.stringify(name)} was killed: ${killed}. Reopen it.",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${…} is source text this suite pins, not an interpolation here
			'Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${…} is source text this suite pins, not an interpolation here
			"Tab ${JSON.stringify(name)} is busy",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${…} is source text this suite pins, not an interpolation here
			"Tab ${JSON.stringify(name)} was closed",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${…} is source text this suite pins, not an interpolation here
			"Tab worker message error: ${String(event.data)}",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${…} is source text this suite pins, not an interpolation here
			"Tab worker failed during startup: ${error.message}",
		],
	},
	"tools/browser/tab-worker.ts": {
		why: "The same noun, in the worker's own two states.",
		strings: ["Tab worker is busy", "Tab worker is not initialized"],
	},
	"tools/launch.ts": {
		why: "A tool schema description, which is written for the model.",
		strings: ["send: append Enter after text; default true"],
	},
	"tui/keybindings.ts": {
		why: "A binding definition's description, in table register.",
		strings: ["Tab / autocomplete"],
	},
	"web/scrapers/huggingface.ts": {
		why: "A scraped Markdown heading, `## Space Info`, reproduced as found.",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${…} is source text this suite pins, not an interpolation here
		strings: ["## Space Info\\n\\n${readmeResult.content}"],
	},
	"web/scrapers/sec-edgar.ts": {
		why: "A filing field name, `Fiscal Year End`, reproduced as found.",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${…} is source text this suite pins, not an interpolation here
		strings: ["**Fiscal Year End:** ${fy.slice(0, 2)}/${fy.slice(2)}\\n"],
	},
};

/** Every `.ts` under a root, tests and vendored trees excluded. */
function sources(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "vendor") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) sources(full, found);
		else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) found.push(full);
	}
	return found;
}

/**
 * Every flagged string in one line of source.
 *
 * A string with no space in it is skipped: `"Ctrl+O"` alone is how a matcher and
 * a binding id are written, and a row always carries a word beside its key.
 * Comment lines and `logger.` lines are skipped for the same reason the sibling
 * suite skips them — they are prose and telemetry, not rows.
 */
export function titleCasedKeyNames(line: string): string[] {
	const stripped = line.trimStart();
	if (stripped.startsWith("*") || stripped.startsWith("//") || stripped.startsWith("/*")) return [];
	if (line.includes("logger.")) return [];
	const found: string[] = [];
	for (const match of line.matchAll(STRING)) {
		const body = match[1] ?? match[2];
		if (body?.includes(" ") && KEY.test(body)) found.push(body);
	}
	return found;
}

/** `<file>` → the flagged strings it holds, deduplicated, over both trees. */
function sweep(): Map<string, string[]> {
	const hits = new Map<string, string[]>();
	for (const { prefix, dir } of ROOTS) {
		for (const file of sources(dir)) {
			const relative = prefix + path.relative(dir, file).split(path.sep).join("/");
			for (const line of fs.readFileSync(file, "utf8").split("\n")) {
				for (const body of titleCasedKeyNames(line)) {
					const bucket = hits.get(relative) ?? [];
					if (!bucket.includes(body)) bucket.push(body);
					hits.set(relative, bucket);
				}
			}
		}
	}
	return hits;
}

/** `<file>: <string>` for every flagged string no exemption covers. */
function offenders(): string[] {
	const found: string[] = [];
	for (const [file, strings] of sweep()) {
		const allowed = EXEMPT[file]?.strings ?? [];
		for (const body of strings) if (!allowed.includes(body)) found.push(`${file}: ${body}`);
	}
	return found.sort();
}

describe("no row spells a key in title case", () => {
	/**
	 * The scan reads two real trees, and reaches the file in each one that drew
	 * the most of these rows. A walk that found nothing — a moved directory, a
	 * renamed package — would satisfy the rule below while checking nothing,
	 * which is how a source sweep dies quietly.
	 */
	it("reads both trees that draw rows", () => {
		const [agent = [], tui = []] = ROOTS.map(root => sources(root.dir));

		expect(agent.length).toBeGreaterThan(500);
		expect(tui.length).toBeGreaterThan(30);
		expect(agent.some(file => file.endsWith(path.join("components", "settings-selector.ts")))).toBe(
			true,
		);
		expect(tui.some(file => file.endsWith(path.join("components", "settings-list.ts")))).toBe(true);
		expect(sweep().size).toBeGreaterThan(10);
	});

	/**
	 * The rule. A failure names the file and the exact string, and the fix is to
	 * lowercase the key and drop a leading `Press` if the row was already a hint.
	 */
	it("spells every key the way you type it", () => {
		expect(
			offenders(),
			"this row names a key in title case. Lowercase it — a row is instruction, and the instruction has to match what you press",
		).toEqual([]);
	});

	/**
	 * The other direction, string by string. An exemption whose string has been
	 * reworded or deleted would silently excuse whatever appears in its place, and
	 * the two files that also draw real rows are exactly where that would land.
	 */
	it("holds no exemption that has stopped applying", () => {
		const live = sweep();
		const stale: string[] = [];
		for (const [file, { strings }] of Object.entries(EXEMPT)) {
			const found = live.get(file) ?? [];
			for (const body of strings) if (!found.includes(body)) stale.push(`${file}: ${body}`);
		}

		expect(stale).toEqual([]);
		expect(Object.values(EXEMPT).every(entry => entry.why.length > 20)).toBe(true);
	});

	/** The predicate: what it flags, and what it must never claim. */
	it("recognises the spellings it is looking for", () => {
		expect(titleCasedKeyNames('const hint = "Ctrl+O expand";')).toEqual(["Ctrl+O expand"]);
		expect(titleCasedKeyNames('const hint = "Press Esc to cancel";')).toEqual(["Press Esc to cancel"]);
		expect(titleCasedKeyNames('const hint = "Shift+Tab back";')).toEqual(["Shift+Tab back"]);

		// Already correct, so not a hit.
		expect(titleCasedKeyNames('const hint = "ctrl+o expand";')).toEqual([]);
		expect(titleCasedKeyNames('const hint = "esc cancel";')).toEqual([]);
		// A matcher and a binding id, which carry no word beside the key.
		expect(titleCasedKeyNames('if (matchesKey(data, "Ctrl+O")) return;')).toEqual([]);
		// Prose and telemetry.
		expect(titleCasedKeyNames(' * The footer says "Ctrl+O expand".')).toEqual([]);
		expect(titleCasedKeyNames('logger.debug("Ctrl+O pressed twice");')).toEqual([]);
		// The English words, which is why the exemption table is forty strings long.
		expect(titleCasedKeyNames('const prompt = "Tab worker is busy";')).toEqual(["Tab worker is busy"]);
	});
});

describe("the two registers stay apart", () => {
	/**
	 * A row and a table spell the same binding differently on purpose, and both
	 * spellings come from one formatter. Losing this split is how the class came
	 * back the first time: a well-meaning lowercase of `formatKeyHints` would
	 * repaint `/hotkeys`, the settings list and the generated reference page.
	 */
	it("keeps the table in title case and the row in lower", () => {
		expect(formatKeyHints(["ctrl+o", "pageUp"])).toBe("Ctrl+O/PgUp");
		expect(keyHint(["ctrl+o", "pageUp"])).toBe("ctrl+o/pgup");
	});

	/** An unbound action has no hint at all, in either register's reader. */
	it("spells nothing for a key that is not there", () => {
		expect(keyHint([])).toBe("");
	});
});

describe("a chip names the key that is bound", () => {
	const IDLE = {
		busy: true,
		hasDraft: false,
		hasQueue: false,
		focused: false,
		canBackgroundBash: true,
	};

	function labels(bindings?: KeybindingsConfig): string[] {
		return buildComposerShortcuts(new KeybindingsManager(bindings), IDLE).map(chip => chip.label);
	}

	/** The default, in the composer's own spelling. */
	it("reads the default binding in row register", () => {
		expect(labels()).toEqual(["esc interrupt", "ctrl+b background"]);
	});

	/**
	 * A remap the composer has to follow, chosen because `pageup` is the key whose
	 * two spellings caused the divergence this class closed: the deleted second
	 * hint owner printed `pageup` while the surviving one printed `pgup`.
	 */
	it("follows a remap, in the same spelling", () => {
		expect(labels({ "app.bash.background": "pageUp" })).toEqual(["esc interrupt", "pgup background"]);
	});
});

describe("a prose row names one key", () => {
	/**
	 * `app.message.followUp` is bound to two keys by default, and a sentence built
	 * from the chip reader would read `ctrl+q/ctrl+enter`, offering a choice where
	 * the row only had to name the gesture.
	 */
	it("takes the first of several bound keys", () => {
		setKeybindings(new KeybindingsManager());
		try {
			expect(keyHint(["ctrl+q", "ctrl+enter"])).toBe("ctrl+q/ctrl+enter");
			expect(primaryKeyHint("app.message.followUp")).toBe("ctrl+q");
		} finally {
			resetKeybindingsForTests();
		}
	});

	/** And nothing for an action nobody can trigger, so the caller can drop the row. */
	it("names no key when the action is unbound", () => {
		setKeybindings(new KeybindingsManager({ "app.model.cycleForward": [] }));
		try {
			expect(primaryKeyHint("app.model.cycleForward")).toBe("");
		} finally {
			resetKeybindingsForTests();
		}
	});
});
