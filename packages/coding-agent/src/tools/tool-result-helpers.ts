import type { ImageContent, TextContent } from "@veyyon/ai";
import type { OutputMeta } from "./output-meta";

export type ToolContent = Array<TextContent | ImageContent>;

export type DetailsWithMeta = { meta?: OutputMeta };
