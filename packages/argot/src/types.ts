export interface AgentDict {
	promptFragment(): string;

	expand(text: string): string;
}

export interface HandleMeta {
	note?: string;
	scope?: string;
}

export interface Vocabulary {
	version: number;
	sigil: string;
	handles: Map<string, string>;
	meta: Map<string, HandleMeta>;
}
