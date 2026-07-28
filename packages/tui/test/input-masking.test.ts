/**
 * A masked input, which is the only way a credential is typed without landing in the scrollback.
 *
 * WHY THIS SUITE EXISTS. "It looked hidden when I tried it" is not evidence: a mask that leaks is
 * a mask that leaks one character, in one state, on one terminal width. So every assertion below
 * is on the EXACT rendered bytes, and the value is checked for absence rather than the mask for
 * presence. Absence is the property that matters, and it is the one a screenshot cannot prove.
 *
 * Masking lives on `Input` rather than in a separate secret-field component so that paste, word
 * motion, the kill ring and undo behave identically to every other field in the app. That choice
 * is what these tests defend: they check the value still round-trips through `getValue`, so a
 * future edit cannot "fix" masking by masking the buffer itself.
 */
import { describe, expect, it } from "bun:test";
import { PASTE_END, PASTE_START } from "../src/bracketed-paste";
import { DEFAULT_MASK_CHAR, Input, maskValue } from "../src/components/input";

/** Everything the terminal would receive, with escape sequences kept. */
function rendered(input: Input, width = 40): string {
	return input.render(width).join("\n");
}

/** Escape sequences stripped, so a value cannot hide inside one. */
function plainText(input: Input, width = 40): string {
	return rendered(input, width)
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/​/g, "");
}

describe("the mask projection", () => {
	/** One mask character per GRAPHEME, so the count a person sees matches what they typed. */
	it("emits one mask character per grapheme", () => {
		expect(maskValue("abcd", 4, "•")).toEqual({ value: "••••", cursor: 4 });
	});

	/**
	 * A multi-code-unit grapheme counts once.
	 *
	 * `"🔑".length` is 2, so a per-code-unit mask would draw two bullets for one character and put
	 * the cursor a cell to the right of where the typist left it.
	 */
	it("counts an astral character once", () => {
		expect(maskValue("a🔑b", 7, "•")).toEqual({ value: "•••", cursor: 3 });
	});

	/** A combining sequence is one grapheme, not one per combining mark. */
	it("counts a combining sequence once", () => {
		expect(maskValue("é", 2, "•")).toEqual({ value: "•", cursor: 1 });
	});

	/** The cursor maps to the number of graphemes before it, not the number of code units. */
	it("maps the cursor to the grapheme count before it", () => {
		expect(maskValue("🔑🔑🔑", 4, "•").cursor).toBe(2);
	});

	/** An empty value masks to nothing, so an untouched field is not a row of bullets. */
	it("masks an empty value to an empty string", () => {
		expect(maskValue("", 0, "•")).toEqual({ value: "", cursor: 0 });
	});
});

describe("a masked field", () => {
	/**
	 * THE PROPERTY THAT MATTERS: no part of the value reaches the render output.
	 *
	 * Asserted on the value's bytes, not on the mask's presence, and on every prefix of the value,
	 * so a leak of a single leading character cannot pass.
	 */
	it("renders no part of the value", () => {
		const input = new Input();
		input.mask = DEFAULT_MASK_CHAR;
		input.setValue("ghp_liveTokenValue123");

		const output = rendered(input);
		for (let end = 1; end <= "ghp_liveTokenValue123".length; end++) {
			expect(output).not.toContain("ghp_liveTokenValue123".slice(0, end));
		}
	});

	/** The mask is what is drawn, one per character, exact count. */
	it("renders one mask character per character typed", () => {
		const input = new Input();
		input.mask = DEFAULT_MASK_CHAR;
		input.prompt = "";
		input.setValue("abcdef");

		const bullets = [...plainText(input)].filter(ch => ch === DEFAULT_MASK_CHAR).length;
		expect(bullets).toBe(6);
	});

	/**
	 * The BUFFER is not masked, only the render.
	 *
	 * If masking were applied to the value itself the caller would store a row of bullets as the
	 * credential, which would fail at the moment it was used rather than at the moment it was set.
	 */
	it("still returns the real value to the caller", () => {
		const input = new Input();
		input.mask = DEFAULT_MASK_CHAR;
		input.setValue("ghp_liveTokenValue123");

		expect(input.getValue()).toBe("ghp_liveTokenValue123");
	});

	/** Typing character by character stays masked, which is the state a person is actually in. */
	it("stays masked while typing", () => {
		const input = new Input();
		input.mask = DEFAULT_MASK_CHAR;
		for (const ch of "s3cr3t!") input.handleInput(ch);

		expect(input.getValue()).toBe("s3cr3t!");
		expect(plainText(input)).not.toContain("s3cr3t");
	});

	/** A pasted credential is masked too, which is how one is usually entered. */
	it("masks a pasted value", () => {
		const input = new Input();
		input.mask = DEFAULT_MASK_CHAR;
		input.pasteText("ghp_pastedSecretValue");

		expect(input.getValue()).toBe("ghp_pastedSecretValue");
		expect(plainText(input)).not.toContain("ghp_");
	});

	/**
	 * A value longer than the viewport is masked in the scrolled window too.
	 *
	 * Horizontal scrolling slices the display string. A mask applied anywhere other than before
	 * that slice would leak the visible window while the invisible part stayed hidden.
	 */
	it("masks a value wider than the terminal", () => {
		const input = new Input();
		input.mask = DEFAULT_MASK_CHAR;
		input.setValue(`ghp_${"x".repeat(200)}_END`);

		const output = plainText(input, 20);
		expect(output).not.toContain("ghp_");
		expect(output).not.toContain("_END");
	});

	/** A narrow terminal does not fall back to unmasked text. */
	it("masks at a very narrow width", () => {
		const input = new Input();
		input.mask = DEFAULT_MASK_CHAR;
		input.setValue("ghp_secret");

		expect(plainText(input, 6)).not.toContain("ghp");
	});

	/** An emoji in the value does not render itself. */
	it("masks an astral character in the value", () => {
		const input = new Input();
		input.mask = DEFAULT_MASK_CHAR;
		input.setValue("pass🔑word");

		const output = plainText(input);
		expect(output).not.toContain("🔑");
		expect(output).not.toContain("pass");
	});
});

describe("credential paste integrity", () => {
	/**
	 * Credentials are opaque payloads, not prose. Tabs, both newline forms,
	 * trailing spaces, decomposed Unicode and every C0/DEL boundary represented
	 * here must round-trip without normalization while no recognizable fragment
	 * reaches terminal rendering.
	 */
	it("preserves adversarial pasted code units exactly and renders only a mask", () => {
		const input = new Input();
		input.credentialMode = true;
		input.prompt = "";
		const credential = `raw-secret\tline1\r\nline2\re\u0301\x00\x01\x03\x1f\x7f  `;

		input.pasteText(credential);

		expect(input.getValue()).toBe(credential);
		const output = rendered(input, 200);
		expect(output).not.toContain("raw-secret");
		expect(output).not.toContain("line1");
		expect(output).not.toContain("e\u0301");
		expect([...plainText(input, 200)].filter(ch => ch === DEFAULT_MASK_CHAR)).toHaveLength(
			[...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(credential)].length,
		);
	});

	/**
	 * Paste payloads may be split at arbitrary stdin chunk boundaries. Payload
	 * newlines and escape bytes stay buffered until the end marker; only the
	 * physical Enter after that marker submits the byte-exact value.
	 */
	it("buffers split bracketed paste through its end marker and physical Enter", () => {
		const input = new Input();
		input.credentialMode = true;
		const submitted: string[] = [];
		let escaped = 0;
		input.onSubmit = value => submitted.push(value);
		input.onEscape = () => escaped++;
		input.isEscapeInput = data => data === "\x1b" || data === "\x03";
		const credential = "split\tsecret\nline\r\x03\x1b  ";

		input.handleInput(PASTE_START);
		input.handleInput(credential.slice(0, 8));
		input.handleInput(credential.slice(8));
		expect(submitted).toEqual([]);
		expect(escaped).toBe(0);

		input.handleInput(PASTE_END);
		expect(input.getValue()).toBe(credential);
		expect(submitted).toEqual([]);
		expect(escaped).toBe(0);

		input.handleInput("\r");
		expect(submitted).toEqual([credential]);
	});
});

describe("an unmasked field", () => {
	/** Unchanged when no mask is set, so ordinary inputs are not affected by any of this. */
	it("renders its value as itself", () => {
		const input = new Input();
		input.prompt = "";
		input.setValue("hello world");

		expect(plainText(input)).toContain("hello world");
	});

	/** The default is unmasked: masking is opt-in, never accidental. */
	it("is the default", () => {
		expect(new Input().mask).toBeUndefined();
	});
});
