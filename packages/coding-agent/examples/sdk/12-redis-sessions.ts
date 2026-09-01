import { createAgentSession, RedisSessionStorage, SessionManager } from "@veyyon/coding-agent";
import { RedisClient } from "bun";

const redis = new RedisClient();
await redis.ping();

const storage = await RedisSessionStorage.create({
	client: redis,
	prefix: "veyyon:sessions:", // optional, this is the default
});

const sessionDir = "/sessions/my-project";

const { session } = await createAgentSession({
	sessionManager: SessionManager.create(process.cwd(), sessionDir, storage),
});
console.log("New Redis session:", session.sessionFile);

const { session: continued } = await createAgentSession({
	sessionManager: await SessionManager.continueRecent(process.cwd(), sessionDir, storage),
});
console.log("Resumed:", continued.sessionFile);

const sessions = await SessionManager.list(process.cwd(), sessionDir, storage);
console.log(`Found ${sessions.length} sessions under ${sessionDir}`);

await storage.drain();
redis.close();
