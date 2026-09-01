export type NoticeSeverity = "warning" | "error";
export interface OperatorNotice {
	severity: NoticeSeverity;
	source: string;
	text: string;
	at: number;
}

export type NoticeSink = (notice: OperatorNotice) => void;

export function formatNotice(notice: OperatorNotice): string {
	return `${notice.source}: ${notice.text}`;
}

export function stderrNoticeSink(notice: OperatorNotice): void {
	const label = notice.severity === "error" ? "error" : "warning";
	process.stderr.write(`${label}: ${formatNotice(notice)}\n`);
}
