import { useMemo } from "react";
import { getRecentRequests } from "../api";
import { createMessageColumns, renderMessageMobileCard } from "../components/requests-table-shared";
import { useResource } from "../data/useResource";
import type { MessageStats, TimeRange } from "../types";
import { AsyncBoundary, DataTable, Panel } from "../ui";

export interface RequestsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
	onRequestClick: (id: number) => void;
}

export function RequestsRoute({ active, refreshTrigger, onRequestClick }: RequestsRouteProps) {
	const {
		data: recentRequests,
		error,
		loading,
	} = useResource(["recent-requests-dense", refreshTrigger], signal => getRecentRequests(50, signal), {
		pollMs: 30000,
		enabled: active,
	});

	const columns = useMemo(() => createMessageColumns(), []);

	return (
		<div className="stats-route-container">
			<Panel title="All Recent Requests" subtitle="Up to 50 most recent requests processed by Veyyon">
				<AsyncBoundary loading={loading} error={error} data={recentRequests}>
					{recentRequests && (
						<DataTable<MessageStats>
							columns={columns}
							data={recentRequests}
							keyExtractor={item => item.id ?? `${item.sessionFile}-${item.entryId}`}
							onRowClick={item => {
								if (item.id !== undefined) onRequestClick(item.id);
							}}
							renderMobileCard={renderMessageMobileCard}
						/>
					)}
				</AsyncBoundary>
			</Panel>
		</div>
	);
}
