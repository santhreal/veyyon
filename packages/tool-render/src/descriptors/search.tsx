import { formatCount } from "@veyyon/utils/format";
import type { ReactNode } from "react";
import { Badge, Badges, CodeBlock, InvalidArg, Kv, KvGrid, Note, Output, PathText, ResultText, Row } from "../parts";
import type { ToolDescriptor, ToolRenderProps } from "../types";
import {
	detailsRecord,
	finiteNumber,
	isRecord,
	keyed,
	normalizeWs,
	resultTextOf,
	scopePaths,
	shortenPath,
	str,
	strList,
	truncate,
} from "../util";

// ============================================================================
// file search helpers
// ============================================================================

function FileSearchSummary({ args }: ToolRenderProps): ReactNode {
	const input = str(args.input);
	if (input === null) return <InvalidArg what="input" />;
	return <span className="tv-pattern">{truncate(shortenPath(input), 120)}</span>;
}

function FileSearchBody({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const limit = finiteNumber(args.limit);
	const fileCount = finiteNumber(details?.fileCount);
	const resultLimit = finiteNumber(details?.resultLimitReached);
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

// ============================================================================
// text search helpers
// ============================================================================

function textPathsOf(args: Record<string, unknown>): string[] {
	const list = scopePaths(args).map(p => shortenPath(p));
	return list.length ? list : ["."];
}

function textArgBadges(args: Record<string, unknown>): ReactNode[] {
	const badges: ReactNode[] = [];
	if (args.case === true) badges.push("case");
	if (args.case === false) badges.push("no-case");
	if (args.gitignore === false) badges.push("no-gitignore");
	const skip = finiteNumber(args.skip);
	if (skip !== null && skip > 0) badges.push(`skip=${skip}`);
	return badges;
}

function TextPattern({ args }: { args: Record<string, unknown> }): ReactNode {
	const pattern = str(args.input);
	if (pattern === null || pattern.trim().length === 0) return <InvalidArg what="input" />;
	return <span className="tv-pattern">/{pattern}/</span>;
}

function TextSearchSummary({ args }: ToolRenderProps): ReactNode {
	const pattern = str(args.input);
	if (pattern === null || pattern.trim().length === 0) return <InvalidArg what="input" />;
	return (
		<span>
			<span className="tv-pattern">/{pattern}/</span> <span className="tv-muted">in</span>{" "}
			<span className="tv-path">{textPathsOf(args).join(", ")}</span> <Badges items={textArgBadges(args)} />
		</span>
	);
}

function TextSearchBody({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const matchCount = finiteNumber(details?.matchCount);
	const fileCount = finiteNumber(details?.fileCount);
	const truncated = details?.truncated === true;
	const error = str(details?.error);
	const missing: string[] = [];
	if (details && Array.isArray(details.missingPaths)) {
		for (const p of details.missingPaths) {
			if (typeof p === "string") missing.push(shortenPath(p));
		}
	}
	const badges = textArgBadges(args);
	if (matchCount !== null) badges.push(`${matchCount} ${matchCount === 1 ? "match" : "matches"}`);
	if (fileCount !== null) badges.push(`${fileCount} ${fileCount === 1 ? "file" : "files"}`);
	return (
		<>
			<div>
				<TextPattern args={args} /> <span className="tv-muted">in</span>{" "}
				<span className="tv-path">{textPathsOf(args).join(", ")}</span> <Badges items={badges} />
				{truncated && (
					<>
						{" "}
						<Badge tone="warn">truncated</Badge>
					</>
				)}
			</div>
			{missing.length > 0 && <Note tone="warn">skipped missing: {missing.join(", ")}</Note>}
			{error !== null && !resultTextOf(result).trim() && <Note tone="err">{error}</Note>}
			<ResultText result={result} maxLines={14} variant="code" />
		</>
	);
}

// ============================================================================
// structure search helpers
// ============================================================================

function patternsOf(args: Record<string, unknown>): string[] {
	const input = str(args.input);
	return input === null || input.trim().length === 0 ? [] : [input];
}

function StructureSearchSummary({ args }: ToolRenderProps): ReactNode {
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

function StructureSearchBody({ args, result }: ToolRenderProps): ReactNode {
	const patterns = patternsOf(args);
	const paths = scopePaths(args);
	const skip = finiteNumber(args.skip);

	const details = detailsRecord(result);
	const matchCount = finiteNumber(details?.matchCount);
	const fileCount = finiteNumber(details?.fileCount);
	const filesSearched = finiteNumber(details?.filesSearched);
	const limitReached = details?.limitReached === true;
	const scopePath = str(details?.scopePath);
	const error = str(details?.error);
	const parseErrors = Array.isArray(details?.parseErrors)
		? details.parseErrors.filter((e): e is string => typeof e === "string")
		: [];
	const parseErrorsTotal = finiteNumber(details?.parseErrorsTotal) ?? parseErrors.length;

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
				keyed(patterns, pat => pat).map(({ key, item: pat }) => (
					<CodeBlock key={key} code={pat} title="pattern" maxLines={12} />
				))
			)}
			{(paths.length > 0 || scopePath) && (
				<KvGrid>
					{paths.length > 0 && (
						<Kv k={paths.length === 1 ? "path" : "paths"}>
							{keyed(paths, p => p).map(({ key, item: p }, i) => (
								<span key={key}>
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

// ============================================================================
// search dispatcher
// ============================================================================

interface AdaptedSearchProps extends ToolRenderProps {
	searchType: string | null;
}

function adaptSearchProps(props: ToolRenderProps): AdaptedSearchProps {
	const details = detailsRecord(props.result);
	const searchType = str(props.args.type) ?? str(details?.type);
	const nestedDetails = details && isRecord(details.result) ? details.result : undefined;
	const result = props.result && nestedDetails ? { ...props.result, details: nestedDetails } : props.result;
	return { ...props, result, searchType };
}

function SearchSummary(props: ToolRenderProps): ReactNode {
	const adapted = adaptSearchProps(props);
	const { searchType } = adapted;
	if (searchType === "files") return <FileSearchSummary {...adapted} />;
	if (searchType === "text") return <TextSearchSummary {...adapted} />;
	if (searchType === "structure") return <StructureSearchSummary {...adapted} />;
	return <InvalidArg what="type" />;
}

function SearchBody(props: ToolRenderProps): ReactNode {
	const adapted = adaptSearchProps(props);
	const { searchType } = adapted;
	if (searchType === "files") return <FileSearchBody {...adapted} />;
	if (searchType === "text") return <TextSearchBody {...adapted} />;
	if (searchType === "structure") return <StructureSearchBody {...adapted} />;
	return (
		<>
			<InvalidArg what="type" />
			<ResultText result={props.result} maxLines={12} />
		</>
	);
}

// ============================================================================
// search_tool_bm25
// ============================================================================

interface Bm25Match {
	name: string;
	label: string;
	description: string;
	serverName: string | null;
	score: number | null;
}

function matchOf(value: unknown): Bm25Match | null {
	if (!isRecord(value)) return null;
	const name = str(value.name) ?? "";
	const label = str(value.label) ?? name;
	if (!label) return null;
	return {
		name,
		label,
		description: str(value.description) ?? "",
		serverName: str(value.server_name ?? value.serverName),
		score: finiteNumber(value.score),
	};
}

function SearchBm25Summary({ args, result }: ToolRenderProps): ReactNode {
	const query = str(args.query);
	const limit = finiteNumber(args.limit);
	const details = detailsRecord(result);
	const tools = details && Array.isArray(details.tools) ? details.tools : null;
	return (
		<>
			{query !== null ? (
				<span className="tv-pattern">{truncate(normalizeWs(query), 64) || "(empty query)"}</span>
			) : (
				<InvalidArg what="query" />
			)}
			{limit !== null && <Badge>limit:{limit}</Badge>}
			{tools && (
				<Badge tone={tools.length > 0 ? "ok" : "warn"}>
					{tools.length} match{tools.length === 1 ? "" : "es"}
				</Badge>
			)}
		</>
	);
}

function SearchBm25Body({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const query = str(details?.query) ?? str(args.query);
	const limit = finiteNumber(details?.limit) ?? finiteNumber(args.limit);
	const totalTools = finiteNumber(details?.total_tools);
	const activated = strList(details?.activated_tools);
	const activeSelected = strList(details?.active_selected_tools);
	const matches: Bm25Match[] = [];
	if (details && Array.isArray(details.tools)) {
		for (const item of details.tools) {
			const match = matchOf(item);
			if (match) matches.push(match);
		}
	}
	return (
		<>
			<KvGrid>
				<Kv k="query">
					{query !== null ? <span className="tv-pattern">{query}</span> : <InvalidArg what="query" />}
				</Kv>
				{limit !== null && <Kv k="limit">{limit}</Kv>}
				{details && (
					<Kv k="tools">
						{matches.length} matched
						{activeSelected.length > 0 && ` · ${activeSelected.length} active`}
						{totalTools !== null && ` · ${totalTools} total`}
					</Kv>
				)}
				{activated.length > 0 && (
					<Kv k="activated">
						<Badges items={activated} />
					</Kv>
				)}
			</KvGrid>
			{details && !result?.isError && matches.length === 0 && (
				<Note tone="warn">
					{totalTools === 0 ? "No discoverable tools are currently loaded." : "No matching tools found."}
				</Note>
			)}
			{matches.length > 0 && (
				<div className="tv-list">
					{keyed(matches, match => `${match.serverName ?? ""}\u001f${match.name}`).map(({ key, item: match }) => (
						<Row key={key} k={match.score !== null ? match.score.toFixed(3) : undefined}>
							<span className="tv-pattern">{match.label}</span>
							{match.serverName && <Badge>{match.serverName}</Badge>}
							{match.name && match.name !== match.label && <span className="tv-faint"> {match.name}</span>}
							{match.description && (
								<span className="tv-muted"> — {truncate(normalizeWs(match.description), 140)}</span>
							)}
						</Row>
					))}
				</div>
			)}
			{(!details || result?.isError) && <ResultText result={result} maxLines={10} />}
		</>
	);
}

// ============================================================================
// web_search
// ============================================================================

function getDomain(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

function formatAge(seconds: unknown): string {
	const s = finiteNumber(seconds);
	if (s === null || s < 0) return "";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 365) return `${d}d ago`;
	return `${Math.floor(d / 365)}y ago`;
}

function WebSearchSummary({ args }: ToolRenderProps): ReactNode {
	const query = str(args.query);
	const recency = str(args.recency);
	return (
		<>
			{query === null ? (
				<InvalidArg what="query" />
			) : (
				<span className="tv-pattern">{truncate(normalizeWs(query), 80)}</span>
			)}
			{recency && <Badge>{recency}</Badge>}
		</>
	);
}

function SourceRow({ source, index }: { source: Record<string, unknown>; index: number }): ReactNode {
	const url = str(source.url) ?? "";
	const title = str(source.title)?.trim() || url || "Untitled";
	const domain = url ? getDomain(url) : "";
	const age = formatAge(source.ageSeconds ?? source.age) || (str(source.publishedDate) ?? "");
	return (
		<Row k={String(index + 1)}>
			{url ? (
				<a href={url} rel="noreferrer" target="_blank">
					{title}
				</a>
			) : (
				title
			)}
			{domain && <span className="tv-faint"> ({domain})</span>}
			{age && <span className="tv-muted"> · {age}</span>}
		</Row>
	);
}

function WebSearchBody({ args, result }: ToolRenderProps): ReactNode {
	const query = str(args.query);
	const recency = str(args.recency);
	const limit = finiteNumber(args.limit);
	const numResults = finiteNumber(args.num_search_results);

	const details = detailsRecord(result);
	const response = details && isRecord(details.response) ? details.response : null;
	const errorMsg = details ? str(details.error) : null;
	const provider = response ? str(response.provider) : details ? str(details.provider) : null;
	const model = response ? str(response.model) : details ? str(details.model) : null;
	const authMode = response ? str(response.authMode) : details ? str(details.authMode) : null;
	const sources: Record<string, unknown>[] =
		response && Array.isArray(response.sources)
			? response.sources.filter(isRecord)
			: details && Array.isArray(details.sources)
				? details.sources.filter(isRecord)
				: [];

	let providerInfo = model && provider ? `${model} @ ${provider}` : (model ?? provider ?? "");
	if (providerInfo && authMode) {
		providerInfo += ` (${authMode === "oauth" ? "OAuth" : authMode === "api_key" ? "API" : authMode})`;
	}

	const usage =
		response && isRecord(response.usage) ? response.usage : details && isRecord(details.usage) ? details.usage : null;
	const usageParts: string[] = [];
	if (usage) {
		const inTok = finiteNumber(usage.inputTokens);
		const outTok = finiteNumber(usage.outputTokens);
		const totalTok = finiteNumber(usage.totalTokens);
		const searchReqs = finiteNumber(usage.searchRequests);
		if (inTok !== null) usageParts.push(`in ${inTok}`);
		if (outTok !== null) usageParts.push(`out ${outTok}`);
		if (totalTok !== null) usageParts.push(`total ${totalTok}`);
		if (searchReqs !== null) usageParts.push(`search ${searchReqs}`);
	}

	return (
		<>
			<Badges
				items={[
					recency && `recency=${recency}`,
					limit !== null && `limit=${limit}`,
					numResults !== null && `results=${numResults}`,
					(response || details) && formatCount("source", sources.length),
				]}
			/>
			{(query !== null || providerInfo || usageParts.length > 0) && (
				<KvGrid>
					{query !== null && <Kv k="query">{query}</Kv>}
					{providerInfo && <Kv k="provider">{providerInfo}</Kv>}
					{usageParts.length > 0 && <Kv k="usage">{usageParts.join(" · ")}</Kv>}
				</KvGrid>
			)}
			{errorMsg && !resultTextOf(result) && <Note tone="err">{errorMsg}</Note>}
			<ResultText result={result} maxLines={14} lang="markdown" />
			{sources.length > 0 && (
				<div className="tv-list">
					{sources.map((source, i) => (
						<SourceRow key={str(source.url) ?? i} source={source} index={i} />
					))}
				</div>
			)}
		</>
	);
}

// ============================================================================
// Exports
// ============================================================================

export const searchDescriptors: readonly ToolDescriptor[] = [
	{ name: "search", Summary: SearchSummary, Body: SearchBody },
	{ name: "search_tool_bm25", Summary: SearchBm25Summary, Body: SearchBm25Body },
	{ name: "web_search", Summary: WebSearchSummary, Body: WebSearchBody },
];
