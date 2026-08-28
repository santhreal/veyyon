export const MAX_PROVIDER_ERROR_DETAIL_CHARS = 4096;

export const NO_PROVIDER_ERROR_DETAIL = "(no detail)";

export function boundProviderErrorDetail(detail: string): string {
	const trimmed = detail.trim();
	if (trimmed.length === 0) return NO_PROVIDER_ERROR_DETAIL;
	if (trimmed.length <= MAX_PROVIDER_ERROR_DETAIL_CHARS) return trimmed;
	return `${trimmed.slice(0, MAX_PROVIDER_ERROR_DETAIL_CHARS)} [truncated, ${trimmed.length} chars total]`;
}
