export interface HookEditorOptions {
	promptStyle?: boolean;
	presentation?: "card" | "embedded";
	onRequestRender?: () => void;
}

export const HOOK_EDITOR_TEXT_PAD_COLS = 1;
