import { SqliteAuthCredentialStore } from "../../src/auth-storage-sqlite";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("Expected a credential database path");
process.stdout.write("opening\n");
const store = await SqliteAuthCredentialStore.open(dbPath);
try {
	store.saveApiKey("fixture", "test-fixture-key");
	process.stdout.write(`${JSON.stringify({ providers: store.listProviders(), key: store.getApiKey("fixture") })}\n`);
} finally {
	store.close();
}
