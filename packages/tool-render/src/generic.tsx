/** Fallback renderer for tools without a dedicated view. */
import type { ReactNode } from "react";
import { createElement } from "react";
import { Output, ResultImages, ResultText } from "./parts";
import type { ToolRenderer, ToolRenderProps } from "./types";
import { argsDigest, prettyJson } from "./util";
import { ToolExecutionBody, ToolExecutionSummary } from "./ViewRenderer";

export function GenericSummary(props: ToolRenderProps): ReactNode {
	if (props.display) {
		return createElement(ToolExecutionSummary, props);
	}
	return <span>{argsDigest(props.args)}</span>;
}

export function GenericBody(props: ToolRenderProps): ReactNode {
	if (props.display) {
		return createElement(ToolExecutionBody, props);
	}
	const { args, result } = props;
	const argText = prettyJson(args);
	return (
		<>
			{argText && argText !== "{}" && (
				<Output text={argText} lang="json" variant="code" maxLines={12} title="args" />
			)}
			<ResultImages result={result} />
			<ResultText result={result} maxLines={10} />
		</>
	);
}
export const genericRenderer: ToolRenderer = {
	Summary: GenericSummary,
	Body: GenericBody,
};
