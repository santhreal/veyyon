import { createAgentSession, SessionManager, SqlSessionStorage } from "@veyyon/coding-agent";
import { SQL } from "bun";

const client = new SQL(process.env.SESSIONS_DB_URL ?? "sqlite::memory:");

const storage = await SqlSessionStorage.create({
	client,
	table: "veyyon_session_files", // optional, this is the default
});

const sessionDir = "/sessions/my-project";

const { session } = await createAgentSession({
	sessionManager: SessionManager.create(process.cwd(), sessionDir, storage),
});
console.log(`New SQL session (${storage.adapter}):`, session.sessionFile);

const { session: continued } = await createAgentSession({
	sessionManager: await SessionManager.continueRecent(process.cwd(), sessionDir, storage),
});
console.log("Resumed:", continued.sessionFile);

const sessions = await SessionManager.list(process.cwd(), sessionDir, storage);
console.log(`Found ${sessions.length} sessions under ${sessionDir}`);

await storage.drain();
await client.end?.();
