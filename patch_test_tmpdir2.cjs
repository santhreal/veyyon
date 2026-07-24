const fs = require('fs');

let content = fs.readFileSync('packages/coding-agent/test/sdk-default-role-discovery-config-provider.test.ts', 'utf8');

const search = 'tempDir = path.join(os.tmpdir(), `pi-sdk-default-role-config-${Snowflake.next()}`);\n\t\tfs.mkdirSync(tempDir, { recursive: true });';
const replace = 'tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `veyyon-sdk-default-role-config-${Snowflake.next()}-`));';

content = content.replace(search, replace);
fs.writeFileSync('packages/coding-agent/test/sdk-default-role-discovery-config-provider.test.ts', content);
