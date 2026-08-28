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
 * `Markit.convert`, instead of the text-read fallback decoding their binary
 * bytes as garbage UTF-8. Adding an extension here without a converter that
 * `accepts()` it means files of that type always fail with `Unsupported format`.
 *
 * IT LIVES IN A LEAF MODULE WITH NO IMPORTS, and that is the whole point. The
 * routing gate is nine strings, but it used to be declared beside the converter
 * registry, so `read`, `fetch` and the CLI attachment path imported the registry
 * to read it — and the registry constructs every converter, which pulls in
 * mammoth, jszip, turndown, domino, bluebird and xmlbuilder. Both tools are
 * built during session startup, so a launch that never opened a document still
 * evaluated the entire document-conversion stack. `utils/markit.ts` already
 * loads the registry through a dynamic import for exactly that reason; this file
 * is what lets that deferral hold. Import the gate from here, never from the
 * registry.
 */
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
