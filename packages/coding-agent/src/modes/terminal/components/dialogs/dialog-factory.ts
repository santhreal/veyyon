/**
 * Production dialog component factory.
 *
 * Consolidates `DialogViewModel` presentation onto the real production dialog
 * components (`HookSelectorComponent`, `HookInputComponent`) rather than a
 * driver-specific prototype dialog class.
 */

import { type Component, DEFAULT_MASK_CHAR, type TUI } from "@veyyon/tui";
import type { DialogResult, DialogViewModel } from "@veyyon/wire/presentation";
import { HookSelectorComponent } from "../selectors/hook-selector";
import { HookInputComponent } from "./hook-input";

export interface DialogComponentOptions {
	tui?: TUI;
	onRequestRender?: () => void;
	timeout?: number;
	onTimeout?: () => void;
}

/**
 * Creates the production terminal component for a `DialogViewModel`.
 *
 * Handles all `DIALOG_KINDS` entries, preserving keyboard/mouse interactions,
 * filtering, multi-select, disabled options, credential masking, destructive defaults,
 * timeout countdowns, direct y/n key shortcuts, and disposal.
 */
export function createDialogComponent(
	dialog: DialogViewModel,
	onAnswer: (result: DialogResult) => void,
	options?: DialogComponentOptions,
): Component {
	let settled = false;
	const settleOnce = (result: DialogResult): void => {
		if (settled) return;
		settled = true;
		onAnswer(result);
	};

	const handleTimeout = (): void => {
		if (settled) return;
		try {
			options?.onTimeout?.();
		} finally {
			settleOnce({ outcome: "cancelled" });
		}
	};

	switch (dialog.kind) {
		case "confirm": {
			const title = dialog.body ? `${dialog.title}\n${dialog.body}` : dialog.title;
			return new HookSelectorComponent(
				title,
				[dialog.confirmLabel, dialog.cancelLabel],
				(_label, index) => {
					// Index 0 is confirmLabel, Index 1 is cancelLabel (disambiguates identical label strings)
					settleOnce(index === 0 ? { outcome: "confirmed" } : { outcome: "cancelled" });
				},
				() => settleOnce({ outcome: "cancelled" }),
				{
					initialIndex: dialog.destructive ? 1 : 0,
					keyShortcuts: { y: 0, n: 1 },
					tui: options?.tui,
					onRequestRender: options?.onRequestRender,
					timeout: options?.timeout,
					onTimeout: handleTimeout,
				},
			);
		}
		case "select": {
			const disabledIndices = dialog.options
				.map((opt, index) => (opt.disabled ? index : -1))
				.filter(index => index >= 0);
			const initialIndex = dialog.selectedIndex >= 0 ? dialog.selectedIndex : 0;
			return new HookSelectorComponent(
				dialog.title,
				dialog.options.map(opt => ({
					label: opt.label,
					description: opt.description,
					value: opt.value,
				})),
				(_label, index) => {
					const opt = dialog.options[index];
					if (!opt || opt.disabled) throw new Error(`Cannot select unavailable dialog option ${index}`);
					settleOnce({ outcome: "selected", values: [opt.value] });
				},
				() => settleOnce({ outcome: "cancelled" }),
				{
					initialIndex,
					disabledIndices,
					filterable: dialog.filterable,
					multi: dialog.multi,
					selectionMarker: dialog.multi ? "checkbox" : undefined,
					markableCount: dialog.options.length,
					onSelectValues: (values: readonly string[]) => {
						settleOnce({ outcome: "selected", values });
					},
					tui: options?.tui,
					onRequestRender: options?.onRequestRender,
					timeout: options?.timeout,
					onTimeout: handleTimeout,
				},
			);
		}
		case "prompt": {
			return new HookInputComponent(
				dialog.title,
				dialog.placeholder,
				value => settleOnce({ outcome: "entered", value }),
				() => settleOnce({ outcome: "cancelled" }),
				{
					initialValue: dialog.initialValue,
					mask: dialog.masked ? DEFAULT_MASK_CHAR : undefined,
					credentialMode: dialog.masked,
					tui: options?.tui,
					onRequestRender: options?.onRequestRender,
					timeout: options?.timeout,
					onTimeout: handleTimeout,
				},
			);
		}
		case "tool-approval": {
			const titleLines = ["## Permission required", `**Tool:** \`${dialog.toolName}\``];
			if (dialog.impact) titleLines.push(`**Impact:** ${dialog.impact}`);
			if (dialog.input) titleLines.push("", "**Input:**", `\`\`\`json\n${dialog.input}\n\`\`\``);
			const title = titleLines.join("\n");

			const optionsList = [
				{ label: "Approve", description: "Run this call once. Nothing is remembered.", value: "approveOnce" },
				{
					label: "Approve for session",
					description: "Run this and every later call to this tool, until you exit.",
					value: "approveSession",
				},
				{ label: "Deny", description: "Do not run this call.", value: "denyOnce" },
				{
					label: "Deny for session",
					description: "Refuse this and every later call to this tool, until you exit.",
					value: "denySession",
				},
			];

			return new HookSelectorComponent(
				title,
				optionsList,
				(_label, index) => {
					switch (index) {
						case 0:
							settleOnce({ outcome: "approved", remember: false });
							break;
						case 1:
							settleOnce({ outcome: "approved", remember: true });
							break;
						case 2:
							settleOnce({ outcome: "rejected" });
							break;
						case 3:
							settleOnce({ outcome: "rejected", reason: "denied for session" });
							break;
						default:
							settleOnce({ outcome: "rejected" });
							break;
					}
				},
				() => settleOnce({ outcome: "cancelled" }),
				{
					selectionMarker: "radio",
					keyShortcuts: { y: 0, n: 2 },
					tui: options?.tui,
					onRequestRender: options?.onRequestRender,
					timeout: options?.timeout,
					onTimeout: handleTimeout,
				},
			);
		}
		default: {
			const unhandled: never = dialog;
			throw new Error(`Unhandled dialog kind: ${String(unhandled)}`);
		}
	}
}
