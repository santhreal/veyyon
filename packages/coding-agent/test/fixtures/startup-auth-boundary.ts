import * as path from "node:path";
import { postmortem } from "@veyyon/utils";
import LaunchCommand from "../../src/commands/launch";

try {
	const command = new LaunchCommand(process.argv.slice(2), {
		bin: "veyyon",
		version: "1.0.0",
		commands: new Map([["", LaunchCommand]]),
	});
	await command.run();
	const loaded = Object.keys(require.cache);
	const evaluated = (relative: string): boolean =>
		loaded.some(file => path.normalize(file).endsWith(path.join("coding-agent", "src", relative)));
	process.stdout.write(
		`${JSON.stringify({
			authLoaded: evaluated("modes/acp/terminal-auth.ts"),
			launchCardLoaded: evaluated("cli/launch-card.ts"),
			mainLoaded: evaluated("main.ts"),
		})}\n`,
	);
} finally {
	await postmortem.cleanup();
}
