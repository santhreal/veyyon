const fs = require('fs');
let content = fs.readFileSync('packages/coding-agent/test/sdk-default-role-discovery-config-provider.test.ts', 'utf8');

content = content.replace(
    /tempDir = path\.join\(os\.tmpdir\(\), `pi-sdk-default-role-config-\$\{Snowflake\.next\(\)\}`\);\n\s+fs\.mkdirSync\(tempDir, \{ recursive: true \}\);/g,
    'tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `veyyon-sdk-default-role-config-${Snowflake.next()}-`));'
);

fs.writeFileSync('packages/coding-agent/test/sdk-default-role-discovery-config-provider.test.ts', content);
