import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";

/**
 * Stateful fake: `isApprovalBypassed`/`setApprovalBypass` back a real boolean so
 * a toggle sequence behaves like the session. `confirmResult` drives the danger
 * confirmation dialog.
 */
function createRuntime(confirmResult = true) {
	let bypassed = false;
	const setApprovalBypass = vi.fn((v: boolean) => {
		bypassed = v;
		return bypassed;
	});
	const isApprovalBypassed = vi.fn(() => bypassed);
	const showHookConfirm = vi.fn(async () => confirmResult);
	const showStatus = vi.fn();
	const setText = vi.fn();
	const updateEditorBorderColor = vi.fn();
	const invalidate = vi.fn();
	const requestRender = vi.fn();
	return {
		setApprovalBypass,
		isApprovalBypassed,
		showHookConfirm,
		showStatus,
		updateEditorBorderColor,
		getBypassed: () => bypassed,
		runtime: {
			ctx: {
				session: {
					setApprovalBypass,
					isApprovalBypassed,
				} as unknown as InteractiveModeContext["session"],
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				statusLine: { invalidate } as unknown as InteractiveModeContext["statusLine"],
				ui: { requestRender } as unknown as InteractiveModeContext["ui"],
				showHookConfirm,
				showStatus,
				updateEditorBorderColor,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/yolo slash command", () => {
	it("enables the bypass only after the danger confirmation is accepted", async () => {
		const h = createRuntime(true);

		const handled = await executeBuiltinSlashCommand("/yolo", h.runtime);

		expect(handled).toBe(true);
		expect(h.showHookConfirm).toHaveBeenCalledTimes(1);
		expect(h.setApprovalBypass).toHaveBeenCalledWith(true);
		expect(h.getBypassed()).toBe(true);
		expect(h.updateEditorBorderColor).toHaveBeenCalledTimes(1);
		expect(h.showStatus).toHaveBeenCalledWith("YOLO on: all permission prompts are OFF for this session.");
	});

	it("does NOT enable the bypass when the confirmation is declined", async () => {
		const h = createRuntime(false);

		await executeBuiltinSlashCommand("/yolo", h.runtime);

		expect(h.showHookConfirm).toHaveBeenCalledTimes(1);
		expect(h.setApprovalBypass).not.toHaveBeenCalled();
		expect(h.getBypassed()).toBe(false);
		expect(h.showStatus).toHaveBeenCalledWith("Full permission bypass not enabled.");
	});

	it("turns the bypass off without any confirmation", async () => {
		const h = createRuntime(true);
		h.setApprovalBypass(true);
		h.setApprovalBypass.mockClear();

		await executeBuiltinSlashCommand("/yolo off", h.runtime);

		expect(h.showHookConfirm).not.toHaveBeenCalled();
		expect(h.setApprovalBypass).toHaveBeenCalledWith(false);
		expect(h.getBypassed()).toBe(false);
		expect(h.updateEditorBorderColor).toHaveBeenCalledTimes(1);
		expect(h.showStatus).toHaveBeenCalledWith("Full permission bypass off. Approval prompts are back on.");
	});

	it("reports status without toggling", async () => {
		const h = createRuntime(true);

		await executeBuiltinSlashCommand("/yolo status", h.runtime);

		expect(h.setApprovalBypass).not.toHaveBeenCalled();
		expect(h.showHookConfirm).not.toHaveBeenCalled();
		expect(h.showStatus).toHaveBeenCalledWith("Full permission bypass is off.");
	});

	it("does not re-confirm when the bypass is already on", async () => {
		const h = createRuntime(true);
		h.setApprovalBypass(true);
		h.setApprovalBypass.mockClear();

		await executeBuiltinSlashCommand("/yolo on", h.runtime);

		expect(h.showHookConfirm).not.toHaveBeenCalled();
		expect(h.setApprovalBypass).not.toHaveBeenCalled();
		expect(h.showStatus).toHaveBeenCalledWith("Full permission bypass is already on.");
	});
});
