export const BACKTICK_LEAD = /^ {0,3}(`*)([\s\S]*)$/;
export const LANG_TOKEN = /^[A-Za-z0-9_+#-]+$/;

export interface FencedThinkingResult {
	readonly thinking: string;
	readonly closed: boolean;
	readonly rest: string;
}
