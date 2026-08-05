/**
 * Print the two fields a bare `/secret` opens, in order.
 *
 * Storing a credential in a terminal is now a two-field conversation: a masked field for the
 * value, then a visible optional field for the name. Both are `HookInputComponent`, whose entire
 * guidance is ONE title line, and whose `placeholder` argument is discarded (`_placeholder`). So
 * whether an operator staring at an empty box knows what to type is decided by that one string
 * and nothing else, and that is a thing you look at rather than assert.
 *
 * Run:
 *     bun scripts/demos/render-secret-prompts.ts --width 100 |
 *       bun scripts/demos/render-proof.ts --out /tmp/secret-prompts --width 100 --scale 3
 *
 * The components are the real ones, constructed the way `builtin-registry.ts` constructs them,
 * with the titles taken from the real `maskedPromptTitle()` / `namePromptTitle()` rather than
 * retyped here: a proof of copy that quotes its own copy proves nothing.
 */
import { DEFAULT_MASK_CHAR } from "@veyyon/tui";
import { HookInputComponent } from "../../packages/coding-agent/src/modes/components/hook-input";
import { theme } from "../../packages/coding-agent/src/modes/theme/theme";
import {
	maskedPromptHint,
	maskedPromptTitle,
	namePromptHint,
	namePromptTitle,
} from "../../packages/coding-agent/src/slash-commands/helpers/secret";
import { flag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
await initRender(themeName, { settings: true });

const lines: string[] = [];

function section(caption: string, component: HookInputComponent, typed?: string): void {
	if (typed !== undefined) for (const char of typed) component.handleInput(char);
	lines.push(theme.fg("dim", `── ${caption}`), "", ...component.render(width), "");
}

// What a bare `/secret` opens first. Empty, because that is the moment the operator has to decide
// what this box wants: the whole question is whether the title answers it before they type.
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

// The same field mid-paste. Rendered because masking is the feature: if the echo is not obviously
// hidden here, an operator pastes a live credential into a visible field and never notices.
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

// The second field, which only exists once a value is held. Unmasked on purpose: seeing this one
// echo is what tells the operator the hidden question is over and a different one has started.
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

process.stdout.write(`${lines.join("\n")}\n`);
