/** Structure-pattern search results, rendered for unified `search`. */
import type { ReactNode } from "react";
import { Badge, Badges, CodeBlock, InvalidArg, Kv, KvGrid, Note, Output, PathText, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, normalizeWs, num, scopePaths, str, truncate } from "../util";

function patternsOf(args: Record<string, unknown>): string[] {
	const input = str(args.input);
	return input === null || input.trim().length === 0 ? [] : [input];
}

function Summary({ args }: ToolRenderProps): ReactNode {
	const patterns = patternsOf(args);
	if (patterns.length === 0) return <InvalidArg what="input" />;
	const paths = scopePaths(args);
	return (
		<>
			<span className="tv-pattern">{truncate(normalizeWs(patterns[0]!), 64)}</span>
			{patterns.length > 1 && <span className="tv-faint">+{patterns.length - 1}</span>}
			{paths.length > 0 && <PathText path={paths[0]!} />}
			{paths.length > 1 && <span className="tv-faint">+{paths.length - 1}</span>}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const patterns = patternsOf(args);
	const paths = scopePaths(args);
	const skip = num(args.skip);

	const details = detailsRecord(result);
	const matchCount = num(details?.matchCount);
	const fileCount = num(details?.fileCount);
	const filesSearched = num(details?.filesSearched);
	const limitReached = details?.limitReached === true;
	const scopePath = str(details?.scopePath);
	const error = str(details?.error);
	const parseErrors = Array.isArray(details?.parseErrors)
		? details.parseErrors.filter((e): e is string => typeof e === "string")
		: [];
	const parseErrorsTotal = num(details?.parseErrorsTotal) ?? parseErrors.length;

	const argBadges: ReactNode[] = [skip !== null && skip > 0 && <Badge key="skip">skip:{skip}</Badge>];
	const resultBadges: ReactNode[] =
		result && !result.isError
			? [
					matchCount !== null && (
						<Badge key="matches" tone={matchCount === 0 ? "warn" : "ok"}>
							{matchCount} {matchCount === 1 ? "match" : "matches"}
						</Badge>
					),
					fileCount !== null && fileCount > 0 && (
						<Badge key="files">
							{fileCount} {fileCount === 1 ? "file" : "files"}
						</Badge>
					),
					filesSearched !== null && <Badge key="searched">searched {filesSearched}</Badge>,
					limitReached && (
						<Badge key="limit" tone="warn">
							limit reached
						</Badge>
					),
				]
			: [];

	return (
		<>
			<Badges items={[...argBadges, ...resultBadges]} />
			{patterns.length === 0 ? (
				<InvalidArg what="input" />
			) : (
				patterns.map((pat, i) => <CodeBlock key={i} code={pat} title="pattern" maxLines={12} />)
			)}
			{(paths.length > 0 || scopePath) && (
				<KvGrid>
					{paths.length > 0 && (
						<Kv k={paths.length === 1 ? "path" : "paths"}>
							{paths.map((p, i) => (
								<span key={i}>
									{i > 0 && ", "}
									<PathText path={p} />
								</span>
							))}
						</Kv>
					)}
					{scopePath && (
						<Kv k="scope">
							<PathText path={scopePath} />
						</Kv>
					)}
				</KvGrid>
			)}
			{parseErrors.length > 0 && (
				<Output
					text={parseErrors.join("\n")}
					maxLines={6}
					title={
						parseErrorsTotal > parseErrors.length ? `parse issues (${parseErrorsTotal} total)` : "parse issues"
					}
				/>
			)}
			{error !== null && !result?.isError && <Note tone="err">{error}</Note>}
			<ResultText result={result} maxLines={12} />
		</>
	);
}

export const structureSearchRenderer: ToolRenderer = { Summary, Body };
