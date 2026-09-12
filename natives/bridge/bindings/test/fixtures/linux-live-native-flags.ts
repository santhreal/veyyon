import { wrapTextWithAnsi } from "../../native/index.js";

const lines = wrapTextWithAnsi("alpha beta gamma", 10, 4);
process.stdout.write(
	JSON.stringify({
		variant: process.env.__PI_NATIVE_VARIANT_CACHE,
		lines,
	}) + "\n",
);
