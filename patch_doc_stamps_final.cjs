const fs = require('fs');
const execSync = require('child_process').execSync;

const date = execSync('date -u +%Y-%m-%d').toString().trim();
const commit = execSync('git rev-parse --short HEAD').toString().trim();
const files = execSync('git ls-files docs/internal/*.md docs/internal/**/*.md').toString().trim().split('\n');

for (const file of files) {
    if (!file) continue;
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(/\*Verified against `[0-9a-f]+` on \d{4}-\d{2}-\d{2}\.\*/g, `*Verified against \`${commit}\` on ${date}.*`);
    fs.writeFileSync(file, content);
}
