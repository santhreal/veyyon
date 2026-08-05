import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage, urlScheme } from "@veyyon/utils";
import type { Skill } from "../extensibility/skills";
// Owners, not the `internal-urls` barrel: the barrel re-exports every protocol
// handler and reaches hundreds of modules.
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import { InternalUrlRouter } from "../internal-urls/router";
import type { InternalResource, ResolveContext } from "../internal-urls/types";
import { normalizeLocalScheme } from "./path-utils";
import { ToolError } from "./tool-errors";

const INTERNAL_URL_PATTERN_INCLUDING_NORMALIZED_LOCAL =
	/'(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^'\s")`\\]+'|"(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^"\s')`\\]+"|(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^\s'")`\\]+|'local:\/[^'\s")`\\]+'|"local:\/[^"\s')`\\]+"|(?<![./\\\\\w-])local:\/[^\s'")`\\]+/g;

const SUPPORTED_INTERNAL_SCHEMES = ["skill", "agent", "artifact", "plan", "memory", "rule", "local"] as const;

type SupportedInternalScheme = (typeof SUPPORTED_INTERNAL_SCHEMES)[number];

interface InternalUrlResolver {
	canHandle(input: string): boolean;
	resolve(input: string, context?: ResolveContext): Promise<InternalResource>;
}

export interface InternalUrlExpansionOptions {
	/**
	 * The calling session's resolved skills, or `undefined` when it never resolved them.
	 *
	 * The two are not interchangeable. `[]` is an assertion that the session HAS no skills,
	 * and `skill-protocol.ts` honors it (`context?.skills ?? getActiveSkills()`), so an empty
	 * array suppresses the process-wide snapshot and every `skill://` reports
	 * "Unknown skill: X / Available: none". Callers that do not know MUST pass `undefined`.
	 */
	skills: readonly Skill[] | undefined;
	noEscape?: boolean;
	internalRouter?: InternalUrlResolver;
	localOptions?: LocalProtocolOptions;
	cwd?: string;
	ensureLocalParentDirs?: boolean;
}

function extractScheme(url: string): SupportedInternalScheme | undefined {
	const scheme = urlScheme(url);
	if (!scheme || !SUPPORTED_INTERNAL_SCHEMES.includes(scheme as SupportedInternalScheme)) return undefined;
	return scheme as SupportedInternalScheme;
}

function unquoteToken(token: string): string {
	if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
		return token.slice(1, -1);
	}
	return token;
}

function isInsideShellQuote(command: string, index: number): boolean {
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < index; i++) {
		const char = command[i];
		if (char === "\\" && quote !== "'") {
			i++;
			continue;
		}
		if (char === "'" && quote !== '"') {
			quote = quote === "'" ? undefined : "'";
			continue;
		}
		if (char === '"' && quote !== "'") {
			quote = quote === '"' ? undefined : '"';
		}
	}
	return quote !== undefined;
}

function isEmbeddedInQuotedText(command: string, token: string, index: number): boolean {
	if (token.startsWith("'") || token.startsWith('"')) return false;
	return isInsideShellQuote(command, index);
}

/** Shell-escape a path using single quotes. */
function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

async function resolveInternalUrlToPath(
	rawUrl: string,
	skills: readonly Skill[] | undefined,
	internalRouter: InternalUrlResolver,
	localOptions?: LocalProtocolOptions,
	ensureLocalParentDirs?: boolean,
	cwd?: string,
): Promise<string> {
	const url = normalizeLocalScheme(rawUrl);
	const scheme = extractScheme(url);
	if (!scheme) {
		throw new ToolError(`Unsupported internal URL in bash command: ${url}`);
	}

	if (scheme === "local") {
		if (!localOptions) {
			throw new ToolError(
				"Cannot resolve local:// URL in bash command: local protocol options are unavailable for this session.",
			);
		}
		const resolvedLocalPath = resolveLocalUrlToPath(url, localOptions);
		if (ensureLocalParentDirs) {
			await fs.mkdir(path.dirname(resolvedLocalPath), { recursive: true });
		}
		return resolvedLocalPath;
	}

	if (!internalRouter.canHandle(url)) {
		throw new ToolError(
			`Cannot resolve ${scheme}:// URL in bash command: ${url}\n` +
				"Internal URL router is unavailable for this protocol in the current session.",
		);
	}

	let resource: InternalResource;
	try {
		resource = await internalRouter.resolve(url, { cwd, pathOnly: true, skills });
	} catch (error) {
		const message = errorMessage(error);
		throw new ToolError(`Failed to resolve ${scheme}:// URL in bash command: ${url}\n${message}`);
	}

	if (!resource.sourcePath) {
		throw new ToolError(`${scheme}:// URL resolved without a filesystem path and cannot be used in bash: ${url}`);
	}

	return path.resolve(resource.sourcePath);
}

/**
 * Expand supported internal URLs in a bash command string to shell-escaped absolute paths.
 * Unresolvable URLs and literal mentions inside larger quoted text are left unchanged.
 * Supported schemes: skill://, agent://, artifact://, memory://, rule://, local://
 */
export async function expandInternalUrls(command: string, options: InternalUrlExpansionOptions): Promise<string> {
	if (!command.includes("://") && !command.includes("local:/")) return command;

	const matches = Array.from(command.matchAll(INTERNAL_URL_PATTERN_INCLUDING_NORMALIZED_LOCAL));
	if (matches.length === 0) return command;
	const internalRouter = options.internalRouter ?? InternalUrlRouter.instance();

	let expanded = command;
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		const token = match[0];
		const index = match.index;
		if (index === undefined) continue;

		if (isEmbeddedInQuotedText(command, token, index)) continue;

		const rawUrl = unquoteToken(token);
		const url = normalizeLocalScheme(rawUrl);
		let resolvedPath: string;
		try {
			resolvedPath = await resolveInternalUrlToPath(
				url,
				options.skills,
				internalRouter,
				options.localOptions,
				options.ensureLocalParentDirs,
				options.cwd,
			);
		} catch {
			continue;
		}
		const replacement = options.noEscape ? resolvedPath : shellEscape(resolvedPath);
		expanded = `${expanded.slice(0, index)}${replacement}${expanded.slice(index + token.length)}`;
	}

	return expanded;
}
