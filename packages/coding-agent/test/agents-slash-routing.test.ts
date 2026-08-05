import { describe, expect, it, type Mock, vi } from "bun:test";
import { lookupBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";

/**
 * `/agents` is a live navigation surface, not a profile editor. The contract
 * pinned here is that its TUI handler opens the Agent Control Center overlay
 * and nothing else: routing it back through the settings selector would swap a
 * live roster for a form, which is the mistake these cases catch.
 *
 * `/cockpit` and `/hub` are aliases rather than commands of their own, so they
 * must resolve to the very same handler. They were once separate overlays over
 * the same registry and could disagree about which agents were running.
 */
describe("/agents routing", () => {
	function invoke(name: string): { showAgentsDashboard: Mock<() => void>; setText: Mock<(text: string) => void> } {
		const showAgentsDashboard = vi.fn();
		const showSettingsSelector = vi.fn();
		const setText = vi.fn();
		const command = lookupBuiltinSlashCommand(name);
		if (!command?.handleTui) throw new Error(`Expected /${name} TUI handler`);

		command.handleTui(
			{ name, args: [], rawArgs: "" } as never,
			{ ctx: { showAgentsDashboard, showSettingsSelector, editor: { setText } } } as never,
		);

		expect(showSettingsSelector).not.toHaveBeenCalled();
		return { showAgentsDashboard, setText };
	}

	it("opens the live agent hub without invoking a settings dashboard", () => {
		const { showAgentsDashboard, setText } = invoke("agents");

		expect(showAgentsDashboard).toHaveBeenCalledTimes(1);
		expect(setText).toHaveBeenCalledWith("");
		expect(lookupBuiltinSlashCommand("agents")?.description).toBe(
			"Agent Control Center: live agent roster and comms stream",
		);
	});

	it.each(["cockpit", "hub"])("routes /%s to the same overlay as /agents", alias => {
		const { showAgentsDashboard, setText } = invoke(alias);

		expect(showAgentsDashboard).toHaveBeenCalledTimes(1);
		expect(setText).toHaveBeenCalledWith("");
	});
});
