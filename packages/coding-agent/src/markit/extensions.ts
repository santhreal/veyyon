// Adapted from markit-ai (MIT). See ./NOTICE.

/**
 * Routing gate for the markit document pipeline. Single source of truth for
 * callers that decide whether to hand a file to markit before markit itself
 * ever sees it (CLI attachment handling, `read`/`fetch` content-type sniffing).
 *
 * This is NOT a promise that every listed extension converts successfully. Only
 * `.pdf`, `.docx`, `.pptx`, `.xlsx`, and `.epub` have a registered converter. The
 * legacy binary formats `.doc`, `.ppt`, `.xls`, and `.rtf` are listed on purpose
 * so callers route them here and get a clean `Unsupported format` error from
 * {@link Markit.convert}, instead of the text-read fallback decoding their binary
 * bytes as garbage UTF-8. Adding an extension here without a converter that
 * `accepts()` it means files of that type always fail with `Unsupported format`.
 */
export const CONVERTIBLE_EXTENSIONS = new Set([
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
