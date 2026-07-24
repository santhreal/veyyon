const fs = require('fs');
let code = fs.readFileSync('packages/tui/src/utils.ts', 'utf8');

// I also need to make sure that the `Bun.stringWidth` in the OSC66 matching fallback is correct
// Wait, the test that fails is OSC 66 text-sizing headings.
// The failure is "Expected: 10, Received: 24" and "Expected: 10, Received: 37".

// Let's restore and only replace the ones we need!
