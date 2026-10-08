/**
 * Entry point for the self-contained tool-view bundle embedded in HTML
 * session exports (built by scripts/build-tool-views.ts; React included).
 * Importing registers `<vey-tool-view>` and publishes `formatToolCallLabel`
 * as a global, which the export's session tree calls for each tool call.
 */
import { formatToolCallLabel } from "@veyyon/utils/tool-call-label";
import { defineToolViewElement } from "./element";

defineToolViewElement();
Object.assign(globalThis, { formatToolCallLabel });
