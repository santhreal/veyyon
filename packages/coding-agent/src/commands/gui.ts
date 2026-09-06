/**
 * Start the GUI engine host server speaking the desktop JSON wire protocol.
 */
import { Args, Command, Flags } from "@veyyon/utils/cli";
import { startGuiHostServer } from "../gui-host";

export default class Gui extends Command {
	static description = "Start the GUI engine host server for desktop clients";

	static args = {
		endpoint: Args.string({
			description: "Endpoint address to bind (unix:<path> or tcp:<host>:<port>)",
			required: false,
		}),
	};

	static flags = {
		endpoint: Flags.string({
			char: "e",
			description: "Endpoint address to bind (unix:<path> or tcp:<host>:<port>)",
		}),
	};

	static examples = [
		"# Start GUI host with default unix socket in profile directory\n  veyyon gui",
		"# Start on a custom unix socket path\n  veyyon gui unix:/tmp/veyyon-gui.sock",
		"# Start on a TCP host:port\n  veyyon gui tcp:127.0.0.1:7654",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Gui);
		const endpoint = args.endpoint ?? flags.endpoint;

		const server = await startGuiHostServer({
			endpoint: endpoint ?? undefined,
			cwd: process.cwd(),
		});

		process.stdout.write(`GUI engine host listening at ${server.endpoint}\n`);
		process.stdout.write(`export VEYYON_GUI_ENDPOINT="${server.endpoint}"\n`);

		const shutdown = (): void => {
			void server.close().then(() => {
				process.exit(0);
			});
		};

		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	}
}
