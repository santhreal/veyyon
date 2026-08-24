import { estimateTokensFromText } from "@veyyon/utils";
const md = await Bun.file(process.env.HOME + "/../main-launch.md").text().catch(() => null);
