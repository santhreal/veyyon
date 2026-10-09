/**
 * The ChatGPT Pro included prediction mode requests nothing without a ChatGPT Pro plan Codex
 * login, so the settings screen must not present it as active or choosable then: the row reads
 * as off, and in the mode submenu the option is greyed out, cannot be chosen, and says to connect
 * a ChatGPT Pro account. Choosing it again is also how an explicit Off would be overridden, so an
 * inert option leaves a stored Off in place.
 *
 * Drives the real `SettingsSelectorComponent` against a model registry whose stored Codex
 * credential is a JWT carrying the plan claim, and against the `OPENAI_CODEX_OAUTH_TOKEN`
 * environment login, which `hasIncludedPredictionLogin` also reads. Not covered: a runtime or
 * models.yml key override, or several stored Codex accounts on different plans; the predictor
 * uses the one credential auth routing selects, while this screen accepts any stored Pro login.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { CODEX_JWT_AUTH_CLAIM } from "@veyyon/catalog/wire/codex";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { invalidateSettingDefsCache } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-defs";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-selector";
import { getSelectListTheme, initTheme } from "@veyyon/coding-agent/theme/theme";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { stubStdoutGeometry } from "../../../helpers/stdout-geometry";

const MODE_PATH = "composer.predictions.mode";
const HINT = "Connect ChatGPT Pro for free, usage-less predictions.";
const UP = "\x1b[A";

function codexToken(plan: string): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "RS256" })}.${encode({ [CODEX_JWT_AUTH_CLAIM]: { chatgpt_plan_type: plan } })}.sig`;
}

/**
 * Whether the option's label opens in the select list's description paint, the grey an inert row
 * uses. Read with the cursor elsewhere, since the selected row has its own paint.
 */
function proOptionIsGrey(component: SettingsSelectorComponent): boolean {
	const probe = getSelectListTheme().description("\u0000");
	const greyOpen = probe.slice(0, probe.indexOf("\u0000"));
	if (greyOpen.length === 0) throw new Error("description paint emits no SGR; the grey probe cannot distinguish rows");
	const line = component.render(160).find(raw => stripVTControlCharacters(raw).includes("ChatGPT Pro included"));
	return line?.includes(`${greyOpen}ChatGPT Pro included`) ?? false;
}

/** A registry whose stored OpenAI Codex login is on `plan`, or that holds no Codex login. */
function registryWith(plan: string | undefined): ModelRegistry {
	const stored =
		plan === undefined
			? {}
			: { "openai-codex": { type: "oauth", access: codexToken(plan), refresh: "", expires: 0 } };
	return {
		isKeylessProvider: () => false,
		hasConfiguredAuth: () => true,
		authStorage: { hasAuth: () => true, getAll: () => stored },
	} as unknown as ModelRegistry;
}

const ENV_TOKEN = "OPENAI_CODEX_OAUTH_TOKEN";
let geometryStub: { restore(): void } | undefined;
let policy: AnsiPolicy;
let envToken: string | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry({ columns: 160, rows: 40 });
	invalidateSettingDefsCache();
	// Paint is identity under the piped policy, which would make grey and plain rows byte-identical.
	policy = getAnsiPolicy();
	setAnsiPolicy("full");
	// The host's own Codex login must not decide what this suite observes.
	envToken = Bun.env[ENV_TOKEN];
	delete Bun.env[ENV_TOKEN];
});

afterEach(() => {
	setAnsiPolicy(policy);
	if (envToken === undefined) delete Bun.env[ENV_TOKEN];
	else Bun.env[ENV_TOKEN] = envToken;
	geometryStub?.restore();
	geometryStub = undefined;
	invalidateSettingDefsCache();
	resetSettingsForTest();
});

function selectorOnModeRow(plan: string | undefined): SettingsSelectorComponent {
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: ["openai-codex"],
			cwd: process.cwd(),
			modelRegistry: registryWith(plan),
			availableModels: [],
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
	component.openTab("interaction");
	expect(component.selectSetting(MODE_PATH)).toBe(true);
	return component;
}

function lines(component: SettingsSelectorComponent): string[] {
	return component.render(160).map(stripVTControlCharacters);
}

function modeRow(component: SettingsSelectorComponent): string {
	// The group heading shares the setting's label; the setting row is the one without the heading glyph.
	return lines(component).find(line => line.includes("Composer Predictions") && !line.includes("◆")) ?? "";
}

describe("the ChatGPT Pro prediction mode without a Pro login", () => {
	it.each([
		["no Codex login", undefined],
		["a Plus plan Codex login", "plus"],
	])("reads as off on the row with %s", (_case, plan) => {
		expect(modeRow(selectorOnModeRow(plan))).toContain("Off (no ChatGPT Pro account)");
	});

	it("is greyed out in the submenu with the connect hint", async () => {
		await settings.set(MODE_PATH, "off");
		const component = selectorOnModeRow(undefined);
		component.handleInput("\n");
		const rendered = lines(component).join("\n");
		expect(rendered).toContain("ChatGPT Pro included");
		expect(rendered).toContain(HINT);
		expect(proOptionIsGrey(component)).toBe(true);
	});

	it("cannot be chosen, so a stored Off stays off", async () => {
		await settings.set(MODE_PATH, "off");
		const component = selectorOnModeRow(undefined);
		component.handleInput("\n");
		component.handleInput(UP);
		component.handleInput("\n");
		expect(settings.get(MODE_PATH)).toBe("off");
	});

	it("reads as off with a Plus plan login held only in the environment", () => {
		Bun.env[ENV_TOKEN] = codexToken("plus");
		expect(modeRow(selectorOnModeRow(undefined))).toContain("Off (no ChatGPT Pro account)");
	});
});

describe("the ChatGPT Pro prediction mode with a Pro login", () => {
	it("reads as the mode on the row", () => {
		const row = modeRow(selectorOnModeRow("pro"));
		expect(row).toContain("ChatGPT Pro included");
		expect(row).not.toContain("no ChatGPT Pro account");
	});

	it("offers the option without the connect hint and can be chosen over a stored Off", async () => {
		await settings.set(MODE_PATH, "off");
		const component = selectorOnModeRow("pro");
		component.handleInput("\n");
		expect(lines(component).join("\n")).not.toContain(HINT);
		expect(proOptionIsGrey(component)).toBe(false);
		component.handleInput(UP);
		component.handleInput("\n");
		expect(settings.get(MODE_PATH)).toBe("chatgpt-pro");
	});

	it("counts a Pro plan login held only in the environment", async () => {
		Bun.env[ENV_TOKEN] = codexToken("pro");
		await settings.set(MODE_PATH, "off");
		const component = selectorOnModeRow(undefined);
		component.handleInput("\n");
		expect(proOptionIsGrey(component)).toBe(false);
		component.handleInput(UP);
		component.handleInput("\n");
		expect(settings.get(MODE_PATH)).toBe("chatgpt-pro");
	});
});
