import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import {
	BUILTIN_SLASH_COMMAND_DEFS,
	executeBuiltinSlashCommand,
} from "@veyyon/coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const showProviderSetup = vi.fn(async () => {});
	const showAccountManager = vi.fn(async () => {});
	const showWarning = vi.fn();
	const setText = vi.fn();
	return {
		showProviderSetup,
		showAccountManager,
		showWarning,
		setText,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showProviderSetup,
				showAccountManager,
				showWarning,
			} as unknown as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		},
	};
}

describe("/setup slash command", () => {
	/**
	 * `/setup providers` is a SUBCOMMAND, and it is what the wizard is reached by now that
	 * `/providers` is its own command. It used to be an ALIAS of `/setup`, so this assertion is what
	 * keeps the wizard reachable at all: dropping the alias without keeping the subcommand would
	 * leave the onboarding provider scene with no name a user can type.
	 */
	it("still declares its providers subcommand", () => {
		const setupCommand = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "setup");
		expect(setupCommand?.subcommands?.map(sub => sub.name)).toEqual(["providers"]);
	});

	/**
	 * The alias is GONE. While it existed, `/providers` opened the onboarding wizard's provider
	 * scene: one row per provider, no account identity, no way to see which of several stored
	 * credentials the session was spending. This asserts the alias cannot come back and quietly
	 * take the name back off the account manager.
	 */
	it("no longer answers to /providers as an alias", () => {
		const setupCommand = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "setup");
		expect(setupCommand?.aliases ?? []).not.toContain("providers");
	});

	it("opens provider setup for /setup", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/setup", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showProviderSetup).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("opens provider setup for /setup providers", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/setup providers", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showProviderSetup).toHaveBeenCalledTimes(1);
		expect(harness.showWarning).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	/**
	 * `/providers` opens the ACCOUNT MANAGER and never the wizard. This is the whole point of the
	 * rename: the name a user reaches for when they want to see their accounts must lead to the
	 * surface that shows accounts, not to onboarding.
	 */
	it("routes /providers to the account manager, not the wizard", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/providers", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showAccountManager).toHaveBeenCalledTimes(1);
		expect(harness.showAccountManager).toHaveBeenCalledWith();
		expect(harness.showProviderSetup).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("shows usage for unsupported setup scenes", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/setup theme", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showProviderSetup).not.toHaveBeenCalled();
		expect(harness.showWarning).toHaveBeenCalledWith("Usage: /setup [providers]");
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});
