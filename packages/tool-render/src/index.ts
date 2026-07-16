/**
 * Shared tool-call React renderers (registry + per-tool views + chrome).
 * Host shells (`element.tsx` / `standalone.tsx`) stay in coding-agent and collab-web.
 */

export { genericRenderer } from "./generic";
export * from "./parts";
export * from "./registry";
export * from "./ToolView";
export * from "./types";
export * from "./util";
