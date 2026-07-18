import { describe, expect, it } from "bun:test";
import { CONFIG_ACTIONS } from "@veyyon/coding-agent/cli/config-cli";
import { PLUGIN_ACTIONS } from "@veyyon/coding-agent/cli/plugin-cli";
import { SETUP_COMPONENTS } from "@veyyon/coding-agent/cli/setup-cli";
import { SEARCH_PROVIDERS, SEARCH_RECENCY_OPTIONS } from "@veyyon/coding-agent/cli/web-search-cli";
import Config from "@veyyon/coding-agent/commands/config";
import Plugin from "@veyyon/coding-agent/commands/plugin";
import Search from "@veyyon/coding-agent/commands/web-search";

// Each command's options list must BE the canonical list from its cli module,
// not a copy. A drifted copy silently rejects supported actions at the argv
// boundary: `veyyon plugin upgrade` threw "Expected action to be one of: ..."
// while runPluginCommand handled upgrade/marketplace/discover fine.

describe("command options lists are the canonical cli-module lists", () => {
	it("plugin action options are the same array as PLUGIN_ACTIONS", () => {
		expect(Plugin.args.action.options).toBe(PLUGIN_ACTIONS);
		expect(PLUGIN_ACTIONS).toContain("upgrade");
		expect(PLUGIN_ACTIONS).toContain("marketplace");
		expect(PLUGIN_ACTIONS).toContain("discover");
	});

	it("config action options are the same array as CONFIG_ACTIONS", () => {
		expect(Config.args.action.options).toBe(CONFIG_ACTIONS);
	});

	it("search provider/recency options are the canonical lists", () => {
		expect(Search.flags.provider.options).toBe(SEARCH_PROVIDERS);
		expect(Search.flags.recency.options).toBe(SEARCH_RECENCY_OPTIONS);
	});

	it("setup component list is exported for the setup command", async () => {
		const Setup = (await import("@veyyon/coding-agent/commands/setup")).default;
		expect(Setup.args.component.options).toBe(SETUP_COMPONENTS);
	});

	it("profile, tiny-models, ssh, and agents action options are the canonical lists", async () => {
		const [{ PROFILE_ACTIONS }, { TINY_MODELS_ACTIONS }, { SSH_ACTIONS }, { AGENTS_ACTIONS }] = await Promise.all([
			import("@veyyon/coding-agent/cli/profile-cli"),
			import("@veyyon/coding-agent/cli/tiny-models-cli"),
			import("@veyyon/coding-agent/cli/ssh-cli"),
			import("@veyyon/coding-agent/cli/agents-cli"),
		]);
		const [Profile, TinyModels, SSH, Agents] = await Promise.all([
			import("@veyyon/coding-agent/commands/profile").then(m => m.default),
			import("@veyyon/coding-agent/commands/tiny-models").then(m => m.default),
			import("@veyyon/coding-agent/commands/ssh").then(m => m.default),
			import("@veyyon/coding-agent/commands/agents").then(m => m.default),
		]);
		expect(Profile.args.action.options).toBe(PROFILE_ACTIONS);
		expect(TinyModels.args.action.options).toBe(TINY_MODELS_ACTIONS);
		expect(SSH.args.action.options).toBe(SSH_ACTIONS);
		expect(Agents.args.action.options).toBe(AGENTS_ACTIONS);
	});
});
