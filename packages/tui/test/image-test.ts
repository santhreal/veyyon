import { getImageDimensions, TERMINAL } from "@veyyon/pi-tui";
import { Image } from "@veyyon/pi-tui/components/image";
import { Spacer } from "@veyyon/pi-tui/components/spacer";
import { Text } from "@veyyon/pi-tui/components/text";
import { ProcessTerminal } from "@veyyon/pi-tui/terminal";
import { TUI } from "@veyyon/pi-tui/tui";

const testImagePath = Bun.argv[2] || "/tmp/test-image.png";

console.log("Terminal capabilities:", TERMINAL);
console.log("Loading image from:", testImagePath);

let imageBuffer: Uint8Array;
try {
	const file = Bun.file(testImagePath);
	imageBuffer = await file.bytes();
} catch {
	console.error(`Failed to load image: ${testImagePath}`);
	console.error("Usage: bun test/image-test.ts [path-to-image.png]");
	process.exit(1);
}

const base64Data = imageBuffer.toBase64();
const dims = getImageDimensions(base64Data, "image/png");

console.log("Image dimensions:", dims);
console.log("");

const terminal = new ProcessTerminal();
const tui = new TUI(terminal);

tui.addChild(new Text("Image Rendering Test", 1, 1));
tui.addChild(new Spacer(1));

if (dims) {
	tui.addChild(
		new Image(base64Data, "image/png", { fallbackColor: s => `\x1b[33m${s}\x1b[0m` }, { maxWidthCells: 60 }, dims),
	);
} else {
	tui.addChild(new Text("Could not parse image dimensions", 1, 0));
}

tui.addChild(new Spacer(1));
tui.addChild(new Text("Press Ctrl+C to exit", 1, 0));

const editor = {
	handleInput(data: string) {
		if (data.charCodeAt(0) === 3) {
			tui.stop();
			process.exit(0);
		}
	},
};

tui.setFocus(editor as any);
tui.start();
