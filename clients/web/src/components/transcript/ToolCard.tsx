import type { WireToolResultMessage } from "@veyyon/wire";
import type { ToolExecutionDisplay } from "@veyyon/wire/presentation";
import type { ReactNode } from "react";
import { memo } from "react";
import { messageText } from "../../lib/format";
import { type ToolRenderHost, ToolView } from "../../tool-render";

export interface ToolCardProps {
	toolCallId: string;
	name: string;
	args: unknown;
	intent?: string;
	result?: WireToolResultMessage;
	running?: boolean;
	partialResult?: unknown;
	host?: ToolRenderHost;
	display?: ToolExecutionDisplay;
}

/** Wire-type adapter over the shared per-tool renderer stack. */
export const ToolCard = memo(function ToolCard(props: ToolCardProps): ReactNode {
	const { name, intent, args, result, running, partialResult, host, display: callDisplay } = props;
	const partial =
		running && !result ? (typeof partialResult === "string" ? partialResult : messageText(partialResult)) : "";
	const resultDisplay =
		result && typeof result === "object" && "display" in result
			? (result.display as ToolExecutionDisplay | undefined)
			: undefined;
	const display = resultDisplay ?? callDisplay;
	return (
		<ToolView
			name={name}
			args={args}
			result={result}
			running={running}
			intent={intent}
			partial={partial || undefined}
			host={host}
			display={display}
		/>
	);
});
