/**
 * The ChatGPT Pro included prediction mode requests nothing without a ChatGPT Pro plan Codex
 * login, so the settings screen must not present it as active or choosable then: the row reads
 * as off, and in the mode submenu the option is greyed out, cannot be chosen, and says to connect
 * a ChatGPT Pro account. Choosing it again is also how an explicit Off would be overridden, so an
 * inert option leaves a stored Off in place.
 *
 * The screen and the predictor read one function, `includedPredictionLogins`, so they agree on
 * every login shape: any stored account on the Pro plan counts, whatever its position; the
 * `OPENAI_CODEX_OAUTH_TOKEN` environment login counts; and an `--api-key`, a `models.yml` key or a
 * `models.yml` key command for the Codex provider replaces every Codex login, so none counts.
 *
 * Drives the real `SettingsSelectorComponent` over a real `ModelRegistry` and `AuthStorage`
 * holding Codex OAuth accounts whose access tokens carry the plan claim. Not covered: a stored
 * token whose plan changes on refresh, which only the predictor reads.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { clearConfigValueCache } from "@veyyon/coding-agent/config/resolve-config-value";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { invalidateSettingDefsCache } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-defs";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-selector";
import { getSelectListTheme, initTheme } from "@veyyon/coding-agent/theme/theme";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { CODEX_ENV_TOKEN, codexToken, storeCodexLogins } from "../../../helpers/codex-logins";
import { stubStdoutGeometry } from "../../../helpers/stdout-geometry";
import { useTrackedTempDirs } from "../../../helpers/tracked-temp-dir";

const MODE_PATH = "composer.predictions.mode";
const HINT = "Connect a ChatGPT Pro account to use this mode.";
const DOWN = "\x1b[B";

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

/** The Codex logins a case starts with. */
interface CodexLogins {
	/** Plans of the stored OpenAI Codex accounts, in storage order. */
	stored?: readonly string[];
	/** The `OPENAI_CODEX_OAUTH_TOKEN` value. */
	env?: string;
	/** An `--api-key` for the Codex provider. */
	runtimeKey?: string;
	/** The `models.yml` body. */
	modelsYml?: string;
}

const makeTempDir = useTrackedTempDirs("veyyon-prediction-mode-");
const stores: AuthStorage[] = [];

/** A real model registry over a fresh credential store holding `logins`. */
async function registryWith(logins: CodexLogins): Promise<ModelRegistry> {
	const dir = makeTempDir();
	const auth = await AuthStorage.create(path.join(dir, "auth.db"));
	stores.push(auth);
	await storeCodexLogins(auth, logins.stored ?? []);
	if (logins.env !== undefined) Bun.env[CODEX_ENV_TOKEN] = logins.env;
	if (logins.runtimeKey !== undefined) auth.setRuntimeApiKey("openai-codex", logins.runtimeKey);
	const modelsPath = path.join(dir, "models.yml");
	if (logins.modelsYml !== undefined) await fs.writeFile(modelsPath, logins.modelsYml);
	return new ModelRegistry(auth, modelsPath, {
		fetch: () => Promise.reject(new Error("network disabled in prediction mode test")),
	});
}

let geometryStub: { restore(): void } | undefined;
let policy: AnsiPolicy;
let hostEnvToken: string | undefined;

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
	hostEnvToken = Bun.env[CODEX_ENV_TOKEN];
	delete Bun.env[CODEX_ENV_TOKEN];
	clearConfigValueCache();
});

afterEach(() => {
	setAnsiPolicy(policy);
	if (hostEnvToken === undefined) delete Bun.env[CODEX_ENV_TOKEN];
	else Bun.env[CODEX_ENV_TOKEN] = hostEnvToken;
	for (const auth of stores.splice(0)) auth.close();
	clearConfigValueCache();
	geometryStub?.restore();
	geometryStub = undefined;
	invalidateSettingDefsCache();
	resetSettingsForTest();
});

async function selectorOnModeRow(logins: CodexLogins): Promise<SettingsSelectorComponent> {
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: ["openai-codex"],
			cwd: process.cwd(),
			modelRegistry: await registryWith(logins),
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
	return lines(component).find(line => line.includes("Prediction Source")) ?? "";
}

describe("the ChatGPT Pro prediction mode without a Pro login", () => {
	it.each<[string, CodexLogins]>([
		["no Codex login", {}],
		["a Plus plan Codex login", { stored: ["plus"] }],
		["a Plus plan login held only in the environment", { env: codexToken("plus") }],
		["a stored Pro login replaced by an --api-key", { stored: ["pro"], runtimeKey: "sk-runtime" }],
		["an environment Pro login replaced by an --api-key", { env: codexToken("pro"), runtimeKey: "sk-runtime" }],
		[
			"a stored Pro login replaced by a models.yml key",
			{ stored: ["pro"], modelsYml: "providers:\n  openai-codex:\n    apiKey: literal:sk-config\n" },
		],
		[
			"a stored Pro login replaced by a models.yml key command that yields nothing",
			{ stored: ["pro"], modelsYml: 'providers:\n  openai-codex:\n    apiKey: "!exit 1"\n' },
		],
	])("reads as off on the row when chosen with %s", async (_case, logins) => {
		await settings.set(MODE_PATH, "chatgpt-pro");
		expect(modeRow(await selectorOnModeRow(logins))).toContain("Off (no ChatGPT Pro account)");
	});

	it("is greyed out in the submenu with the connect hint", async () => {
		await settings.set(MODE_PATH, "off");
		const component = await selectorOnModeRow({});
		component.handleInput("\n");
		const rendered = lines(component).join("\n");
		expect(rendered).toContain("ChatGPT Pro included");
		expect(rendered).toContain(HINT);
		expect(proOptionIsGrey(component)).toBe(true);
	});

	it("cannot be chosen, so a stored Off stays off", async () => {
		await settings.set(MODE_PATH, "off");
		const component = await selectorOnModeRow({ stored: ["pro"], runtimeKey: "sk-runtime" });
		component.handleInput("\n");
		component.handleInput(DOWN);
		component.handleInput("\n");
		expect(settings.get(MODE_PATH)).toBe("off");
	});
});

describe("the ChatGPT Pro prediction mode with a Pro login", () => {
	it("reads as the mode on the row when chosen", async () => {
		await settings.set(MODE_PATH, "chatgpt-pro");
		const row = modeRow(await selectorOnModeRow({ stored: ["pro"] }));
		expect(row).toContain("ChatGPT Pro included");
		expect(row).not.toContain("no ChatGPT Pro account");
	});

	it.each<[string, CodexLogins]>([
		["a stored Pro login", { stored: ["pro"] }],
		["a Pro account stored after a Plus account", { stored: ["plus", "pro"] }],
		["a Pro login held only in the environment", { env: codexToken("pro") }],
	])("is offered without the connect hint and can be chosen over a stored Off with %s", async (_case, logins) => {
		await settings.set(MODE_PATH, "off");
		const component = await selectorOnModeRow(logins);
		component.handleInput("\n");
		expect(lines(component).join("\n")).not.toContain(HINT);
		expect(proOptionIsGrey(component)).toBe(false);
		component.handleInput(DOWN);
		component.handleInput("\n");
		expect(settings.get(MODE_PATH)).toBe("chatgpt-pro");
	});
});
