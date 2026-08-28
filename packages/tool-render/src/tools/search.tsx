import type { ReactNode } from "react";
import { InvalidArg, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, str } from "../util";
import { fileSearchRenderer } from "./file-search";
import { structureSearchRenderer } from "./structure-search";
import { textSearchRenderer } from "./text-search";

function adaptedProps(props: ToolRenderProps): { renderer: ToolRenderer; props: ToolRenderProps } | null {
	const details = detailsRecord(props.result);
	const searchType = str(props.args.type) ?? str(details?.type);
	const nestedDetails = details && isRecord(details.result) ? details.result : undefined;
	const result = props.result && nestedDetails ? { ...props.result, details: nestedDetails } : props.result;

	const adapted = { ...props, result };
	if (searchType === "files") return { renderer: fileSearchRenderer, props: adapted };
	if (searchType === "text") return { renderer: textSearchRenderer, props: adapted };
	if (searchType === "structure") return { renderer: structureSearchRenderer, props: adapted };
	return null;
}

function Summary(props: ToolRenderProps): ReactNode {
	const adapted = adaptedProps(props);
	if (!adapted) return <InvalidArg what="type" />;
	const TypeSummary = adapted.renderer.Summary;
	return <TypeSummary {...adapted.props} />;
}

function Body(props: ToolRenderProps): ReactNode {
	const adapted = adaptedProps(props);
	if (!adapted) {
		return (
			<>
				<InvalidArg what="type" />
				<ResultText result={props.result} maxLines={12} />
			</>
		);
	}
	const TypeBody = adapted.renderer.Body;
	return TypeBody ? <TypeBody {...adapted.props} /> : null;
}

export const searchRenderer: ToolRenderer = { Summary, Body };
