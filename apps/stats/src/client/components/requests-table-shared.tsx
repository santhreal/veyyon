import type React from "react";
import { formatCost, formatDurationMs, formatInteger, formatRelativeTime } from "../data/formatters";
import type { MessageStats } from "../types";
import { type DataTableColumn, StatusPill } from "../ui";

export function createMessageColumns(isErrorRoute?: boolean): DataTableColumn<MessageStats>[] {
	if (isErrorRoute) {
		return [
			{
				key: "model",
				header: "Model",
				render: (item: MessageStats) => (
					<div>
						<div className="stats-font-medium stats-text-primary">{item.model}</div>
						<div className="stats-text-xs stats-text-muted">{item.provider}</div>
					</div>
				),
			},
			{
				key: "timestamp",
				header: "Time",
				render: (item: MessageStats) => formatRelativeTime(item.timestamp),
			},
			{
				key: "errorMessage",
				header: "Error Message",
				render: (item: MessageStats) => (
					<div
						className="stats-text-xs stats-text-danger stats-truncate stats-max-w-md stats-font-mono"
						title={item.errorMessage || ""}
					>
						{item.errorMessage || "Unknown error"}
					</div>
				),
			},
			{
				key: "tokens",
				header: "Tokens",
				numeric: true,
				render: (item: MessageStats) => formatInteger(item.usage.totalTokens),
			},
			{
				key: "cost",
				header: "Cost",
				numeric: true,
				render: (item: MessageStats) => formatCost(item.usage.cost.total, 4),
			},
		];
	}

	return [
		{
			key: "model",
			header: "Model",
			render: (item: MessageStats) => (
				<div>
					<div className="stats-font-medium stats-text-primary">{item.model}</div>
					<div className="stats-text-xs stats-text-muted">{item.provider}</div>
				</div>
			),
		},
		{
			key: "timestamp",
			header: "Time",
			render: (item: MessageStats) => formatRelativeTime(item.timestamp),
		},
		{
			key: "tokens",
			header: "Tokens",
			numeric: true,
			render: (item: MessageStats) => formatInteger(item.usage.totalTokens),
		},
		{
			key: "cost",
			header: "Cost",
			numeric: true,
			render: (item: MessageStats) => formatCost(item.usage.cost.total, 4),
		},
		{
			key: "duration",
			header: "Duration",
			numeric: true,
			render: (item: MessageStats) => formatDurationMs(item.duration),
		},
		{
			key: "status",
			header: "Status",
			className: "stats-text-center",
			render: (item: MessageStats) => (
				<StatusPill variant={item.errorMessage ? "danger" : "success"}>
					{item.errorMessage ? "Failed" : "Success"}
				</StatusPill>
			),
		},
	];
}

export function renderMessageMobileCard(
	item: MessageStats,
	onClick?: () => void,
	isErrorRoute?: boolean,
): React.ReactNode {
	if (isErrorRoute) {
		return (
			<div className="stats-mobile-card stats-border-danger" onClick={onClick}>
				<div className="stats-mobile-card-header">
					<div>
						<div className="stats-font-semibold stats-text-primary">{item.model}</div>
						<div className="stats-text-xs stats-text-muted">{item.provider}</div>
					</div>
					<StatusPill variant="danger">Failed</StatusPill>
				</div>
				<div className="stats-mobile-card-grid">
					<div>
						<div className="stats-mobile-card-label">Time</div>
						<div className="stats-mobile-card-value">{formatRelativeTime(item.timestamp)}</div>
					</div>
					<div>
						<div className="stats-mobile-card-label">Cost</div>
						<div className="stats-mobile-card-value">{formatCost(item.usage.cost.total, 4)}</div>
					</div>
					<div>
						<div className="stats-mobile-card-label">Tokens</div>
						<div className="stats-mobile-card-value">{formatInteger(item.usage.totalTokens)}</div>
					</div>
				</div>
				{item.errorMessage && (
					<div className="stats-mobile-card-error mt-2 stats-font-mono">{item.errorMessage}</div>
				)}
			</div>
		);
	}

	return (
		<div className="stats-mobile-card" onClick={onClick}>
			<div className="stats-mobile-card-header">
				<div>
					<div className="stats-font-semibold stats-text-primary">{item.model}</div>
					<div className="stats-text-xs stats-text-muted">{item.provider}</div>
				</div>
				<StatusPill variant={item.errorMessage ? "danger" : "success"}>
					{item.errorMessage ? "Failed" : "Success"}
				</StatusPill>
			</div>
			<div className="stats-mobile-card-grid">
				<div>
					<div className="stats-mobile-card-label">Time</div>
					<div className="stats-mobile-card-value">{formatRelativeTime(item.timestamp)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Cost</div>
					<div className="stats-mobile-card-value">{formatCost(item.usage.cost.total, 4)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Tokens</div>
					<div className="stats-mobile-card-value">{formatInteger(item.usage.totalTokens)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Duration</div>
					<div className="stats-mobile-card-value">{formatDurationMs(item.duration)}</div>
				</div>
			</div>
			{item.errorMessage && <div className="stats-mobile-card-error truncate mt-2">{item.errorMessage}</div>}
		</div>
	);
}
