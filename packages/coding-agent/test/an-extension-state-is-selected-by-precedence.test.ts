/**
 * WHY:
 * Consolidating the four independent state-selection branches in `loadAllExtensions` into a
 * unified precedence resolver (`item-disabled > shadowed > provider-disabled > active`) risks subtle
 * regressions in evaluation order, property narrowing, or kind-specific ID/metadata projection across
 * distinct capability types.
 *
 * This suite defends:
 * 1. Dynamic enumeration of the capability registry: every registered capability in the discovery
 *    system is accounted for — each admitted capability is exercised through the real loader, while
 *    non-extension capabilities are pinned by exact equality in an explicit opt-out assertion.
 * 2. Exact state precedence parameterized across all 9 admitted capability kinds:
 *    `item-disabled > shadowed > provider-disabled > active` across every isolated combination of
 *    `itemDisabled` × `shadowed` (via competing priority providers) × `providerEnabled` (via late-disable
 *    transitions where provider is disabled after discovery selection to reach projection).
 * 3. Provider gating at discovery boundary: pre-disabled providers are omitted at discovery time,
 *    while late-disabled providers project their items with `disabledReason: "provider-disabled"`
 *    (or higher-precedence `item-disabled` / `shadowed` states).
 * 4. Exact kind-specific ID formats, trigger expressions, and metadata projections for every admitted capability.
 * 5. State transitions and provider short-circuiting in `applyDisabledExtensionsToState`.
 *
 * WHAT THIS DOES NOT CATCH:
 * - Runtime tool execution and prompt delivery behavior of disabled extensions (owned by runner/dispatch suites).
 * - MCP config-file mutation round-trips and tool-specific foreign config overrides (owned by `extension-dashboard-mcp-parity.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { reset as resetDiscoveryCache } from "@veyyon/coding-agent/discovery";
import {
	captureRegistryForTests,
	disableProvider,
	initializeWithSettings,
	listCapabilities,
	type RegistrySnapshot,
	registerProvider,
	restoreRegistryForTests,
} from "@veyyon/coding-agent/discovery/capability";
import type { ContextFile } from "@veyyon/coding-agent/discovery/capability/context-file";
import type { ExtensionModule } from "@veyyon/coding-agent/discovery/capability/extension-module";
import type { Hook } from "@veyyon/coding-agent/discovery/capability/hook";
import type { MCPServer } from "@veyyon/coding-agent/discovery/capability/mcp";
import type { Prompt } from "@veyyon/coding-agent/discovery/capability/prompt";
import type { Rule } from "@veyyon/coding-agent/discovery/capability/rule";
import type { DiscoveredSkill } from "@veyyon/coding-agent/discovery/capability/skill";
import type { SlashCommand } from "@veyyon/coding-agent/discovery/capability/slash-command";
import type { DiscoveredCustomTool } from "@veyyon/coding-agent/discovery/capability/tool";
import type { SourceMeta } from "@veyyon/coding-agent/discovery/capability/types";
import {
	applyDisabledExtensionsToState,
	loadAllExtensions,
} from "@veyyon/coding-agent/extensibility/extension-state/state-manager";
import type {
	DashboardState,
	DisabledReason,
	ExtensionKind,
	ExtensionRow,
	ExtensionState,
} from "@veyyon/coding-agent/extensibility/extension-state/types";
import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";

interface CapabilityFixture<T> {
	readonly capabilityId: string;
	readonly kind: ExtensionKind;
	createItem(name: string, providerId: string): T & { _source: SourceMeta };
	createShadowingItem(name: string, providerId: string): T & { _source: SourceMeta };
	expectedId(name: string): string;
	expectedMetadata(name: string): Partial<ExtensionRow>;
}

const CAPABILITY_FIXTURES: readonly CapabilityFixture<unknown>[] = [
	{
		capabilityId: "skills",
		kind: "skill",
		createItem: (name, provider): DiscoveredSkill & { _source: SourceMeta } => ({
			name,
			path: `/skills/${name}.md`,
			content: "Skill content",
			level: "user",
			frontmatter: { description: `Skill ${name}`, globs: ["*.ts"] },
			_source: { provider, providerName: provider, path: `/skills/${name}.md`, level: "user" },
		}),
		createShadowingItem: (name, provider): DiscoveredSkill & { _source: SourceMeta } => ({
			name,
			path: `/skills/high/${name}.md`,
			content: "High skill content",
			level: "project",
			frontmatter: { description: `High Skill ${name}` },
			_source: { provider, providerName: provider, path: `/skills/high/${name}.md`, level: "project" },
		}),
		expectedId: name => `skill:${name}`,
		expectedMetadata: name => ({
			name,
			displayName: name,
			description: `Skill ${name}`,
			trigger: "*.ts",
			path: `/skills/${name}.md`,
		}),
	},
	{
		capabilityId: "rules",
		kind: "rule",
		createItem: (name, provider): Rule & { _source: SourceMeta } => ({
			name,
			path: `/rules/${name}.md`,
			content: "Rule content",
			description: `Rule ${name}`,
			globs: ["src/**"],
			_source: { provider, providerName: provider, path: `/rules/${name}.md`, level: "project" },
		}),
		createShadowingItem: (name, provider): Rule & { _source: SourceMeta } => ({
			name,
			path: `/rules/high/${name}.md`,
			content: "High rule content",
			description: `High Rule ${name}`,
			_source: { provider, providerName: provider, path: `/rules/high/${name}.md`, level: "project" },
		}),
		expectedId: name => `rule:${name}`,
		expectedMetadata: name => ({
			name,
			displayName: name,
			description: `Rule ${name}`,
			trigger: "src/**",
			path: `/rules/${name}.md`,
		}),
	},
	{
		capabilityId: "tools",
		kind: "tool",
		createItem: (name, provider): DiscoveredCustomTool & { _source: SourceMeta } => ({
			name,
			path: `/tools/${name}.ts`,
			description: `Tool ${name}`,
			level: "user",
			_source: { provider, providerName: provider, path: `/tools/${name}.ts`, level: "user" },
		}),
		createShadowingItem: (name, provider): DiscoveredCustomTool & { _source: SourceMeta } => ({
			name,
			path: `/tools/high/${name}.ts`,
			description: `High Tool ${name}`,
			level: "project",
			_source: { provider, providerName: provider, path: `/tools/high/${name}.ts`, level: "project" },
		}),
		expectedId: name => `tool:${name}`,
		expectedMetadata: name => ({
			name,
			displayName: name,
			description: `Tool ${name}`,
			trigger: undefined,
			path: `/tools/${name}.ts`,
		}),
	},
	{
		capabilityId: "extension-modules",
		kind: "extension-module",
		createItem: (name, provider): ExtensionModule & { _source: SourceMeta } => ({
			name,
			path: `/ext/${name}.ts`,
			level: "user",
			_source: { provider, providerName: provider, path: `/ext/${name}.ts`, level: "user" },
		}),
		createShadowingItem: (name, provider): ExtensionModule & { _source: SourceMeta } => ({
			name,
			path: `/ext/high/${name}.ts`,
			level: "project",
			_source: { provider, providerName: provider, path: `/ext/high/${name}.ts`, level: "project" },
		}),
		expectedId: name => `extension-module:${name}`,
		expectedMetadata: name => ({
			name,
			displayName: name,
			description: undefined,
			trigger: undefined,
			path: `/ext/${name}.ts`,
		}),
	},
	{
		capabilityId: "mcps",
		kind: "mcp",
		createItem: (name, provider): MCPServer & { _source: SourceMeta } => ({
			name,
			command: `${name}-cmd`,
			transport: "stdio",
			_source: { provider, providerName: provider, path: `/mcp/${name}.json`, level: "user" },
		}),
		createShadowingItem: (name, provider): MCPServer & { _source: SourceMeta } => ({
			name,
			command: `high-${name}-cmd`,
			transport: "stdio",
			_source: { provider, providerName: provider, path: `/mcp/high/${name}.json`, level: "project" },
		}),
		expectedId: name => `mcp:${name}`,
		expectedMetadata: name => ({
			name,
			displayName: name,
			description: `${name}-cmd`,
			trigger: "stdio",
			path: `/mcp/${name}.json`,
		}),
	},
	{
		capabilityId: "prompts",
		kind: "prompt",
		createItem: (name, provider): Prompt & { _source: SourceMeta } => ({
			name,
			path: `/prompts/${name}.md`,
			content: "content",
			_source: { provider, providerName: provider, path: `/prompts/${name}.md`, level: "user" },
		}),
		createShadowingItem: (name, provider): Prompt & { _source: SourceMeta } => ({
			name,
			path: `/prompts/high/${name}.md`,
			content: "high content",
			_source: { provider, providerName: provider, path: `/prompts/high/${name}.md`, level: "project" },
		}),
		expectedId: name => `prompt:${name}`,
		expectedMetadata: name => ({
			name,
			displayName: name,
			description: undefined,
			trigger: `/prompts:${name}`,
			path: `/prompts/${name}.md`,
		}),
	},
	{
		capabilityId: "slash-commands",
		kind: "slash-command",
		createItem: (name, provider): SlashCommand & { _source: SourceMeta } => ({
			name,
			path: `/cmd/${name}.md`,
			content: "content",
			level: "project",
			_source: { provider, providerName: provider, path: `/cmd/${name}.md`, level: "project" },
		}),
		createShadowingItem: (name, provider): SlashCommand & { _source: SourceMeta } => ({
			name,
			path: `/cmd/high/${name}.md`,
			content: "high content",
			level: "user",
			_source: { provider, providerName: provider, path: `/cmd/high/${name}.md`, level: "user" },
		}),
		expectedId: name => `slash-command:${name}`,
		expectedMetadata: name => ({
			name,
			displayName: name,
			description: undefined,
			trigger: `/${name}`,
			path: `/cmd/${name}.md`,
		}),
	},
	{
		capabilityId: "hooks",
		kind: "hook",
		createItem: (name, provider): Hook & { _source: SourceMeta } => ({
			name,
			type: "pre",
			tool: "edit",
			path: `/hooks/${name}.sh`,
			level: "project",
			_source: { provider, providerName: provider, path: `/hooks/${name}.sh`, level: "project" },
		}),
		createShadowingItem: (name, provider): Hook & { _source: SourceMeta } => ({
			name,
			type: "pre",
			tool: "edit",
			path: `/hooks/high/${name}.sh`,
			level: "user",
			_source: { provider, providerName: provider, path: `/hooks/high/${name}.sh`, level: "user" },
		}),
		expectedId: name => `hook:pre:edit:${name}`,
		expectedMetadata: name => ({
			name,
			displayName: name,
			description: "pre-edit",
			trigger: "pre:edit",
			path: `/hooks/${name}.sh`,
		}),
	},
	{
		capabilityId: "context-files",
		kind: "context-file",
		createItem: (name, provider): ContextFile & { _source: SourceMeta } => ({
			path: `/context/shared/${name}.md`,
			content: "instructions",
			level: "user",
			_source: { provider, providerName: provider, path: `/context/shared/${name}.md`, level: "user" },
		}),
		createShadowingItem: (name, provider): ContextFile & { _source: SourceMeta } => ({
			path: `/context/high/${name}.md`,
			content: "high instructions",
			level: "user",
			_source: { provider, providerName: provider, path: `/context/high/${name}.md`, level: "user" },
		}),
		expectedId: name => `context-file:user:${name}.md`,
		expectedMetadata: name => ({
			name: `${name}.md`,
			displayName: `${name}.md`,
			description: "User-level context",
			trigger: "user",
			path: `/context/shared/${name}.md`,
		}),
	},
];

describe("an extension state is selected by precedence", () => {
	const dirOverrides = captureDirOverrides();
	let registrySnapshot: RegistrySnapshot | undefined;

	beforeEach(async () => {
		registrySnapshot = captureRegistryForTests();
		resetSettingsForTest();
		const settings = await Settings.init({ inMemory: true });
		initializeWithSettings(settings);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (registrySnapshot) restoreRegistryForTests(registrySnapshot);
		registrySnapshot = undefined;
		resetSettingsForTest();
		restoreDirOverrides(dirOverrides);
		resetDiscoveryCache();
	});

	describe("runtime capability space enumeration", () => {
		test("enumerates registered capabilities and accounts for all admitted vs opted-out members", () => {
			const allCapabilities = listCapabilities().sort();
			const EXPECTED_OPTED_OUT = ["extensions", "instructions", "ssh"];

			const optedOut = allCapabilities.filter(id => EXPECTED_OPTED_OUT.includes(id));
			expect(optedOut).toEqual(EXPECTED_OPTED_OUT);

			const admittedCapabilities = allCapabilities.filter(id => !EXPECTED_OPTED_OUT.includes(id)).sort();
			const fixtureCapabilityIds = CAPABILITY_FIXTURES.map(f => f.capabilityId).sort();
			expect(admittedCapabilities).toEqual(fixtureCapabilityIds);
		});
	});

	describe("parameterized state resolution across all admitted capability kinds", () => {
		interface StateCombination {
			label: string;
			itemDisabled: boolean;
			shadowed: boolean;
			providerEnabled: boolean;
			expectedState: ExtensionState;
			expectedReason: DisabledReason | undefined;
		}

		const COMBINATIONS: readonly StateCombination[] = [
			{
				label: "active (enabled, unshadowed, provider active)",
				itemDisabled: false,
				shadowed: false,
				providerEnabled: true,
				expectedState: "active",
				expectedReason: undefined,
			},
			{
				label: "item-disabled (id in disabledIds)",
				itemDisabled: true,
				shadowed: false,
				providerEnabled: true,
				expectedState: "disabled",
				expectedReason: "item-disabled",
			},
			{
				label: "shadowed (competing higher-priority provider)",
				itemDisabled: false,
				shadowed: true,
				providerEnabled: true,
				expectedState: "shadowed",
				expectedReason: "shadowed",
			},
			{
				label: "provider-disabled (late-disabled provider)",
				itemDisabled: false,
				shadowed: false,
				providerEnabled: false,
				expectedState: "disabled",
				expectedReason: "provider-disabled",
			},
			{
				label: "precedence: item-disabled > shadowed",
				itemDisabled: true,
				shadowed: true,
				providerEnabled: true,
				expectedState: "disabled",
				expectedReason: "item-disabled",
			},
			{
				label: "precedence: item-disabled > provider-disabled (late-disabled provider)",
				itemDisabled: true,
				shadowed: false,
				providerEnabled: false,
				expectedState: "disabled",
				expectedReason: "item-disabled",
			},
			{
				label: "precedence: shadowed > provider-disabled (late-disabled provider)",
				itemDisabled: false,
				shadowed: true,
				providerEnabled: false,
				expectedState: "shadowed",
				expectedReason: "shadowed",
			},
			{
				label: "precedence: item-disabled > shadowed > provider-disabled (late-disabled provider)",
				itemDisabled: true,
				shadowed: true,
				providerEnabled: false,
				expectedState: "disabled",
				expectedReason: "item-disabled",
			},
		];

		for (const fixture of CAPABILITY_FIXTURES) {
			describe(`capability "${fixture.capabilityId}" (${fixture.kind})`, () => {
				for (const combo of COMBINATIONS) {
					test(`resolves ${combo.label}`, async () => {
						const primaryProvId =
							fixture.capabilityId === "extension-modules" ? "native" : `test-prov-${fixture.capabilityId}`;
						const highProvId = `high-prov-${fixture.capabilityId}`;
						const itemName = `item-${fixture.kind}`;
						const extId = fixture.expectedId(itemName);

						const primaryItem = fixture.createItem(itemName, primaryProvId);

						if (combo.shadowed) {
							const shadowingItem = fixture.createShadowingItem(itemName, highProvId);
							registerProvider(fixture.capabilityId, {
								id: highProvId,
								displayName: "High Priority Provider",
								description: "High priority provider",
								priority: 200,
								load: async () => ({ items: [shadowingItem], warnings: [] }),
							});
						}
						registerProvider(fixture.capabilityId, {
							id: primaryProvId,
							displayName: "Primary Provider",
							description: "Primary provider",
							priority: 100,
							load: async () => {
								if (!combo.providerEnabled) {
									disableProvider(primaryProvId);
								}
								return { items: [primaryItem], warnings: [] };
							},
						});
						const disabledIds = combo.itemDisabled ? [extId] : [];
						const rows = await loadAllExtensions(undefined, disabledIds);

						const matchingRows = rows.filter(r => r.id === extId && r.source.provider === primaryProvId);
						expect(matchingRows).toHaveLength(1);

						const row = matchingRows[0]!;
						expect(row.state).toBe(combo.expectedState);
						expect(row.disabledReason).toBe(combo.expectedReason);
						expect(row.kind).toBe(fixture.kind);

						const expectedMeta = fixture.expectedMetadata(itemName);
						expect(row).toMatchObject(expectedMeta);
					});
				}
			});
		}
	});

	describe("discovery boundary gating for pre-disabled providers", () => {
		test("omits items from a provider that was pre-disabled before capability discovery", async () => {
			registerProvider<DiscoveredSkill>("skills", {
				id: "pre-disabled-provider",
				displayName: "Pre-disabled Provider",
				description: "Pre-disabled Provider",
				priority: 100,
				load: async () => ({
					items: [
						{
							name: "pre-disabled-skill",
							path: "/skills/pre.md",
							content: "Skill content",
							level: "user",
							_source: {
								provider: "pre-disabled-provider",
								providerName: "Pre-disabled Provider",
								path: "/skills/pre.md",
								level: "user",
							},
						},
					],
					warnings: [],
				}),
			});

			disableProvider("pre-disabled-provider");

			const rows = await loadAllExtensions();
			const found = rows.find(r => r.id === "skill:pre-disabled-skill");
			expect(found).toBeUndefined();
		});
	});

	describe("applyDisabledExtensionsToState transitions", () => {
		function createMockState(extensions: ExtensionRow[]): DashboardState {
			return {
				tabs: [{ id: "all", label: "ALL", enabled: true, count: extensions.length }],
				activeTabIndex: 0,
				extensions,
				tabFiltered: extensions,
				searchFiltered: extensions,
				searchQuery: "",
				listIndex: 0,
				scrollOffset: 0,
				selected: extensions[0] ?? null,
			};
		}

		test("short-circuits to provider-disabled when provider is disabled before inspecting shadowed status", () => {
			registerProvider<DiscoveredSkill>("skills", {
				id: "inactive-provider",
				displayName: "Inactive Provider",
				description: "Inactive Provider",
				priority: 100,
				load: async () => ({ items: [], warnings: [] }),
			});
			disableProvider("inactive-provider");

			const ext: ExtensionRow = {
				id: "skill:orphan",
				kind: "skill",
				name: "orphan",
				displayName: "orphan",
				path: "/skills/orphan.md",
				source: { provider: "inactive-provider", providerName: "Inactive Provider", level: "user" },
				state: "disabled",
				disabledReason: "item-disabled",
				raw: { _shadowed: true },
			};

			const state = createMockState([ext]);
			const next = applyDisabledExtensionsToState(state, []);

			expect(next.extensions[0]!.state).toBe("disabled");
			expect(next.extensions[0]!.disabledReason).toBe("provider-disabled");
		});

		test("restores an item-disabled item with _shadowed runtime flag to shadowed state when provider is enabled", () => {
			registerProvider<DiscoveredSkill>("skills", {
				id: "active-provider",
				displayName: "Active Provider",
				description: "Active Provider",
				priority: 100,
				load: async () => ({ items: [], warnings: [] }),
			});

			const ext: ExtensionRow = {
				id: "skill:shadowed-item",
				kind: "skill",
				name: "shadowed-item",
				displayName: "shadowed-item",
				path: "/skills/shadowed.md",
				source: { provider: "active-provider", providerName: "Active Provider", level: "user" },
				state: "disabled",
				disabledReason: "item-disabled",
				raw: { _shadowed: true },
			};

			const state = createMockState([ext]);
			const next = applyDisabledExtensionsToState(state, []);

			expect(next.extensions[0]!.state).toBe("shadowed");
			expect(next.extensions[0]!.disabledReason).toBe("shadowed");
		});

		test("restores a shadowed item whose raw handle is a function object with _shadowed", () => {
			registerProvider<DiscoveredSkill>("skills", {
				id: "active-provider",
				displayName: "Active Provider",
				description: "Active Provider",
				priority: 100,
				load: async () => ({ items: [], warnings: [] }),
			});

			const fnHandle = Object.assign(() => {}, { _shadowed: true });
			const ext: ExtensionRow = {
				id: "skill:function-shadowed",
				kind: "skill",
				name: "function-shadowed",
				displayName: "function-shadowed",
				path: "/skills/fn.md",
				source: { provider: "active-provider", providerName: "Active Provider", level: "user" },
				state: "disabled",
				disabledReason: "item-disabled",
				raw: fnHandle,
			};

			const state = createMockState([ext]);
			const next = applyDisabledExtensionsToState(state, []);

			expect(next.extensions[0]!.state).toBe("shadowed");
			expect(next.extensions[0]!.disabledReason).toBe("shadowed");
		});

		const unshadowedHandles: [string, unknown][] = [
			["undefined", undefined],
			["null", null],
			["boolean", false],
			["number", 0],
			["string", "text"],
			["bigint", 0n],
			["symbol", Symbol("raw")],
			["object", {}],
			["false flag", { _shadowed: false }],
			["array", []],
			["function", () => undefined],
		];
		test.each(unshadowedHandles)("restores active state for an unshadowed %s handle", (_name, raw) => {
			registerProvider<DiscoveredSkill>("skills", {
				id: "active-provider",
				displayName: "Active Provider",
				description: "Active Provider",
				priority: 100,
				load: async () => ({ items: [], warnings: [] }),
			});

			const ext: ExtensionRow = {
				id: "skill:normal-item",
				kind: "skill",
				name: "normal-item",
				displayName: "normal-item",
				path: "/skills/normal.md",
				source: { provider: "active-provider", providerName: "Active Provider", level: "user" },
				state: "disabled",
				disabledReason: "item-disabled",
				raw,
			};

			const state = createMockState([ext]);
			const next = applyDisabledExtensionsToState(state, []);

			expect(next.extensions[0]!.state).toBe("active");
			expect(next.extensions[0]!.disabledReason).toBeUndefined();
			expect("disabledReason" in next.extensions[0]!).toBe(false);
		});
	});
});
