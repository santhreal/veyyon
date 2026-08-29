import { BEL } from "@veyyon/tui/ansi";
import type { EnhancedPasteHandlers, Osc5522Packet, PasteListingState, PasteState } from "./enhanced-paste-helpers";
import {
	choosePasteMime,
	decodeBase64Utf8,
	MIME_LISTING_TARGET,
	OSC5522_PREFIX,
	PASTE_EVENT_NAME_BASE64,
	parseOsc5522Packet,
} from "./enhanced-paste-helpers";

export { isOsc5522Packet } from "./enhanced-paste-helpers";
export { parseOsc5522Packet };

export class EnhancedPasteController {
	#state: PasteState | undefined;
	#handlers: EnhancedPasteHandlers;

	constructor(handlers: EnhancedPasteHandlers) {
		this.#handlers = handlers;
	}

	enable(): void {
		this.#handlers.requestMode();
	}

	disable(): void {
		this.#state = undefined;
	}

	handleInput(data: string): boolean {
		const packet = parseOsc5522Packet(data);
		if (!packet) return false;
		void this.#handlePacket(packet);
		return true;
	}

	async #handlePacket(packet: Osc5522Packet): Promise<void> {
		const type = packet.metadata.get("type");
		if (type !== "read") return;

		const status = packet.metadata.get("status");
		if (status === "OK") {
			this.#handleOk(packet);
			return;
		}
		if (status === "DATA") {
			this.#handleData(packet);
			return;
		}
		if (status === "DONE") {
			await this.#handleDone();
			return;
		}
		if (status) {
			this.#state = undefined;
			this.#handlers.showStatus(`Enhanced paste failed: ${status}`);
		}
	}

	#handleOk(packet: Osc5522Packet): void {
		if (this.#state?.phase === "reading") return;
		const loc = packet.metadata.get("loc");
		this.#state = {
			phase: "listing",
			mimes: [],
			pw: packet.metadata.get("pw"),
			loc: loc === "primary" ? loc : undefined,
		};
	}

	#handleData(packet: Osc5522Packet): void {
		const state = this.#state;
		if (!state) return;
		const encodedMime = packet.metadata.get("mime");
		if (!encodedMime) return;
		const mimeType = decodeBase64Utf8(encodedMime);
		if (!mimeType) return;

		if (state.phase === "listing") {
			if (mimeType === MIME_LISTING_TARGET) {
				if (!packet.payload) return;
				const listing = decodeBase64Utf8(packet.payload);
				if (!listing) return;
				state.kittyDotPayload = true;
				for (const candidate of listing.split(/\s+/)) {
					if (candidate && candidate !== MIME_LISTING_TARGET) state.mimes.push(candidate);
				}
				return;
			}
			state.mimes.push(mimeType);
			return;
		}

		if (state.mimeType === mimeType && packet.payload) {
			state.chunks.push(packet.payload);
		}
	}

	async #handleDone(): Promise<void> {
		const state = this.#state;
		if (!state) return;
		if (state.phase === "listing") {
			this.#finishListing(state);
			return;
		}
		this.#state = undefined;
		const bytes = Buffer.concat(state.chunks.map(chunk => Buffer.from(chunk, "base64")));
		if (bytes.byteLength === 0) {
			this.#handlers.showStatus("Clipboard paste was empty");
			return;
		}
		if (state.kind === "text") {
			this.#handlers.pasteText(bytes.toString("utf8"));
			return;
		}
		await this.#handlers.pasteImage({
			type: "image",
			data: bytes.toString("base64"),
			mimeType: state.mimeType,
		});
	}

	#finishListing(state: PasteListingState): void {
		const selected = choosePasteMime(state.mimes);
		if (!selected) {
			this.#state = undefined;
			this.#handlers.showStatus("Clipboard paste has no supported text or image data");
			return;
		}

		this.#state = {
			phase: "reading",
			kind: selected.kind,
			mimeType: selected.mimeType,
			chunks: [],
		};

		const encodedMime = Buffer.from(selected.mimeType, "utf8").toString("base64");
		const metadata = ["type=read"];
		if (state.loc) metadata.push(`loc=${state.loc}`);
		if (state.pw) {
			metadata.push(`pw=${state.pw}`, `name=${PASTE_EVENT_NAME_BASE64}`);
		}
		if (state.kittyDotPayload) {
			this.#handlers.write(`${OSC5522_PREFIX}${metadata.join(":")};${encodedMime}${BEL}`);
			return;
		}
		metadata.push(`mime=${encodedMime}`);
		this.#handlers.write(`${OSC5522_PREFIX}${metadata.join(":")}${BEL}`);
	}
}
