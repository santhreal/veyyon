/**
 * WHY: the `native` provider (the profile directory), the `agents` provider (`~/.agent`) and
 * the `veyyon-plugins` provider (an extension package) each scan the same `commands/`, `rules/`,
 * `prompts/` and `tools/` layout. Each used to carry its own copy of the per-directory loader, and
 * a copy that drifted gave one surface a different name, description default or `index.ts`
 * sub-directory rule for the same file. One directory tree is pointed at all three providers here,
 * and every capability that two of them register must either produce the same items (apart from
 * the provider id) or appear on the pinned opt-out list with a reason. A new overlapping
 * capability turns the sweep red until it is classified.
 *
 * Not caught: which directories a provider chooses to scan (each provider's own suite covers
 * that), and the opted-out capabilities, whose providers read different layouts on purpose.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability, listCapabilities } from "@veyyon/coding-agent/discovery/capability";
import { clearCache } from "@veyyon/coding-agent/discovery/capability/fs";
import { promptCapability } from "@veyyon/coding-agent/discovery/capability/prompt";
import { ruleCapability } from "@veyyon/coding-agent/discovery/capability/rule";
import { slashCommandCapability } from "@veyyon/coding-agent/discovery/capability/slash-command";
import { toolCapability } from "@veyyon/coding-agent/discovery/capability/tool";
import type { LoadContext, SourceMeta } from "@veyyon/coding-agent/discovery/capability/types";
// Register all discovery providers as a side effect.
import "@veyyon/coding-agent/discovery";
import {
	clearVeyyonExtensionCliRoots,
	injectVeyyonExtensionCliRoots,
} from "@veyyon/coding-agent/discovery/veyyon-extension-roots";
import { removeSyncWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const PROVIDERS = ["native", "agents", "veyyon-plugins"] as const;

/** Capabilities whose providers scan the same sub-directory layout and must agree item for item. */
const SHARED_LAYOUT = [slashCommandCapability.id, ruleCapability.id, promptCapability.id, toolCapability.id];

/** Capabilities two of the providers register that read different layouts on purpose. */
const OPTED_OUT: Record<string, string> = {
	skills: "native reads managed-skills/, the others read skills/, and veyyon-plugins requires a description",
	hooks: "native lists hooks/<type>/ entries directly, veyyon-plugins scans them through the gitignore-aware glob",
	mcps: "native reads mcp.json from the profile, veyyon-plugins reads .mcp.json at the package root",
	"context-files": "native walks project ancestors, agents reads AGENTS.md from ~/.agent",
};

let tempDir: string;
let home: string;
let tree: string;
let settingsState: SettingsTestState | undefined;

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

beforeEach(() => {
	settingsState = beginSettingsTest();
	clearCache();
	clearVeyyonExtensionCliRoots();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-layout-"));
	home = path.join(tempDir, "home");
	// `~/.agent` is the `agents` provider's directory; the same path is the profile directory and
	// an injected extension package, so all three providers read these exact files.
	tree = path.join(home, ".agent");
	writeFile(path.join(tree, "commands", "greet.md"), "---\ndescription: greet\n---\nHello\n");
	writeFile(path.join(tree, "rules", "style.md"), '---\ndescription: style rule\nglobs: "*.ts"\n---\nUse tabs.\n');
	writeFile(path.join(tree, "rules", "legacy.mdc"), "Always.\n");
	writeFile(path.join(tree, "prompts", "review.md"), "Review this code.\n");
	writeFile(path.join(tree, "tools", "wcount.sh"), "#!/bin/sh\nwc -w\n");
	writeFile(
		path.join(tree, "tools", "counter.json"),
		JSON.stringify({ name: "json-named", description: "counts json" }),
	);
	writeFile(path.join(tree, "tools", "blank.json"), JSON.stringify({ description: "   " }));
	writeFile(path.join(tree, "tools", "broken.json"), "{ not json");
	writeFile(path.join(tree, "tools", "doc.md"), "---\nname: doc-named\ndescription: from frontmatter\n---\n");
	writeFile(path.join(tree, "tools", "deep-tool", "index.ts"), "export default {};\n");
	// A file below a layout directory belongs to whatever sits there (a tool's own module, an
	// archived rule), not to the layout: none of these is an item.
	writeFile(path.join(tree, "tools", "deep-tool", "util.ts"), "export const x = 1;\n");
	writeFile(path.join(tree, "commands", "drafts", "old.md"), "Old command.\n");
	writeFile(path.join(tree, "rules", "archive", "old.md"), "Old rule.\n");
	writeFile(path.join(tree, "prompts", "drafts", "old.md"), "Old prompt.\n");
	writeFile(path.join(tree, "tools", "no-index", "README.txt"), "not a tool\n");
	writeFile(path.join(tree, "tools", ".hidden-tool", "index.ts"), "export default {};\n");
	injectVeyyonExtensionCliRoots([tree], home, tempDir);
});

afterEach(() => {
	clearCache();
	clearVeyyonExtensionCliRoots();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	removeSyncWithRetries(tempDir);
});

function ctx(): LoadContext {
	return { cwd: tempDir, home, repoRoot: tempDir, agentDir: tree };
}

/** The provider ids among {@link PROVIDERS} that register a capability. */
function registeredProviders(capabilityId: string): string[] {
	const providers = getCapability(capabilityId)?.providers ?? [];
	return PROVIDERS.filter(id => providers.some(p => p.id === id));
}

/** Load one provider's items with the provider id dropped and a stable order. */
async function loadComparable(capabilityId: string, providerId: string): Promise<unknown[]> {
	const provider = getCapability(capabilityId)?.providers.find(p => p.id === providerId);
	if (!provider) throw new Error(`${providerId} does not register ${capabilityId}`);
	const result = await provider.load(ctx());
	const items = (result.items as Array<{ name: string; path: string; _source: SourceMeta }>).map(
		({ _source, ...item }) => ({ ...item, sourcePath: _source.path, sourceLevel: _source.level }),
	);
	return items.sort((a, b) => a.path.localeCompare(b.path));
}

test("every capability two of the providers register is classified", () => {
	const overlapping = listCapabilities()
		.filter(id => registeredProviders(id).length >= 2)
		.sort();
	expect(overlapping).toEqual([...SHARED_LAYOUT, ...Object.keys(OPTED_OUT)].sort());
});

test.each(SHARED_LAYOUT)("%s loads the same items from every provider that scans the layout", async capabilityId => {
	const [first, ...rest] = registeredProviders(capabilityId);
	expect(rest.length).toBeGreaterThan(0);
	const expected = await loadComparable(capabilityId, first);
	expect(expected.length).toBeGreaterThan(0);
	for (const providerId of rest) {
		expect({ providerId, items: await loadComparable(capabilityId, providerId) }).toEqual({
			providerId,
			items: expected,
		});
	}
});

test("the tools layout yields descriptor, script and index.ts tools with their descriptions", async () => {
	const tools = (await loadComparable(toolCapability.id, "native")) as Array<{ name: string; description: string }>;
	expect(tools.map(t => [t.name, t.description]).sort()).toEqual([
		["blank", "blank custom tool"],
		["broken", "broken custom tool"],
		["deep-tool", "deep-tool custom tool"],
		["doc-named", "from frontmatter"],
		["json-named", "counts json"],
		["wcount", "wcount custom tool"],
	]);
});

test("the markdown layouts name commands, rules and prompts for their file", async () => {
	const names = async (capabilityId: string) =>
		((await loadComparable(capabilityId, "native")) as Array<{ name: string }>).map(i => i.name).sort();
	expect(await names(slashCommandCapability.id)).toEqual(["greet"]);
	expect(await names(ruleCapability.id)).toEqual(["legacy", "style"]);
	expect(await names(promptCapability.id)).toEqual(["review"]);
});
