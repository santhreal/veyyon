export interface HistoryEntry {
	id: number;
	prompt: string;
	created_at: number;
	cwd?: string;
	sessionId?: string;
}

export type HistoryRow = {
	id: number;
	prompt: string;
	created_at: number;
	cwd: string | null;
	session_id: string | null;
};
