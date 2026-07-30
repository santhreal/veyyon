import {
	APPROVAL_DIALOG_OPTIONS,
	APPROVAL_SELECT_OPTIONS,
} from "../../packages/coding-agent/src/extensibility/extensions/wrapper";
import { HookSelectorComponent } from "../../packages/coding-agent/src/modes/components/hook-selector";
import { initTheme } from "../../packages/coding-agent/src/modes/theme/theme";
import { formatApprovalCard } from "../../packages/coding-agent/src/tools/approval";
import { flag, hasFlag, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
const denySelected = hasFlag("deny");
const narrow = hasFlag("narrow");

await initTheme(false, "unicode", false, themeName, themeName);

const command = narrow
	? "rm -rf /home/operator/projects/archive/very-long-customer-export-directory-that-does-not-fit-on-one-line"
	: "rm -rf /home/operator/projects/archive";
const reason = narrow
	? "This command recursively deletes a protected path outside the active workspace and cannot be recovered."
	: "Recursive delete targets a protected path outside the active workspace.";
const prompt = formatApprovalCard(
	{
		name: "bash",
		formatApprovalDetails: () => [`Command: ${command}`, "Working directory: ~/projects/veyyon"],
	},
	{ command },
	reason,
);
const selector = new HookSelectorComponent(
	prompt,
	APPROVAL_SELECT_OPTIONS,
	() => {},
	() => {},
	{
		...APPROVAL_DIALOG_OPTIONS,
		maxVisible: 10,
	},
);
if (denySelected) selector.handleInput("\u001b[B");
process.stdout.write(`${selector.render(width).join("\n")}\n`);
