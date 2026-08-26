// Adapted from markit-ai (MIT). See ./NOTICE.

const convertibleExtensions = [".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".rtf", ".epub"];
/** Routing gate for markit: extensions callers hand to markit before it sees them. Only `.pdf/.docx/.pptx/.xlsx/.epub` have converters; legacy formats route here to fail with `Unsupported format` instead of binary garbage. */
export const CONVERTIBLE_EXTENSIONS = new Set(convertibleExtensions);
