import type { Skill } from "../extensibility/skills";
import type { LocalProtocolOptions } from "./local-protocol";

export interface InternalResource {
	url: string;
	content: string;
	contentType: "text/markdown" | "application/json" | "text/plain";
	size?: number;
	sourcePath?: string;
	notes?: string[];
	immutable?: boolean;
	isDirectory?: boolean;
}

export interface UrlCompletion {
	value: string;
	label?: string;
	description?: string;
}

export interface InternalUrl extends URL {
	rawHost: string;
	rawPathname?: string;
}

export interface ResolveContext {
	cwd?: string;
	settings?: unknown;
	signal?: AbortSignal;
	localProtocolOptions?: LocalProtocolOptions;
	skills?: readonly Skill[];
	skipDirectoryListing?: boolean;
	pathOnly?: boolean;
}

export interface WriteContext {
	cwd?: string;
	signal?: AbortSignal;
	localProtocolOptions?: LocalProtocolOptions;
}

export interface ProtocolHandler {
	readonly scheme: string;
	readonly aliases?: readonly string[];
	readonly immutable: boolean;
	resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource>;
	write?(url: InternalUrl, content: string, context?: WriteContext): Promise<void>;
	complete?(query?: string, context?: ResolveContext): Promise<UrlCompletion[]>;
}
