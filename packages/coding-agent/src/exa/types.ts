import type { TSchema } from "@veyyon/ai";

export interface MCPTool {
	name: string;
	description: string;
	inputSchema: TSchema;
}

export interface MCPToolWrapperConfig {
	name: string;
	label: string;
	mcpToolName: string;
	isWebsetsTool?: boolean;
}

export interface MCPToolsResponse {
	result?: {
		tools: MCPTool[];
	};
	error?: {
		code: number;
		message: string;
	};
}

export interface MCPCallResponse {
	result?: {
		content?: Array<{ type: string; text?: string }>;
	};
	error?: {
		code: number;
		message: string;
	};
}

export interface ExaSearchResult {
	id?: string;
	title?: string;
	url?: string;
	author?: string;
	publishedDate?: string;
	text?: string;
	highlights?: string[];
	image?: string;
	favicon?: string;
}

export interface ExaSearchResponse {
	results?: ExaSearchResult[];
	statuses?: Array<{ id: string; status: string; source?: string }>;
	costDollars?: { total: number };
	searchTime?: number;
	requestId?: string;
}
