/**
 * A file-backed image and a chat attachment image go through the same size and
 * encoder policy.
 *
 * WHY THIS SUITE EXISTS. `loadImageInput` (read tool, inspect_image, the terminal
 * paste path) and `loadImageAttachmentInput` (inspect_image on a chat attachment)
 * used to each restate the resize-or-canonicalize step and the output size check.
 * The attachment loader had no test, so a change to one policy could leave the
 * other behind in silence. `encodeImageInput` in `utils/image-loading.ts` is now
 * the single owner, and this suite holds both loaders to it on the same bytes.
 *
 * CLASS CLOSED. For the same image bytes, both loaders return the same output
 * bytes, MIME type and dimension note in both the auto-resize and the
 * canonicalize arm; both reject an oversized input with the same
 * `ImageInputTooLargeError`; both return `null` for bytes that are not an image;
 * and only the note prefix and the `resolvedPath` differ.
 *
 * NOT CAUGHT. The post-encode output size check is shared by construction but
 * not driven here: no fixture in this suite grows when re-encoded, so a limit
 * between the input and the output sizes cannot be pinned deterministically.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ImageInputTooLargeError,
	type LoadedImageInput,
	loadImageAttachmentInput,
	loadImageInput,
} from "@veyyon/coding-agent/utils/image-loading";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

// 1x1 red PNG seed, upscaled at test time so no binary fixture is checked in.
const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function redPng(width: number, height: number): Promise<Buffer> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const bytes = await new Bun.Image(seed).resize(width, height, { filter: "nearest" }).png().bytes();
	return Buffer.from(bytes);
}

let testDir: string;
let imagePath: string;
let image: Buffer;

beforeEach(async () => {
	testDir = path.join(os.tmpdir(), `image-loader-policy-${Snowflake.next()}`);
	fs.mkdirSync(testDir, { recursive: true });
	imagePath = path.join(testDir, "red.png");
	image = await redPng(64, 48);
	fs.writeFileSync(imagePath, image);
});

afterEach(() => {
	removeSyncWithRetries(testDir);
});

async function loadBoth(autoResize: boolean): Promise<[LoadedImageInput | null, LoadedImageInput | null]> {
	return Promise.all([
		loadImageInput({ path: "red.png", cwd: testDir, autoResize }),
		loadImageAttachmentInput({
			image: { type: "image", data: image.toString("base64"), mimeType: "image/png" },
			label: "#1",
			uri: "attachment:1",
			autoResize,
		}),
	]);
}

describe("a file image and an attachment image pass one encoder policy", () => {
	for (const autoResize of [false, true]) {
		it(`autoResize=${autoResize}: both loaders return the same bytes, MIME type and dimension note`, async () => {
			const [file, attachment] = await loadBoth(autoResize);
			expect(file).not.toBeNull();
			expect(attachment).not.toBeNull();
			expect(attachment!.data).toBe(file!.data);
			expect(attachment!.mimeType).toBe(file!.mimeType);
			expect(attachment!.bytes).toBe(file!.bytes);
			expect(attachment!.dimensionNote).toBe(file!.dimensionNote);
			expect(file!.resolvedPath).toBe(imagePath);
			expect(attachment!.resolvedPath).toBe("attachment:1");
			expect(file!.textNote.startsWith(`Read image file [${file!.mimeType}]`)).toBe(true);
			expect(attachment!.textNote.startsWith(`Read image attachment #1 [${attachment!.mimeType}]`)).toBe(true);
			// The dimension note, when present, is the second line of both notes.
			expect(file!.textNote.split("\n").slice(1)).toEqual(attachment!.textNote.split("\n").slice(1));
		});
	}

	it("both loaders reject an oversized input before decoding it", async () => {
		const maxBytes = image.byteLength - 1;
		const [fileError, attachmentError] = await Promise.all(
			[
				loadImageInput({ path: "red.png", cwd: testDir, autoResize: true, maxBytes }),
				loadImageAttachmentInput({
					image: { type: "image", data: image.toString("base64"), mimeType: "image/png" },
					label: "#1",
					uri: "attachment:1",
					autoResize: true,
					maxBytes,
				}),
			].map(promise =>
				promise.then(
					() => null,
					(error: unknown) => error,
				),
			),
		);
		expect(fileError).toBeInstanceOf(ImageInputTooLargeError);
		expect(attachmentError).toBeInstanceOf(ImageInputTooLargeError);
		expect((fileError as ImageInputTooLargeError).bytes).toBe(image.byteLength);
		expect((attachmentError as ImageInputTooLargeError).bytes).toBe(image.byteLength);
	});

	it("both loaders return null for bytes that are not an image", async () => {
		const notAnImage = Buffer.from("this is not an image");
		fs.writeFileSync(imagePath, notAnImage);
		const [file, attachment] = await Promise.all([
			loadImageInput({ path: "red.png", cwd: testDir, autoResize: true }),
			loadImageAttachmentInput({
				image: { type: "image", data: notAnImage.toString("base64"), mimeType: "image/png" },
				label: "#1",
				uri: "attachment:1",
				autoResize: true,
			}),
		]);
		expect(file).toBeNull();
		expect(attachment).toBeNull();
	});
});
