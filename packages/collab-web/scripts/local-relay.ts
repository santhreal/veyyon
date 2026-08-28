import { RELAY_FATAL_CLOSE_REASONS } from "@veyyon/wire/relay";
import { rewriteEnvelopePeer, unpackEnvelope } from "../src/lib/link";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;

const DEFAULT_PORT = 7466;

interface SocketData {
	roomId: string;
	role: "host" | "guest";
	peerId: number;
}

type RelaySocket = Bun.ServerWebSocket<SocketData>;

interface Room {
	host: RelaySocket;
	guests: Map<number, RelaySocket>;
	nextPeerId: number;
}

export interface LocalRelay {
	url: string;
	stop(): void;
}

export function startLocalRelay(port = 0): LocalRelay {
	const rooms = new Map<string, Room>();

	const server = Bun.serve({
		port,
		fetch(req, srv): Response | undefined {
			const url = new URL(req.url);
			const match = ROOM_PATH_RE.exec(url.pathname);
			const role = url.searchParams.get("role");
			if (!match || (role !== "host" && role !== "guest")) {
				return new Response("not found", { status: 404 });
			}
			const data: SocketData = { roomId: match[1]!, role, peerId: 0 };
			if (srv.upgrade(req, { data })) return undefined;
			return new Response("websocket upgrade required", { status: 426 });
		},
		websocket: {
			open(ws: RelaySocket): void {
				const { roomId, role } = ws.data;
				if (role === "host") {
					if (rooms.has(roomId)) {
						ws.close(4009, RELAY_FATAL_CLOSE_REASONS[4009] as string);
						return;
					}
					rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
					return;
				}
				const room = rooms.get(roomId);
				if (!room) {
					ws.close(4004, RELAY_FATAL_CLOSE_REASONS[4004] as string);
					return;
				}
				const peerId = room.nextPeerId++;
				ws.data.peerId = peerId;
				room.guests.set(peerId, ws);
				room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
			},
			message(ws: RelaySocket, message: string | Buffer): void {
				if (typeof message === "string") return; // clients never send TEXT
				const room = rooms.get(ws.data.roomId);
				if (!room) return;
				if (ws.data.role === "host") {
					const envelope = unpackEnvelope(message);
					if (!envelope) return;
					if (envelope.peerId === 0) {
						for (const guest of room.guests.values()) guest.send(message);
					} else {
						room.guests.get(envelope.peerId)?.send(message);
					}
					return;
				}
				if (message.byteLength < 4) return;
				rewriteEnvelopePeer(message, ws.data.peerId);
				room.host.send(message);
			},
			close(ws: RelaySocket): void {
				const { roomId, role, peerId } = ws.data;
				const room = rooms.get(roomId);
				if (!room) return;
				if (role === "host") {
					if (room.host !== ws) return;
					rooms.delete(roomId);
					const closure = JSON.stringify({ t: "room-closed" });
					for (const guest of room.guests.values()) {
						guest.send(closure);
						guest.close(4001, RELAY_FATAL_CLOSE_REASONS[4001] as string);
					}
					room.guests.clear();
					return;
				}
				if (room.guests.delete(peerId)) {
					room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
				}
			},
		},
	});

	return {
		url: `ws://localhost:${server.port}`,
		stop(): void {
			for (const room of rooms.values()) {
				const closure = JSON.stringify({ t: "room-closed" });
				for (const guest of room.guests.values()) {
					guest.send(closure);
					guest.close(4001, RELAY_FATAL_CLOSE_REASONS[4001] as string);
				}
				room.host.close(1001, "relay shutting down");
			}
			rooms.clear();
			server.stop(true);
		},
	};
}
function parsePort(argv: readonly string[]): number {
	let raw: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--port") raw = argv[i + 1];
		else if (arg.startsWith("--port=")) raw = arg.slice("--port=".length);
	}
	if (raw === undefined) return DEFAULT_PORT;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		console.error(`local-relay: invalid --port ${raw}`);
		process.exit(1);
	}
	return port;
}

if (import.meta.main) {
	const relay = startLocalRelay(parsePort(Bun.argv.slice(2)));
	let stopping = false;
	const shutdown = (): void => {
		if (stopping) return;
		stopping = true;
		relay.stop();
		process.exit(0);
	};
	console.log(`local collab relay listening on ${relay.url}`);
	console.log("connect with /r/<roomId>?role=host|guest; Ctrl+C stops the relay");
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
