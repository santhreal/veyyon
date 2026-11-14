/**
 * WHY. A permission prompt draws the model's own text: a command, a path, and the tool's
 * `Label: value` details. A write's details carry the file content, and a heredoc command spans
 * lines. A newline that reaches a rendered row splits one row into two terminal lines, so the
 * renderer's frame no longer matches the screen: rows repeat, the control draws twice, and stale
 * transcript text stays behind.
 *
 * THE CLASS THIS CLOSES. Every row the mounted permission surface returns, for every card shape
 * below, at every width, in every selection state reachable by the navigation keys, is one
 * terminal line no wider than the width it was given. The surface is reached through
 * `createPermissionSurface`, so whichever prompt the surface mounts is the one under test.
 *
 * WHAT IT DOES NOT CATCH. Frames mid-animation (motion is off here, so every part is settled),
 * the exit fold, and how the rows look.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ApprovalCard } from "@veyyon/coding-agent/extensibility/extensions";
import { createPermissionSurface } from "@veyyon/coding-agent/modes/terminal/components/permission/surface";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { TUI } from "@veyyon/tui";
import { setKeybindings } from "@veyyon/utils/keybindings";
import { visibleWidth } from "@veyyon/utils/width";
import { VirtualTerminal } from "../../../../../../../hosts/terminal/engine/test/virtual-terminal";
import {
	beginSettingsTest,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../../../../helpers/settings-test-state";

const CHOICES = {
	approveOnce: "Allow once",
	approvePattern: "Allow pattern",
	approveSession: "Allow for session",
	denyOnce: "Deny",
	denySession: "Deny for session",
};

const CARDS: Record<string, ApprovalCard> = {
	heredoc: {
		toolName: "bash",
		args: { command: "cat > notes.md <<'EOF'\n# Notes\n\nline\twith tab\nEOF\nwc -l notes.md" },
		details: ["Command: cat > notes.md <<'EOF'\n# Notes\nEOF", "Timeout: 30s"],
		reasons: [{ kind: "policy", text: "Approval mode asks\nbefore every command." }],
		cwd: "/repo",
		mode: "ask-command",
		pattern: "cat *",
		choices: CHOICES,
	},
	writeContent: {
		toolName: "write",
		args: { path: "../shared/notes/migration.md", content: "# Migration\n\nExport moved.\n" },
		details: ["Path: ../shared/notes/migration.md", "Content: # Migration\n\nExport moved.\n"],
		reasons: [{ kind: "boundary", text: "Path is outside the session working directory (/repo)" }],
		cwd: "/repo",
		mode: "ask-command",
		choices: { approveOnce: CHOICES.approveOnce, denyOnce: CHOICES.denyOnce, denySession: CHOICES.denySession },
	},
	critical: {
		toolName: "bash",
		requester: "Worker\nTwo",
		args: { command: "sudo rm -rf /var/lib/app/cache\nrm -rf /var/lib/app/state" },
		details: [],
		reasons: [
			{ kind: "critical", text: "Deletes files as root" },
			{ kind: "secret", text: "Spends\r\na credential" },
		],
		cwd: "/repo",
		mode: "ask-command",
		choices: { approveOnce: CHOICES.approveOnce, denyOnce: CHOICES.denyOnce, denySession: CHOICES.denySession },
	},
	unknownTool: {
		toolName: "custom_tool",
		args: { anything: 1 },
		details: ["Query: first line\nsecond line", "Mode: a\nb"],
		reasons: [],
		cwd: "/repo",
		mode: "ask-all",
		choices: CHOICES,
	},
	longCommand: {
		toolName: "bash",
		args: { command: `find src -name '*.ts' | xargs grep -l "${"x".repeat(400)}" | sort | uniq -c` },
		details: [],
		reasons: [],
		cwd: "/repo",
		mode: "ask-command",
		pattern: "find *",
		choices: CHOICES,
	},
};

const OPTIONS = Object.values(CHOICES).map(label => ({ label }));
const WIDTHS = [32, 60, 80, 120, 200];
/** Right, down and tab: each prompt moves its selection with some of these and ignores the rest. */
const NAVIGATION = ["\x1b[C", "\x1b[B", "\t"];

let settingsState: SettingsTestState | undefined;
beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
	setKeybindings(KeybindingsManager.inMemory());
});

afterEach(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

describe("a permission prompt", () => {
	for (const [name, card] of Object.entries(CARDS)) {
		it(`draws every row of a ${name} call as one terminal line within the width`, () => {
			const tui = new TUI(new VirtualTerminal(120, 40));
			const offered = OPTIONS.filter(o => Object.values(card.choices).includes(o.label));
			const surface = createPermissionSurface(card, {
				tui,
				title: `${card.toolName} wants to run`,
				options: offered,
				settle: () => {},
				requestRender: () => {},
			});
			try {
				const broken: string[] = [];
				const check = (state: string) => {
					for (const width of WIDTHS) {
						for (const [row, line] of surface.component.render(width).entries()) {
							if (/[\n\r]/.test(line)) broken.push(`${state} @${width} row ${row}: contains a line break`);
							const shown = visibleWidth(line);
							if (shown > width) broken.push(`${state} @${width} row ${row}: ${shown} columns`);
						}
					}
				};
				check("initial");
				for (const key of NAVIGATION) {
					for (let press = 0; press < offered.length; press++) {
						surface.component.handleInput?.(key);
						check(`${JSON.stringify(key)} x${press + 1}`);
					}
				}
				expect(broken).toEqual([]);
			} finally {
				surface.component.dispose?.();
			}
		});
	}
});
