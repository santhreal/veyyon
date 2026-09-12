/**
 * Render interactive input prompts for the secret command.
 *
 * Constructs hook input components representing the masked secret value prompt, a masked
 * prompt with pasted credentials, and the trailing unmasked secret name prompt. Prints
 * each rendered prompt section with labels as ANSI text.
 *
 * Usage:
 *   bun scripts/demos/render-secret-prompts.ts [--width 100] [--theme titanium]
 */

import { DEFAULT_MASK_CHAR } from "@veyyon/tui";
import { HookInputComponent } from "../../packages/coding-agent/src/modes/terminal/components/dialogs/hook-input";
import {
	maskedPromptHint,
	maskedPromptTitle,
	namePromptHint,
	namePromptTitle,
} from "../../packages/coding-agent/src/slash-commands/helpers/secret";
import { theme } from "../../packages/coding-agent/src/theme/theme";
import { renderDemo } from "./render-args";

await renderDemo(
	({ width }) => {
		const lines: string[] = [];
		function section(caption: string, component: HookInputComponent, typed?: string): void {
			if (typed !== undefined) for (const char of typed) component.handleInput(char);
			lines.push(theme.fg("dim", `── ${caption}`), "", ...component.render(width), "");
		}

		section(
			"bare /secret, the masked value field, untouched:",
			new HookInputComponent(
				maskedPromptTitle(),
				undefined,
				() => {},
				() => {},
				{ mask: DEFAULT_MASK_CHAR, hint: maskedPromptHint() },
			),
		);

		section(
			"the masked field with a credential pasted in:",
			new HookInputComponent(
				maskedPromptTitle(),
				undefined,
				() => {},
				() => {},
				{ mask: DEFAULT_MASK_CHAR, hint: maskedPromptHint() },
			),
			"ghp_liveLookingCredential0001",
		);

		section(
			"the name field that follows, unmasked and optional:",
			new HookInputComponent(
				namePromptTitle(),
				undefined,
				() => {},
				() => {},
				{ hint: namePromptHint() },
			),
		);

		return lines;
	},
	{ settings: true },
);
