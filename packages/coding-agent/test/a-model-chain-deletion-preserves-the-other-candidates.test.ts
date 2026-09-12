/**
 * WHY: list deletion and picker clearing must persist the same ordered chain.
 * Exercise both production input paths across every candidate position and both
 * deletion keys. The suite catches wrong-index removal, lost fallbacks, duplicate
 * writes and accidental inheritance while cancelling an added fallback.
 * It does not exercise provider discovery or terminal paint scheduling.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { ModelChainSubmenu } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-selector";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirs("model-chain-deletion-");
const CHAIN = ["test/alpha", "test/beta", "test/gamma"];
const KEYS = ["\x1b[3~", "\x7f"];
let auth: AuthStorage;
let registry: ModelRegistry;
let submenu: ModelChainSubmenu | undefined;

beforeAll(async () => {
	await initTheme();
});
beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "display.transitions": "off" } });
	auth = await AuthStorage.create(join(makeTempDir(), "auth.db"));
	registry = new ModelRegistry(auth);
});
afterEach(() => {
	submenu?.dispose();
	submenu = undefined;
	auth?.close();
	resetSettingsForTest();
});

function open(chain: string[]) {
	const writes: Array<string[] | undefined> = [];
	const changes: Array<string[] | undefined> = [];
	const exits: Array<string | undefined> = [];
	const component = new ModelChainSubmenu(
		{ write: value => writes.push(value) },
		registry,
		[],
		"Model chain",
		chain,
		value => exits.push(value),
		value => changes.push(value),
	);
	submenu = component;
	return { component, writes, changes, exits };
}

function select(component: ModelChainSubmenu, index: number): void {
	for (let step = 0; step < index; step++) component.handleInput("\x1b[B");
}

const removals = CHAIN.flatMap((_, index) =>
	KEYS.flatMap(key => ["list", "picker"].map(surface => ({ index, key, surface }))),
);

describe("model-chain deletion", () => {
	it.each(removals)("removes only position $index through $surface using $key", ({ index, key, surface }) => {
		const { component, writes, changes, exits } = open(CHAIN);
		select(component, index);
		if (surface === "picker") component.handleInput("\r");
		component.handleInput(key);
		const remaining = CHAIN.filter((_, position) => position !== index);
		expect(writes).toEqual([remaining]);
		expect(changes).toEqual([remaining]);
		expect(exits).toEqual([]);
		component.handleInput("\x1b");
		expect(exits).toEqual([remaining.join(",")]);
	});

	it.each(KEYS)("restores inheritance after deleting the last candidate with %j", key => {
		const { component, writes, changes } = open([CHAIN[0]!]);
		component.handleInput("\r");
		component.handleInput(key);
		expect(writes).toEqual([undefined]);
		expect(changes).toEqual([undefined]);
	});

	it.each(KEYS)("cancels adding a fallback without clearing the chain with %j", key => {
		const { component, writes, changes, exits } = open(CHAIN);
		select(component, CHAIN.length);
		component.handleInput("\r");
		component.handleInput(key);
		expect(writes).toEqual([]);
		expect(changes).toEqual([]);
		component.handleInput("\x1b");
		expect(exits).toEqual([CHAIN.join(",")]);
	});

	it.each(KEYS)("confirms inheritance from an empty picker with %j", key => {
		const { component, writes, changes, exits } = open([]);
		component.handleInput(key);
		expect(writes).toEqual([undefined]);
		expect(changes).toEqual([undefined]);
		expect(exits).toEqual(["inherit"]);
	});
});
