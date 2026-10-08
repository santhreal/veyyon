import { formatCount } from "@veyyon/utils/format";
import { errorMessage } from "@veyyon/utils/type-guards";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { sync } from "../api";

export interface SyncButtonProps {
	onSyncStart?: () => void;
	onSyncComplete?: (result: { success: boolean; data?: SyncCounts; error?: string }) => void;
	className?: string;
}

type SyncCounts = { processed: number; files: number; totalMessages: number };

/** The counts a sync response reports, each missing or non-numeric one as 0. */
function syncCounts(data: Partial<Record<keyof SyncCounts, unknown>> | undefined): SyncCounts {
	return {
		processed: typeof data?.processed === "number" ? data.processed : 0,
		files: typeof data?.files === "number" ? data.files : 0,
		totalMessages: typeof data?.totalMessages === "number" ? data.totalMessages : 0,
	};
}

export function SyncButton({ onSyncStart, onSyncComplete, className = "" }: SyncButtonProps) {
	const [syncing, setSyncing] = useState(false);
	const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

	const handleSync = async () => {
		if (syncing) return;

		setSyncing(true);
		setStatus(null);
		onSyncStart?.();

		try {
			const result = syncCounts(await sync());
			setStatus({
				type: "success",
				message: `Synced: ${formatCount("new request", result.processed)} found.`,
			});
			onSyncComplete?.({ success: true, data: result });
		} catch (err) {
			const errorText = errorMessage(err);
			setStatus({
				type: "error",
				message: `Sync failed: ${errorText}`,
			});
			onSyncComplete?.({ success: false, error: errorText });
		} finally {
			setSyncing(false);
		}
	};

	return (
		<div className={`stats-sync-container ${className}`}>
			{status && (
				<span className="stats-sync-status-msg" data-type={status.type}>
					{status.message}
				</span>
			)}
			<button
				type="button"
				onClick={handleSync}
				disabled={syncing}
				className="stats-button stats-button-primary stats-sync-btn"
				aria-busy={syncing}
			>
				<RefreshCw size={14} className={`stats-sync-icon ${syncing ? "stats-spin" : ""}`} />
				{syncing ? "Syncing..." : "Sync DB"}
			</button>
		</div>
	);
}
