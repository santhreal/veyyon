/**
 * A session rooted in a NON-ACTIVE agent dir must get THAT profile's layers, and
 * the active profile's equivalents must be ABSENT.
 *
 * Four layers reach a session from an agent dir, and each one regresses
 * independently because each is a different provider reading a different
 * directory:
 *
 *   1. context files      `<agentDir>/AGENTS.md`
 *   2. authored skills    `<agentDir>/skills`
 *   3. managed skills     `<agentDir>/managed-skills`
 *   4. plugin skills      `<agentDir>/settings.json#extensions`
 *   5. marketplace config `<profile root>/plugins/installed_plugins.json`
 *
 * Every one of them used to resolve the process-global `getAgentDir()`, so an
 * agent asked to run as profile B silently ran on profile A's instructions,
 * skills and plugins. Nothing threw and nothing warned, which is why this is
 * pinned per layer rather than once: threading the value into three of the five
 * and calling it done is exactly the shape that shipped.
 *
 * Two profiles under ONE isolated home is the fixture, because that is the only
 * arrangement in which "the active profile's equivalent is absent" is a real
 * claim. Both profiles carry a file at the same relative path with different
 * bytes, and every assertion is an EXACT set or an exact path: a leak of the
 * active profile's layer fails as loudly as a miss of the named profile's.
 *
 * The isolated home also matters for correctness of the suite itself. The
 * marketplace registry and the plugin roots resolve from `os.homedir()`, so
 * without the fixture's `homedir` spy these cases would read the developer's real
 * `~/.veyyon` and `~/.claude`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	captureRegistryForTests,
	initializeWithSettings,
	type RegistrySnapshot,
	restoreRegistryForTests,
} from "@veyyon/coding-agent/capability";
import type { Rule } from "@veyyon/coding-agent/capability/rule";
import { type SlashCommand, slashCommandCapability } from "@veyyon/coding-agent/capability/slash-command";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { loadCapability } from "@veyyon/coding-agent/discovery";
import { PROFILE_AGENTS_GUIDANCE } from "@veyyon/coding-agent/discovery/agents-guidance";
import { clearClaudePluginRootsCache } from "@veyyon/coding-agent/discovery/helpers";
import { discoverCustomToolPaths } from "@veyyon/coding-agent/extensibility/custom-tools";
import { discoverExtensionPaths } from "@veyyon/coding-agent/extensibility/extensions";
import { discoverAndLoadHooks } from "@veyyon/coding-agent/extensibility/hooks";
import { loadSkills } from "@veyyon/coding-agent/extensibility/skills";
import { loadSlashCommands } from "@veyyon/coding-agent/extensibility/slash-commands";
import { loadAllMCPConfigs } from "@veyyon/coding-agent/mcp/config";
import { discoverContextFiles, discoverRules, discoverSkills } from "@veyyon/coding-agent/sdk";
import { buildSystemPrompt, loadProjectContextFiles } from "@veyyon/coding-agent/system-prompt";
import { discoverCommands } from "@veyyon/coding-agent/task/commands";
import { discoverAgents } from "@veyyon/coding-agent/task/discovery";
import {
	GLOBAL_BODY,
	PROFILE_BODY,
	PROJECT_NESTED_BODY,
	PROJECT_ROOT_BODY,
	useContextScopeFixture,
} from "./helpers/context-scope-fixture";

const fixture = useContextScopeFixture("two-profile-layers-");

/** Marker bytes for the profile that is NOT the one the caller names. */
const ACTIVE_MARKER = "Marker: ACTIVE-PROFILE-BYTES-91c2.\n";
/** Marker bytes for the profile the caller names. */
const NAMED_MARKER = "Marker: NAMED-PROFILE-BYTES-6ea7.\n";

describe("a non-active agent dir gets its own layers, not the booted profile's", () => {
	/**
	 * LAYER 1, context files.
	 *
	 * `discoverContextFiles(cwd, agentDir)` declared the agent dir and dropped it,
	 * and the native provider it delegates to called
	 * `getProfileAgentsCandidates()` with no argument. Both had to be fixed: with
	 * only the first, the provider still returned the active profile's file and the
	 * loader had to filter it back out, which cost a scope of its own (see the
	 * `user`-slot note in loadProjectContextFilesWithWarnings).
	 */
	test("loads the named profile's AGENTS.md and none of the active profile's", async () => {
		const f = fixture("layer-active");
		const namedAgentDir = f.agentDirFor("layer-named");
		f.writeFile(f.profileAgentsPath, ACTIVE_MARKER);
		const namedAgentsPath = f.writeFile(path.join(namedAgentDir, "AGENTS.md"), NAMED_MARKER);

		const files = await loadProjectContextFiles({ cwd: f.cwd, agentDir: namedAgentDir });
		f.resetCaches();
		const viaSdk = await discoverContextFiles(f.cwd, namedAgentDir);

		expect(files).toEqual([{ path: namedAgentsPath, content: NAMED_MARKER, depth: undefined }]);
		expect(viaSdk).toEqual(files);
	});

	/**
	 * The two AXES, asserted together because they were conflated once already.
	 *
	 * RESOLUTION order is global, then profile, then the project walk: that is the
	 * order the loader reads the disk in. PROMINENCE is the order of the returned
	 * array, least prominent first so a later entry overrides an earlier one:
	 * global, then project by DESCENDING depth, then profile last and therefore
	 * winning. Profile outranks project on purpose, so a user's standing rules are
	 * not outranked by whatever repository is checked out.
	 *
	 * Sorting by resolution order instead would put the profile file second, where
	 * the repository's own AGENTS.md would override it, and no test asserting mere
	 * membership would notice.
	 */
	test("orders global, then project by descending depth, then the NAMED profile last", async () => {
		const f = fixture("axes-active");
		const namedAgentDir = f.agentDirFor("axes-named");
		f.writeFile(f.globalAgentsPath, `${GLOBAL_BODY}\n`);
		f.writeFile(f.profileAgentsPath, `${PROFILE_BODY}\n`);
		const namedAgentsPath = f.writeFile(path.join(namedAgentDir, "AGENTS.md"), NAMED_MARKER);
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);
		f.writeFile(f.nestedAgentsPath, `${PROJECT_NESTED_BODY}\n`);

		const files = await loadProjectContextFiles({ cwd: f.cwd, agentDir: namedAgentDir });

		expect(files).toEqual([
			{ path: f.globalAgentsPath, content: `${GLOBAL_BODY}\n`, depth: undefined },
			{ path: f.rootAgentsPath, content: `${PROJECT_ROOT_BODY}\n`, depth: 1 },
			{ path: f.nestedAgentsPath, content: `${PROJECT_NESTED_BODY}\n`, depth: 0 },
			{ path: namedAgentsPath, content: NAMED_MARKER, depth: undefined },
		]);
	});

	/**
	 * Exactly ONE profile file, ever. The ladder
	 * (`<agentDir>/AGENTS.md`, `<profile root>/AGENTS.md`, then the `agent.md`
	 * spellings) stops at its first hit, and the ladder walked is the NAMED
	 * profile's. Two profile files in one prompt would put two users' standing
	 * rules in force at once, with the loser silently outranked.
	 */
	test("returns one profile file even when both profiles have every ladder rung", async () => {
		const f = fixture("ladder-active");
		const namedAgentDir = f.agentDirFor("ladder-named");
		f.writeFile(f.profileAgentsPath, ACTIVE_MARKER);
		f.writeFile(path.join(path.dirname(f.agentDir), "AGENTS.md"), ACTIVE_MARKER);
		const namedAgentsPath = f.writeFile(path.join(namedAgentDir, "AGENTS.md"), NAMED_MARKER);
		f.writeFile(path.join(path.dirname(namedAgentDir), "AGENTS.md"), "Marker: NAMED-PROFILE-ROOT-b30f.\n");

		const files = await loadProjectContextFiles({ cwd: f.cwd, agentDir: namedAgentDir });

		expect(files).toEqual([{ path: namedAgentsPath, content: NAMED_MARKER, depth: undefined }]);
	});

	/**
	 * LAYER 2, authored skills, `<agentDir>/skills`.
	 *
	 * A skill is instructions the agent will follow, so serving the wrong
	 * profile's skill set is not a cosmetic mismatch: it is running another
	 * user's playbook on this user's repository.
	 */
	test("loads the named profile's authored skills and none of the active profile's", async () => {
		const f = fixture("skills-active");
		const namedAgentDir = f.agentDirFor("skills-named");
		writeSkill(f, f.agentDir, "skills", "active-authored");
		const namedSkill = writeSkill(f, namedAgentDir, "skills", "named-authored");

		const { skills } = await discoverSkills(f.cwd, namedAgentDir);

		expect(skills.map(skill => skill.name)).toEqual(["named-authored"]);
		expect(skills[0].filePath).toBe(namedSkill);
	});

	/**
	 * LAYER 3, auto-learn managed skills, `<agentDir>/managed-skills`.
	 *
	 * A separate provider from layer 2, so it regresses separately. These are the
	 * skills veyyon wrote about the user's own work, which makes cross-profile
	 * bleed a privacy problem as well as a correctness one.
	 */
	test("loads the named profile's managed skills and none of the active profile's", async () => {
		const f = fixture("managed-active");
		const namedAgentDir = f.agentDirFor("managed-named");
		writeSkill(f, f.agentDir, "managed-skills", "active-managed");
		const namedSkill = writeSkill(f, namedAgentDir, "managed-skills", "named-managed");

		const { skills } = await loadSkills({ cwd: f.cwd, agentDir: namedAgentDir });

		expect(skills.map(skill => skill.name)).toEqual(["named-managed"]);
		expect(skills[0].filePath).toBe(namedSkill);
	});

	/**
	 * LAYER 4, skills shipped by plugin packages the profile configured in its own
	 * `settings.json#extensions`.
	 *
	 * The third skill provider and the last one threaded. Its roots come from the
	 * profile's settings file plus that profile's installed plugins, so both
	 * halves used to follow the booted profile.
	 */
	test("loads the named profile's plugin-shipped skills and none of the active profile's", async () => {
		const f = fixture("plugins-active");
		const namedAgentDir = f.agentDirFor("plugins-named");
		const activePackage = writePluginPackage(f, path.join(f.home, "active-pkg"), "active-plugin-skill");
		const namedPackage = writePluginPackage(f, path.join(f.home, "named-pkg"), "named-plugin-skill");
		f.writeFile(path.join(f.agentDir, "settings.json"), JSON.stringify({ extensions: [activePackage] }));
		f.writeFile(path.join(namedAgentDir, "settings.json"), JSON.stringify({ extensions: [namedPackage] }));

		const defaulted = await loadSkills({ cwd: f.cwd });
		f.resetCaches();
		const named = await loadSkills({ cwd: f.cwd, agentDir: namedAgentDir });

		// The defaulted call is the control: without it, a loader that returned
		// nothing for both profiles would satisfy "the active one is absent".
		expect(defaulted.skills.map(skill => skill.name)).toEqual(["active-plugin-skill"]);
		expect(named.skills.map(skill => skill.name)).toEqual(["named-plugin-skill"]);
	});

	/**
	 * The rendered prompt, not just the loader's return value.
	 *
	 * The suite that was supposed to cover this asserted the rendered CONFIGURATION
	 * PATHS and never a byte of file content, so it stayed green while AGENTS.md
	 * loading was completely dead. This drives the real `buildSystemPrompt` seam and
	 * asserts the NAMED profile's bytes are in the prompt text and the active
	 * profile's are not.
	 */
	test("the named profile's instructions reach the rendered prompt and the active profile's do not", async () => {
		const f = fixture("render-active");
		const namedAgentDir = f.agentDirFor("render-named");
		f.writeFile(f.profileAgentsPath, ACTIVE_MARKER);
		f.writeFile(path.join(namedAgentDir, "AGENTS.md"), NAMED_MARKER);

		const { systemPrompt } = await buildSystemPrompt({ cwd: f.cwd, agentDir: namedAgentDir });
		const rendered = systemPrompt.join("\n");

		expect(rendered).toContain(NAMED_MARKER.trim());
		expect(rendered).not.toContain(ACTIVE_MARKER.trim());
	});

	/**
	 * Startup back-fill follows the same agent dir.
	 *
	 * A profile with no instruction file gets one seeded so the operator has a
	 * persistent, update-proof file to edit. That seeding was hardwired to the
	 * ACTIVE profile, so building a prompt for another agent dir wrote the file into
	 * the profile that was NOT being used and left the one in use with nothing: the
	 * exact gap the back-fill exists to close.
	 */
	test("seeds the NAMED profile's AGENTS.md, not the active profile's", async () => {
		const f = fixture("seed-active");
		const namedAgentDir = f.agentDirFor("seed-named");
		f.writeFile(path.join(namedAgentDir, "settings.json"), "{}");

		await buildSystemPrompt({ cwd: f.cwd, agentDir: namedAgentDir });

		expect(fs.readFileSync(path.join(namedAgentDir, "AGENTS.md"), "utf8")).toBe(PROFILE_AGENTS_GUIDANCE);
		expect(fs.existsSync(f.profileAgentsPath)).toBe(false);
	});

	/**
	 * The agentConfiguration rows the prompt hands the model, which are how the
	 * model learns WHERE to write when the operator says "remember this".
	 *
	 * The block was half-converted: "Agent directory" and "Skills directory" came
	 * from the resolved agent dir, while "Active profile" and "Profile AGENTS.md"
	 * came from the process-booted profile. So a session rooted in another agent
	 * dir was told to edit a Profile AGENTS.md that was NOT the file whose bytes it
	 * had just been given, and a model asked to update the operator's standing
	 * rules wrote them into the wrong profile. All four rows must name the one dir
	 * the instructions actually came from.
	 */
	test("every agentConfiguration row names the NAMED profile, not the booted one", async () => {
		const f = fixture("rows-active");
		const namedAgentDir = f.agentDirFor("rows-named");
		f.writeFile(path.join(namedAgentDir, "AGENTS.md"), NAMED_MARKER);

		const { systemPrompt } = await buildSystemPrompt({ cwd: f.cwd, agentDir: namedAgentDir });
		const rendered = systemPrompt.join("\n");

		expect(rendered).toContain("Active profile: rows-named");
		expect(rendered).toContain(`Agent directory: ${namedAgentDir}`);
		expect(rendered).toContain(`Skills directory: ${path.join(namedAgentDir, "skills")}`);
		expect(rendered).toContain(`Profile AGENTS.md: ${path.join(namedAgentDir, "AGENTS.md")}`);
		expect(rendered).not.toContain("Active profile: rows-active");
		expect(rendered).not.toContain(f.agentDir);
	});

	/**
	 * Agent definitions shipped by an extension PACKAGE the profile declared in its own
	 * `settings.json#extensions`, and the profile's own `<agentDir>/agents` dir. Two more
	 * sources feeding the same `discoverAgents` surface as the marketplace case below, and
	 * each one resolved the process-active profile independently of the others, so fixing
	 * the marketplace read alone would still have handed a spawned agent the wrong
	 * definition through either of these.
	 */
	test("discoverAgents follows the named profile for its extensions and its own agents dir", async () => {
		const f = fixture("agentdirs-active");
		const namedAgentDir = f.agentDirFor("agentdirs-named");
		const activePackage = path.join(f.home, "active-agent-pkg");
		const namedPackage = path.join(f.home, "named-agent-pkg");
		writeAgentDefinition(f, path.join(activePackage, "agents"), "active-ext-agent");
		writeAgentDefinition(f, path.join(namedPackage, "agents"), "named-ext-agent");
		f.writeFile(path.join(f.agentDir, "settings.json"), JSON.stringify({ extensions: [activePackage] }));
		f.writeFile(path.join(namedAgentDir, "settings.json"), JSON.stringify({ extensions: [namedPackage] }));
		writeAgentDefinition(f, path.join(f.agentDir, "agents"), "active-user-agent");
		writeAgentDefinition(f, path.join(namedAgentDir, "agents"), "named-user-agent");

		const defaulted = await discoverAgents(f.cwd, f.home);
		f.resetCaches();
		const named = await discoverAgents(f.cwd, f.home, namedAgentDir);

		const own = (result: Awaited<ReturnType<typeof discoverAgents>>): string[] =>
			result.agents.map(agent => agent.name).filter(name => name.endsWith("-agent"));
		expect(own(defaulted).toSorted()).toEqual(["active-ext-agent", "active-user-agent"]);
		expect(own(named).toSorted()).toEqual(["named-ext-agent", "named-user-agent"]);
	});

	/** All four layers at once, so no single fix can be credited for another's. */
	test("all four layers follow the named profile in one load", async () => {
		const f = fixture("all-active");
		const namedAgentDir = f.agentDirFor("all-named");
		f.writeFile(f.profileAgentsPath, ACTIVE_MARKER);
		const namedAgentsPath = f.writeFile(path.join(namedAgentDir, "AGENTS.md"), NAMED_MARKER);
		writeSkill(f, f.agentDir, "skills", "active-authored");
		writeSkill(f, f.agentDir, "managed-skills", "active-managed");
		writeSkill(f, namedAgentDir, "skills", "named-authored");
		writeSkill(f, namedAgentDir, "managed-skills", "named-managed");
		const activePackage = writePluginPackage(f, path.join(f.home, "all-active-pkg"), "active-plugin-skill");
		const namedPackage = writePluginPackage(f, path.join(f.home, "all-named-pkg"), "named-plugin-skill");
		f.writeFile(path.join(f.agentDir, "settings.json"), JSON.stringify({ extensions: [activePackage] }));
		f.writeFile(path.join(namedAgentDir, "settings.json"), JSON.stringify({ extensions: [namedPackage] }));

		const files = await discoverContextFiles(f.cwd, namedAgentDir);
		const { skills } = await discoverSkills(f.cwd, namedAgentDir);

		expect(files).toEqual([{ path: namedAgentsPath, content: NAMED_MARKER, depth: undefined }]);
		expect(skills.map(skill => skill.name)).toEqual(["named-authored", "named-managed", "named-plugin-skill"]);
	});
});

/**
 * LAYER 5, the Claude-marketplace registry, which is profile-scoped through
 * `<profile root>/plugins/installed_plugins.json`.
 *
 * This layer ships no skills (the marketplace provider is not in the profile
 * skill allowlist), so it needs its own suite driving a capability it DOES
 * contribute: slash commands. It is gated behind `discovery.importForeignConfig`,
 * off by default, which is why the leak survived so long. With the gate open, a
 * session rooted in profile B used to get profile A's marketplace commands,
 * hooks, tools and MCP servers.
 */
describe("marketplace plugin roots follow the named profile's plugins dir", () => {
	let registry: RegistrySnapshot | undefined;

	beforeEach(() => {
		registry = captureRegistryForTests();
		// The marketplace provider is foreign config, off by default.
		initializeWithSettings(Settings.isolated({ "discovery.importForeignConfig": true }));
		clearClaudePluginRootsCache();
	});

	afterEach(() => {
		clearClaudePluginRootsCache();
		if (registry) restoreRegistryForTests(registry);
		registry = undefined;
	});

	/**
	 * AGENT DEFINITIONS, the highest-severity item on this layer. A definition carries a
	 * system prompt and a tool list, so reading another profile's marketplace does not
	 * merely add a name to `/agents`: it changes what a spawned agent IS and what it is
	 * permitted to do. `discoverAgents` resolved all three of its profile-scoped sources
	 * (the user `agents/` dir, the profile's `extensions:` packages, and the profile's
	 * marketplace registry) from the process-active profile.
	 */
	test("discoverAgents loads the named profile's plugin agents and none of the active profile's", async () => {
		const f = fixture("agents-active");
		const namedAgentDir = f.agentDirFor("agents-named");
		installMarketplacePluginAgent(f, f.agentDir, "active-plugin", "active-agent");
		installMarketplacePluginAgent(f, namedAgentDir, "named-plugin", "named-agent");
		clearClaudePluginRootsCache();
		f.resetCaches();

		const defaulted = await discoverAgents(f.cwd, f.home);
		clearClaudePluginRootsCache();
		f.resetCaches();
		const named = await discoverAgents(f.cwd, f.home, namedAgentDir);

		const pluginAgents = (result: Awaited<ReturnType<typeof discoverAgents>>): string[] =>
			result.agents.map(agent => agent.name).filter(name => name.endsWith("-agent"));
		expect(pluginAgents(defaulted)).toEqual(["active-agent"]);
		expect(pluginAgents(named)).toEqual(["named-agent"]);
	});

	test("loads the named profile's marketplace commands and none of the active profile's", async () => {
		const f = fixture("marketplace-active");
		const namedAgentDir = f.agentDirFor("marketplace-named");
		installMarketplacePlugin(f, f.agentDir, "active-plugin", "active-command");
		installMarketplacePlugin(f, namedAgentDir, "named-plugin", "named-command");
		clearClaudePluginRootsCache();
		f.resetCaches();

		const defaulted = await loadCapability<SlashCommand>(slashCommandCapability.id, { cwd: f.cwd });
		clearClaudePluginRootsCache();
		f.resetCaches();
		const named = await loadCapability<SlashCommand>(slashCommandCapability.id, {
			cwd: f.cwd,
			agentDir: namedAgentDir,
		});

		// The defaulted load is the control: it proves the active profile's registry
		// is readable and reachable, so "absent" below is isolation and not an
		// unreadable fixture.
		expect(defaulted.items.map(item => item.name)).toEqual(["active-plugin:active-command"]);
		expect(named.items.map(item => item.name)).toEqual(["named-plugin:named-command"]);
	});
});

/**
 * LAYERS 6-10, the ones a caller reaches through a LOADER FUNCTION rather than
 * `loadCapability` directly: rules, slash commands, workflow commands, custom
 * tools, hooks and MCP servers.
 *
 * The providers behind these already read `ctx.agentDir`. The callers did not
 * pass one, and `loadCapability` fills the gap with the process-active profile,
 * so every one of them silently resolved the BOOTED profile while the same
 * session's context files, skills and prompt templates resolved the profile it
 * was rooted in. Nothing threw: a session simply ran with one profile's
 * instructions and another profile's rules, commands, tools and MCP servers.
 *
 * Each case drives the loader the session actually calls, not the capability
 * layer underneath it, because the capability layer was never the broken half.
 * Each is two-directional: the named profile's item is present AND the active
 * profile's is absent, with a defaulted control load proving the active
 * profile's fixture is readable in the first place.
 */
describe("loader-level layers follow the named profile, not the booted one", () => {
	/**
	 * RULES, both shapes the native provider serves: `<agentDir>/rules/*.md` and
	 * the sticky `<agentDir>/RULES.md`, which is re-injected every turn. Serving
	 * the booted profile's RULES.md means every turn of the session carries
	 * standing instructions the operator wrote for a different profile.
	 */
	test("discoverRules loads the named profile's rules and RULES.md and none of the active profile's", async () => {
		const f = fixture("rules-active");
		const namedAgentDir = f.agentDirFor("rules-named");
		f.writeFile(path.join(f.agentDir, "rules", "active-rule.md"), "Active rule body.\n");
		f.writeFile(path.join(f.agentDir, "RULES.md"), ACTIVE_MARKER);
		f.writeFile(path.join(namedAgentDir, "rules", "named-rule.md"), "Named rule body.\n");
		f.writeFile(path.join(namedAgentDir, "RULES.md"), NAMED_MARKER);

		const defaulted = await discoverRules(f.cwd);
		f.resetCaches();
		const named = await discoverRules(f.cwd, namedAgentDir);

		expect(agentDirRuleNames(defaulted.items, f.agentDir).toSorted()).toEqual(["RULES", "active-rule"]);
		expect(agentDirRuleNames(defaulted.items, namedAgentDir)).toEqual([]);
		expect(agentDirRuleNames(named.items, namedAgentDir).toSorted()).toEqual(["RULES", "named-rule"]);
		expect(agentDirRuleNames(named.items, f.agentDir)).toEqual([]);
		expect(stickyBody(defaulted.items)).toContain(ACTIVE_MARKER.trim());
		expect(stickyBody(named.items)).toContain(NAMED_MARKER.trim());
	});

	/**
	 * SLASH COMMANDS through `loadSlashCommands`, the loader every mode calls.
	 * A slash command is a prompt the operator authored, so the booted profile's
	 * `/deploy` running in a session rooted elsewhere sends the wrong
	 * instructions to the model under a name the operator trusts.
	 */
	test("loadSlashCommands loads the named profile's commands and none of the active profile's", async () => {
		const f = fixture("commands-active");
		const namedAgentDir = f.agentDirFor("commands-named");
		f.writeFile(path.join(f.agentDir, "commands", "active-cmd.md"), "Run the active command.\n");
		f.writeFile(path.join(namedAgentDir, "commands", "named-cmd.md"), "Run the named command.\n");

		const defaulted = await loadSlashCommands({ cwd: f.cwd });
		f.resetCaches();
		const named = await loadSlashCommands({ cwd: f.cwd, agentDir: namedAgentDir });

		expect(authored(defaulted.map(cmd => cmd.name))).toEqual(["active-cmd"]);
		expect(authored(named.map(cmd => cmd.name))).toEqual(["named-cmd"]);
	});

	/**
	 * The same command files through `discoverCommands`, the workflow-command
	 * surface. A separate loader over the same capability, so it regresses
	 * separately, and it returns the command BODY, which is what actually
	 * reaches the model.
	 */
	test("discoverCommands loads the named profile's command bodies and none of the active profile's", async () => {
		const f = fixture("workflow-active");
		const namedAgentDir = f.agentDirFor("workflow-named");
		f.writeFile(path.join(f.agentDir, "commands", "shared-cmd.md"), ACTIVE_MARKER);
		f.writeFile(path.join(namedAgentDir, "commands", "shared-cmd.md"), NAMED_MARKER);

		const defaulted = await discoverCommands(f.cwd);
		f.resetCaches();
		const named = await discoverCommands(f.cwd, namedAgentDir);

		// One NAME under both profiles on purpose: a name-only assertion would pass
		// while the wrong profile's body was served.
		expect(defaulted.find(cmd => cmd.name === "shared-cmd")?.instructions.trim()).toBe(ACTIVE_MARKER.trim());
		expect(named.find(cmd => cmd.name === "shared-cmd")?.instructions.trim()).toBe(NAMED_MARKER.trim());
	});

	/**
	 * CUSTOM TOOLS. The highest-severity layer here: a custom tool is executable
	 * code the agent may call, so resolving another profile's `tools/` directory
	 * runs a stranger's code against this operator's repository.
	 */
	test("discoverCustomToolPaths collects the named profile's tools and none of the active profile's", async () => {
		const f = fixture("tools-active");
		const namedAgentDir = f.agentDirFor("tools-named");
		const activeTool = f.writeFile(path.join(f.agentDir, "tools", "active-tool.ts"), "export default {};\n");
		const namedTool = f.writeFile(path.join(namedAgentDir, "tools", "named-tool.ts"), "export default {};\n");

		const defaulted = await discoverCustomToolPaths([], f.cwd);
		f.resetCaches();
		const named = await discoverCustomToolPaths([], f.cwd, namedAgentDir);

		expect(defaulted.map(entry => entry.path)).toEqual([activeTool]);
		expect(named.map(entry => entry.path)).toEqual([namedTool]);
	});

	/**
	 * HOOKS, which run on every tool call, so the wrong profile's hook can block
	 * or rewrite this session's tool traffic. Asserted on the LOADED hooks rather
	 * than the discovered paths, so a hook that resolves but fails to import
	 * cannot read as success.
	 */
	test("discoverAndLoadHooks loads the named profile's hooks and none of the active profile's", async () => {
		const f = fixture("hooks-active");
		const namedAgentDir = f.agentDirFor("hooks-named");
		const activeHook = writeHook(f, f.agentDir, "active-hook");
		const namedHook = writeHook(f, namedAgentDir, "named-hook");

		const defaulted = await discoverAndLoadHooks([], f.cwd);
		f.resetCaches();
		const named = await discoverAndLoadHooks([], f.cwd, namedAgentDir);

		expect(defaulted.errors).toEqual([]);
		expect(named.errors).toEqual([]);
		expect(defaulted.hooks.map(hook => hook.resolvedPath)).toEqual([activeHook]);
		expect(named.hooks.map(hook => hook.resolvedPath)).toEqual([namedHook]);
	});

	/**
	 * HOOKS AGAIN, through the path the APP actually runs.
	 *
	 * `discoverAndLoadHooks` above is a public package export with no in-repo
	 * caller. The production consumer is `discoverExtensionPaths`, whose own
	 * comment calls itself "the only production consumer of the capability": it
	 * loads `hookCapability` and binds the JS/TS ones through the extension
	 * runner. It also loads `extensionModuleCapability` in the same call, a
	 * profile-scoped layer that was on nobody's list.
	 *
	 * Both loads shared one `loadOptions` that carried `cwd` and never an agent
	 * dir, so both fell back to `getAgentDir()` and served the BOOTED profile.
	 * The threading had landed on the function nothing calls and missed the one
	 * that runs, which is why every layer-scope test above could pass while a
	 * session rooted in another profile still ran the active profile's hooks.
	 */
	test("discoverExtensionPaths collects the named profile's hooks and extensions, not the active profile's", async () => {
		const f = fixture("ext-active");
		const namedAgentDir = f.agentDirFor("ext-named");
		const activeHook = writeHook(f, f.agentDir, "active-ext-hook");
		const namedHook = writeHook(f, namedAgentDir, "named-ext-hook");
		const activeExtension = f.writeFile(
			path.join(f.agentDir, "extensions", "active-ext.ts"),
			"export default () => {};\n",
		);
		const namedExtension = f.writeFile(
			path.join(namedAgentDir, "extensions", "named-ext.ts"),
			"export default () => {};\n",
		);

		const defaulted = await discoverExtensionPaths([], f.cwd);
		f.resetCaches();
		const named = await discoverExtensionPaths([], f.cwd, undefined, namedAgentDir);

		// Sorted because the two capabilities are loaded in sequence and the
		// assertion is about WHICH profile answered, not the order it answered in.
		expect([...defaulted].sort()).toEqual([activeExtension, activeHook].sort());
		expect([...named].sort()).toEqual([namedExtension, namedHook].sort());
	});

	/**
	 * MCP SERVERS, and the disable list that governs them. Both live in the same
	 * `<agentDir>/mcp.json`, so they are asserted together: scoping only the
	 * server list would apply profile A's disable list to profile B's servers and
	 * quietly resurrect a server the operator turned off.
	 */
	test("loadAllMCPConfigs loads the named profile's servers and honors its own disable list", async () => {
		const f = fixture("mcp-active");
		const namedAgentDir = f.agentDirFor("mcp-named");
		f.writeFile(
			path.join(f.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { "active-server": { command: "active-bin" } } }),
		);
		f.writeFile(
			path.join(namedAgentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"named-server": { command: "named-bin" },
					"named-off": { command: "off-bin" },
				},
				disabledServers: ["named-off"],
			}),
		);

		const defaulted = await loadAllMCPConfigs(f.cwd);
		f.resetCaches();
		const named = await loadAllMCPConfigs(f.cwd, { agentDir: namedAgentDir });

		expect(Object.keys(defaulted.configs).toSorted()).toEqual(["active-server"]);
		expect(Object.keys(named.configs).toSorted()).toEqual(["named-server"]);
		// The SOURCE path, not just the name: it pins which profile's mcp.json the
		// surviving server actually came out of.
		expect(named.sources["named-server"].path).toBe(path.join(namedAgentDir, "mcp.json"));
	});
});

/**
 * Rule names contributed by a profile's own agent dir on disk. The builtin
 * defaults provider also reports `level: "user"` and ships 28 rules, so level
 * alone does not separate "the operator wrote this" from "the binary shipped
 * this"; the source PATH does, and it is the thing that has to move per profile.
 */
function agentDirRuleNames(rules: Rule[], agentDir: string): string[] {
	return rules.filter(rule => rule._source.path?.startsWith(agentDir)).map(rule => rule.name);
}

/** Body of the sticky `RULES.md` rule, the one re-injected every turn. */
function stickyBody(rules: Rule[]): string {
	return rules.find(rule => rule.name === "RULES")?.content ?? "";
}

/** Command names minus the bundled ones every profile gets. */
function authored(names: string[]): string[] {
	return names.filter(name => name.endsWith("-cmd"));
}

/** A `<agentDir>/hooks/pre/<name>.ts` module in the shape the hook loader imports. */
function writeHook(
	f: { writeFile(filePath: string, content: string): string },
	agentDir: string,
	name: string,
): string {
	return f.writeFile(
		path.join(agentDir, "hooks", "pre", `${name}.ts`),
		`export default (pi: { on(event: string, handler: () => void): void }) => {\n\tpi.on("preToolUse", () => {});\n};\n`,
	);
}

/** A `<agentDir>/<subdir>/<name>/SKILL.md`, the shape both skill providers scan. */
function writeSkill(
	f: { writeFile(filePath: string, content: string): string },
	agentDir: string,
	subdir: string,
	name: string,
): string {
	return f.writeFile(
		path.join(agentDir, subdir, name, "SKILL.md"),
		`---\nname: ${name}\ndescription: Skill ${name}.\n---\nBody of ${name}.\n`,
	);
}

/** An extension package directory shipping one skill, the `veyyon-plugins` shape. */
function writePluginPackage(
	f: { writeFile(filePath: string, content: string): string },
	dir: string,
	skillName: string,
): string {
	f.writeFile(
		path.join(dir, "skills", skillName, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: Skill ${skillName}.\n---\nBody of ${skillName}.\n`,
	);
	return dir;
}

/**
 * Install a marketplace plugin into the profile that owns `agentDir`, exactly the
 * way `veyyon plugin install` does: a package dir shipping `commands/`, plus an
 * entry in `<profile root>/plugins/installed_plugins.json`.
 */
function installMarketplacePlugin(
	f: { home: string; writeFile(filePath: string, content: string): string },
	agentDir: string,
	pluginName: string,
	commandName: string,
): void {
	const installPath = path.join(f.home, `${pluginName}-install`);
	f.writeFile(path.join(installPath, "commands", `${commandName}.md`), `Run ${commandName}.\n`);
	f.writeFile(
		path.join(path.dirname(agentDir), "plugins", "installed_plugins.json"),
		JSON.stringify({
			version: 1,
			plugins: {
				[`${pluginName}@test-marketplace`]: [{ installPath, version: "1.0.0", enabled: true, scope: "user" }],
			},
		}),
	);
}

/**
 * Install a marketplace plugin shipping one AGENT DEFINITION into the profile that owns
 * `agentDir`. Separate from the command variant because agents are a different
 * sub-directory and a different loader (`task/discovery.ts`, not the capability layer).
 */
function installMarketplacePluginAgent(
	f: { home: string; writeFile(filePath: string, content: string): string },
	agentDir: string,
	pluginName: string,
	agentName: string,
): void {
	const installPath = path.join(f.home, `${pluginName}-agent-install`);
	f.writeFile(
		path.join(installPath, "agents", `${agentName}.md`),
		`---\nname: ${agentName}\ndescription: Agent ${agentName}.\n---\nBody of ${agentName}.\n`,
	);
	f.writeFile(
		path.join(path.dirname(agentDir), "plugins", "installed_plugins.json"),
		JSON.stringify({
			version: 1,
			plugins: {
				[`${pluginName}@test-marketplace`]: [{ installPath, version: "1.0.0", enabled: true, scope: "user" }],
			},
		}),
	);
}

/** One `<dir>/<name>.md` agent definition with the frontmatter the task loader requires. */
function writeAgentDefinition(
	f: { writeFile(filePath: string, content: string): string },
	dir: string,
	agentName: string,
): void {
	f.writeFile(
		path.join(dir, `${agentName}.md`),
		`---\nname: ${agentName}\ndescription: Agent ${agentName}.\n---\nBody of ${agentName}.\n`,
	);
}
