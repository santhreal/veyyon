import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@veyyon/ai/auth-gateway";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";

describe("auth-gateway model list", () => {
	it("returns deduplicated models with provider-qualified IDs", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-models-list-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const mockAnthropic = createMockModel({ provider: "anthropic", id: "shared-model" });
		const mockDevin1 = createMockModel({ provider: "devin", id: "shared-model" });
		const mockDevin2 = createMockModel({ provider: "devin", id: "shared-model" });

		const models = [mockAnthropic.model, mockDevin1.model, mockDevin2.model];

		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mockAnthropic.model,
			listModels: () => models,
			version: "test",
		});

		try {
			const res = await fetch(`${handle.url}/v1/models`, {
				headers: { Authorization: "Bearer t" },
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.object).toBe("list");
			expect(body.data).toEqual([
				{
					id: "anthropic/shared-model",
					object: "model",
					owned_by: "anthropic",
					api: mockAnthropic.model.api,
				},
				{
					id: "devin/shared-model",
					object: "model",
					owned_by: "devin",
					api: mockDevin1.model.api,
				},
			]);
		} finally {
			await handle.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
