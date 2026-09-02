/**
 * WHY:
 * Prompt attachments in the GUI host must handle video attachments alongside images,
 * validating media types, attachment sizes, and model video input support before
 * forwarding to AgentSession.prompt.
 *
 * This suite defends:
 * 1. SubmitPrompt with a video attachment on a video-capable model passes `videos` to session.prompt.
 * 2. SubmitPrompt with a video attachment on a non-video model is rejected with INVALID_ARGUMENTS naming the model.
 * 3. SubmitPrompt with an unsupported media type (e.g. application/pdf) is rejected with INVALID_ARGUMENTS naming the media type.
 * 4. SubmitPrompt with an oversize attachment is rejected with INVALID_ARGUMENTS naming the ceiling.
 * 5. RefreshModels snapshot carries the `input` modality array for every model row.
 *
 * What it does NOT catch: Desktop media playback.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@veyyon/ai";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { ModelsView } from "../../src/gui-host/wire";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { TestSocketClient } from "./test-client";

describe("GUI host video attachment validation and model input support", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	let sessionId: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-video-test-"));
		authStorage = await isolatedAuthStorage(tempDir);
		await authStorage.set("test-provider", { type: "api_key", key: "test-api-key" });

		// Write custom models: one with video input support, one text-only
		const modelsConfig = {
			providers: {
				"test-provider": {
					baseUrl: "https://example.invalid/v1",
					api: "openai-completions",
					apiKey: "test-api-key",
					models: [
						{
							id: "video-model",
							name: "Video Capable Model",
							input: ["text", "image", "video"],
							contextWindow: 100000,
							maxTokens: 4096,
						},
						{
							id: "text-model",
							name: "Text Only Model",
							input: ["text"],
							contextWindow: 100000,
							maxTokens: 4096,
						},
					],
				},
			},
		};
		await fs.writeFile(path.join(tempDir, "models.json"), JSON.stringify(modelsConfig, null, 2));

		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
		});
		client = await TestSocketClient.connect(server.endpoint);
		// Drain initial connection frames
		await client.nextFrame();
		await client.nextFrame();

		const created = await client.request(1, { CreateSession: {} });
		const active = created.frames.find(f => f.Snapshot?.ActiveSession) as
			| { Snapshot: { ActiveSession: { value: { id: string } } } }
			| undefined;
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		sessionId = active.Snapshot.ActiveSession.value.id;

		// Set queue mode to Queue so prompt acceptance enqueues without needing real network calls
		await client.request(2, { SetQueueMode: { mode: "Queue" } });
	});

	afterEach(async () => {
		client.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	test("RefreshModels snapshot carries input modalities for every model row", async () => {
		const { frames, outcome } = await client.request(3, "RefreshModels");
		expect(outcome).toEqual({ RequestSucceeded: { request: 3 } });

		const snapshotFrame = frames.find(f => f.Snapshot?.Models !== undefined);
		expect(snapshotFrame).toBeDefined();
		const modelsView = snapshotFrame!.Snapshot!.Models as ModelsView;

		expect(modelsView.models.length).toBeGreaterThan(0);
		for (const model of modelsView.models) {
			expect(model.input).toBeDefined();
			expect(Array.isArray(model.input)).toBeTrue();
		}

		const videoModel = modelsView.models.find(m => m.provider === "test-provider" && m.id === "video-model");
		expect(videoModel).toBeDefined();
		expect(videoModel!.input).toEqual(["text", "image", "video"]);
	});

	test("SubmitPrompt with video attachment on video-capable model accepts prompt with videos populated", async () => {
		// Select video-capable model
		const selectOutcome = await client.request(3, {
			SelectModel: {
				provider: "test-provider",
				model: "video-model",
			},
		});
		expect(selectOutcome.outcome.RequestSucceeded).toBeDefined();

		const videoData = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]).toString(
			"base64",
		);

		const submitted = await client.request(4, {
			SubmitPrompt: {
				session: sessionId,
				text: "Analyze this clip",
				attachments: [
					{
						id: "att-1",
						name: "clip.mp4",
						media_type: "video/mp4",
						data: videoData,
					},
				],
			},
		});

		expect(submitted.outcome.RequestSucceeded).toBeDefined();
	});

	test("SubmitPrompt with video attachment on non-video model is rejected with INVALID_ARGUMENTS naming the model", async () => {
		// Select text-only model
		const selectOutcome = await client.request(3, {
			SelectModel: {
				provider: "test-provider",
				model: "text-model",
			},
		});
		expect(selectOutcome.outcome.RequestSucceeded).toBeDefined();

		const videoData = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]).toString(
			"base64",
		);

		const submitted = await client.request(4, {
			SubmitPrompt: {
				session: sessionId,
				text: "Analyze this clip",
				attachments: [
					{
						id: "att-1",
						name: "clip.mp4",
						media_type: "video/mp4",
						data: videoData,
					},
				],
			},
		});

		expect(submitted.outcome.RequestFailed).toBeDefined();
		expect(submitted.outcome.RequestFailed?.error.code).toBe("INVALID_ARGUMENTS");
		expect(submitted.outcome.RequestFailed?.error.message).toContain("text-model");
	});

	test("SubmitPrompt with application/pdf is rejected with INVALID_ARGUMENTS naming media_type", async () => {
		const submitted = await client.request(3, {
			SubmitPrompt: {
				session: sessionId,
				text: "Read this PDF",
				attachments: [
					{
						id: "att-1",
						name: "document.pdf",
						media_type: "application/pdf",
						data: Buffer.from("fake-pdf").toString("base64"),
					},
				],
			},
		});

		expect(submitted.outcome.RequestFailed).toBeDefined();
		expect(submitted.outcome.RequestFailed?.error.code).toBe("INVALID_ARGUMENTS");
		expect(submitted.outcome.RequestFailed?.error.message).toContain("application/pdf");
		expect(submitted.outcome.RequestFailed?.error.message).toContain("document.pdf");
	});

	test("SubmitPrompt with oversize video is rejected with INVALID_ARGUMENTS naming the ceiling", async () => {
		// Base64 string of length 28,000,000 decodes to 21,000,000 bytes (> 20 MB ceiling)
		// while the frame itself (28 MB) stays within the 32 MB MAX_FRAME_BYTES limit.
		const fakeB64 = "AAAA".repeat(7_000_000);

		const submitted = await client.request(3, {
			SubmitPrompt: {
				session: sessionId,
				text: "Analyze huge clip",
				attachments: [
					{
						id: "att-1",
						name: "huge.mp4",
						media_type: "video/mp4",
						data: fakeB64,
					},
				],
			},
		});

		expect(submitted.outcome.RequestFailed).toBeDefined();
		expect(submitted.outcome.RequestFailed?.error.code).toBe("INVALID_ARGUMENTS");
		expect(submitted.outcome.RequestFailed?.error.message).toContain("20.0MB");
		expect(submitted.outcome.RequestFailed?.error.message).toContain("huge.mp4");
	});
});
