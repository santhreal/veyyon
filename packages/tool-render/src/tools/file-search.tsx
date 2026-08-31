/** File-pattern search results, rendered for unified `search`. */
import { formatCount } from "@veyyon/utils/format";
import type { ReactNode } from "react";
import { Badge, Badges, InvalidArg, Note, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, num, shortenPath, str, truncate } from "../util";

function inputOf(args: Record<string, unknown>): string | null {
	return str(args.input);
}

function Summary({ args }: ToolRenderProps): ReactNode {
	const input = inputOf(args);
	if (input === null) return <InvalidArg what="input" />;
	return <span className="tv-pattern">{truncate(shortenPath(input), 120)}</span>;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const limit = num(args.limit);
	const fileCount = num(details?.fileCount);
	const resultLimit = num(details?.resultLimitReached);
	const scopePath = str(details?.scopePath);
	const error = str(details?.error);
	const meta = details && isRecord(details.meta) ? details.meta : null;
	const limits = meta && isRecord(meta.limits) ? meta.limits : null;
	const truncated =
		Boolean(details?.truncated) ||
		resultLimit !== null ||
		(details !== null && isRecord(details.truncation)) ||
		(meta !== null && isRecord(meta.truncation)) ||
		Boolean(limits?.resultLimit);
	const missing = Array.isArray(details?.missingPaths)
		? details.missingPaths.filter((p): p is string => typeof p === "string")
		: [];

	return (
		<>
			<Badges
				items={[
					limit !== null && <Badge>limit {limit}</Badge>,
					args.gitignore === false && <Badge>no-gitignore</Badge>,
					args.hidden === false && <Badge>no-hidden</Badge>,
					fileCount !== null && <Badge tone="accent">{formatCount("file", fileCount)}</Badge>,
					scopePath !== null && <Badge>in {shortenPath(scopePath)}</Badge>,
					truncated && (
						<Badge tone="warn">{resultLimit !== null ? `truncated at ${resultLimit}` : "truncated"}</Badge>
					),
				]}
			/>
			{missing.length > 0 && <Note tone="warn">skipped missing: {missing.map(p => shortenPath(p)).join(", ")}</Note>}
			{error !== null && !result?.isError && <Note tone="err">{error}</Note>}
			<ResultText result={result} maxLines={12} />
		</>
	);
}

export const fileSearchRenderer: ToolRenderer = { Summary, Body };
