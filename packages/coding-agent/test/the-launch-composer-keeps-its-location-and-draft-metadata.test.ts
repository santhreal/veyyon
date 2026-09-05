/**
 * WHY: a warm launch first displayed a raw worktree path without the typed draft's
 * token estimate, then replaced both after session initialization. Exercise the real
 * launch component across repository layouts, configured presets, draft transitions
 * and disabled metadata. Real PTY comparisons cover the subsequent session handoff;
 * this suite does not measure startup latency or terminal capability negotiation.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import { resetLaunchFactsForTest } from "@veyyon/coding-agent/modes/launch-facts";
import { LaunchComposerFoot } from "@veyyon/coding-agent/modes/terminal/components/composer/composer-chrome";
import { STATUS_LINE_PRESETS } from "@veyyon/coding-agent/modes/terminal/components/status-line/presets";
import type { StatusLinePreset } from "@veyyon/coding-agent/modes/terminal/components/status-line/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { getProjectDir, setProjectDir } from "@veyyon/utils/dirs";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";

let isolated: IsolatedConfigRoot;
let previousProject: string;

beforeEach(async () => {
	previousProject = getProjectDir();
	isolated = enterIsolatedConfigRoot("launch-metadata", { defaultProfile: true });
	resetSettingsForTest();
	resetLaunchFactsForTest();
	await Settings.init({ inMemory: true, cwd: isolated.root });
	await initTheme();
	await settings.set("statusLine.enabled", true);
});

afterEach(() => {
	setProjectDir(previousProject);
	resetSettingsForTest();
	resetLaunchFactsForTest();
	isolated.restore();
});

function repository(root: string): void {
	mkdirSync(path.join(root, ".git"), { recursive: true });
	writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
}

function linkedCheckout(bare: boolean): string {
	const common = path.join(isolated.root, bare ? "project.git" : "project/.git");
	const root = path.join(isolated.root, "checkouts", "task");
	const gitDir = path.join(common, "worktrees", "task");
	mkdirSync(gitDir, { recursive: true });
	mkdirSync(root, { recursive: true });
	writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
	writeFileSync(path.join(gitDir, "commondir"), `${path.relative(gitDir, common)}\n`);
	writeFileSync(path.join(root, ".git"), `gitdir: ${path.relative(root, gitDir)}\n`);
	return root;
}

function row(foot: LaunchComposerFoot, width = 400): string {
	return foot.render(width).map(stripVTControlCharacters).join("\n");
}

test.each(["linked", "nested-linked", "bare-linked"] as const)(
	"states linked-checkout identity before session startup: %s",
	async layout => {
		let cwd = linkedCheckout(layout === "bare-linked");
		if (layout === "nested-linked") {
			cwd = path.join(cwd, "src");
			mkdirSync(cwd);
		}
		setProjectDir(cwd);
		const foot = new LaunchComposerFoot(() => "qjq");
		expect(row(foot)).toContain("project/task");
		expect(row(foot)).toContain("~1 tok");
		await settings.set("git.enabled", false);
		expect(row(foot)).not.toContain("project/task");
		await settings.set("git.enabled", true);
		expect(row(foot)).toContain("project/task");
	},
);

test("refreshes the location when the launch directory changes", () => {
	setProjectDir(linkedCheckout(false));
	const foot = new LaunchComposerFoot(() => "");
	expect(row(foot)).toContain("project/task");
	const primary = path.join(isolated.root, "primary");
	repository(primary);
	setProjectDir(primary);
	expect(row(foot)).toContain("primary");
	expect(row(foot)).not.toContain("project/task");
});

test.each([0, 1, 2])("reports a parent directory with %i child repositories without guessing", count => {
	const cwd = path.join(isolated.root, "workspace");
	mkdirSync(cwd);
	for (let index = 0; index < count; index++) repository(path.join(cwd, `child-${index}`));
	setProjectDir(cwd);
	const rendered = row(new LaunchComposerFoot(() => ""));
	expect(rendered).toContain("workspace");
	if (count === 1) expect(rendered).toContain("child-0");
	else expect(rendered).not.toMatch(/child-[01]/);
});

test.each(Object.keys(STATUS_LINE_PRESETS) as StatusLinePreset[])(
	"updates draft metadata immediately under preset %s",
	async preset => {
		setProjectDir(linkedCheckout(false));
		await settings.set("statusLine.preset", preset);
		let draft = "";
		const foot = new LaunchComposerFoot(() => draft);
		for (const [text, tokens] of [
			["", null],
			["qjq", 1],
			["   \n", null],
			["/settings", null],
			["/say hi", 2],
			["ééé", 2],
			["", null],
		] as const) {
			draft = text;
			const rendered = row(foot);
			if (tokens === null) expect(rendered).not.toMatch(/~\d+ tok/);
			else expect(rendered).toContain(`~${tokens} tok`);
		}
		await settings.set("statusLine.enabled", false);
		draft = "qjq";
		for (const width of [40, 80, 140, 400]) expect(row(foot, width).trim()).toBe("");
		await settings.set("statusLine.enabled", true);
		expect(row(foot)).toContain("~1 tok");
	},
);
