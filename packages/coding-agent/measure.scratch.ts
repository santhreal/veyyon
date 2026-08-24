import { estimateTokensFromText } from "@veyyon/utils";
import { renderToolExamples } from "@veyyon/ai/dialect/examples";
import { toolsPrompts } from "./src/prompts/tools/rows";
import { LaunchTool } from "./src/tools/launch";
const tool = new LaunchTool({} as never);
console.log("restored tokens:", estimateTokensFromText(tool.description));
console.log("restored bytes:", tool.description.length + renderToolExamples(tool as never, "xml", "i").length);
console.log("md bytes:", (await Bun.file("./src/prompts/tools/launch.md")).size);
