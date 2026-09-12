import { useMemo } from "react";
import { getRecentErrors } from "../api";
import { createMessageColumns, renderMessageMobileCard } from "../components/requests-table-shared";
import { useResource } from "../data/useResource";
import type { MessageStats, TimeRange } from "../types";
import { AsyncBoundary, DataTable, Panel } from "../ui";

export interface ErrorsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
	onRequestClick: (id: number) => void;
}

export function ErrorsRoute({ active, refreshTrigger, onRequestClick }: ErrorsRouteProps) {
	const {
		data: recentErrors,
		error,
		loading,
	} = useResource(["recent-errors-dense", refreshTrigger], signal => getRecentErrors(50, signal), {
		pollMs: 30000,
		enabled: active,
	});

	const columns = useMemo(() => createMessageColumns(true), []);

	return (
		<div className="stats-route-container">
			<Panel title="Recent Errors" subtitle="Up to 50 most recent failed requests in the stats database">
				<AsyncBoundary loading={loading} error={error} data={recentErrors}>
					{recentErrors && (
						<DataTable<MessageStats>
							columns={columns}
							data={recentErrors}
							keyExtractor={item => item.id ?? `${item.sessionFile}-${item.entryId}`}
							onRowClick={item => {
								if (item.id !== undefined) onRequestClick(item.id);
							}}
							renderMobileCard={(item, onClick) => renderMessageMobileCard(item, onClick, true)}
						/>
					)}
				</AsyncBoundary>
			</Panel>
		</div>
	);
}
