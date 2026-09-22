/**
 * A collab guest for a recorded take, so a share surface is photographed with
 * somebody actually on the other end of it.
 *
 * Speaks the wire protocol rather than a stand-in for it: the link grammar, the
 * envelope, the AES-256-GCM seal and the `hello` frame all come from
 * `@veyyon/wire`, which is where the host that minted the link reads them from.
 * A scene that faked a participant row would photograph the fake.
 *
 * Usage, with the link on argv:
 *
 *   bun proof/lib/collab-guest.ts '<link>' --name=Wren
 *
 * Prints one line per event on stdout (`joined`, `welcome <entries>`, `left`)
 * and holds the connection open until SIGINT or SIGTERM, which is what a take
 * needs: the participant stays in the roster while the shot is composed.
 *
 * `--read-only` drops the write token, joining as a viewer even when the link
 * carries one, so a take can photograph both kinds of row.
 */
import {
	COLLAB_PROTO,
	encodeBase64Url,
	importRoomKey,
	packEnvelope,
	parseCollabLink,
	sealFrame,
} from "@veyyon/wire";

interface GuestOptions {
	link: string;
	name: string;
	readOnly: boolean;
}

function parseArgs(argv: string[]): GuestOptions | { error: string } {
	let link = "";
	let name = "Guest";
	let readOnly = false;
	for (const arg of argv) {
		if (arg.startsWith("--name=")) name = arg.slice("--name=".length);
		else if (arg === "--read-only") readOnly = true;
		else if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
		else if (!link) link = arg;
		else return { error: `unexpected argument ${arg}` };
	}
	if (!link) return { error: "a link is required" };
	if (!name) return { error: "--name cannot be empty" };
	return { link, name, readOnly };
}

async function join(options: GuestOptions): Promise<number> {
	const parsed = parseCollabLink(options.link);
	if ("error" in parsed) {
		console.error(`collab-guest: ${parsed.error}`);
		return 2;
	}
	const key = await importRoomKey(parsed.key);
	const socket = new WebSocket(`${parsed.wsUrl}?role=guest`);
	socket.binaryType = "arraybuffer";

	const closed = Promise.withResolvers<number>();
	socket.addEventListener("open", () => {
		const writeToken =
			options.readOnly || !parsed.writeToken ? undefined : encodeBase64Url(parsed.writeToken);
		sealFrame(key, { t: "hello", proto: COLLAB_PROTO, name: options.name, writeToken })
			.then(sealed => {
				socket.send(packEnvelope(0, sealed));
				console.log("joined");
			})
			.catch((reason: unknown) => {
				console.error(`collab-guest: the hello frame was not sent: ${String(reason)}`);
				socket.close();
			});
	});
	// The frames the host sends back are sealed with the same key, and a take
	// reads the roster off the window rather than out of this process, so they
	// are counted and not opened. `welcome` is the one that matters: it is the
	// proof the host accepted this peer rather than merely the relay.
	let frames = 0;
	socket.addEventListener("message", () => {
		frames += 1;
		if (frames === 1) console.log("welcome");
	});
	socket.addEventListener("close", event => {
		console.log(`left ${event.code}`);
		closed.resolve(event.code >= 4000 ? 1 : 0);
	});
	socket.addEventListener("error", () => {
		console.error("collab-guest: the relay connection failed");
	});

	const stop = (): void => socket.close();
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	return closed.promise;
}

if (import.meta.main) {
	const options = parseArgs(process.argv.slice(2));
	if ("error" in options) {
		console.error(`collab-guest: ${options.error}`);
		process.exit(2);
	}
	process.exit(await join(options));
}
