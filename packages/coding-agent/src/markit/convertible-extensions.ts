// Adapted from markit-ai (MIT). See ./NOTICE.

/** Routing gate for the markit document pipeline. Single source of truth for callers that decide whether to hand a file to markit before markit itself */
export const CONVERTIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
	".pdf",
	".doc",
	".docx",
	".ppt",
	".pptx",
	".xls",
	".xlsx",
	".rtf",
	".epub",
]);
