const fs = require('fs');

let content = fs.readFileSync('packages/coding-agent/test/sdk-default-role-discovery-config-provider.test.ts', 'utf8');

// The CodeQL check reported: Insecure creation of file in the os temp dir
// Which is on line 35 of the test.
// Let's replace `fs.mkdirSync(tempDir, { recursive: true });`
// with `tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-sdk-default-role-config-"));`

content = content.replace(
    'tempDir = path.join(os.tmpdir(), `pi-sdk-default-role-config-${Snowflake.next()}`);\\n\\t\\tfs.mkdirSync(tempDir, { recursive: true });',
    'tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `veyyon-sdk-default-role-config-${Snowflake.next()}-`));'
);

// I must be careful with backticks in string replacements
