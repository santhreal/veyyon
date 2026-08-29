import type { SelectItem } from "@veyyon/tui";
import { type RollbackRow, rollbackMarkers, rollbackPublishedDate, type UrlOpener } from "../../cli/rollback-cli";

export const CHANGELOG_KEY = "c";

export function describeRollbackRow(row: RollbackRow): string {
	return [rollbackPublishedDate(row.publishedAt), ...rollbackMarkers(row)].filter(part => part.length > 0).join(" · ");
}

export function rollbackSelectItems(rows: readonly RollbackRow[]): SelectItem[] {
	return rows.map(row => ({
		value: row.version,
		label: row.version,
		description: describeRollbackRow(row),
		filterText: row.version,
	}));
}

export interface RollbackPickerCallbacks {
	onSelect: (version: string) => void;
	onCancel: () => void;
	openUrl: UrlOpener;
}
