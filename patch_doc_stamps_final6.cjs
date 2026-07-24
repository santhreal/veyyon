const fs = require('fs');
const execSync = require('child_process').execSync;

const date = execSync('git log origin/main -1 --format=%cd --date=short').toString().trim();
const commit = execSync('git log origin/main -1 --format=%H').toString().trim().substring(0, 8);
const files = execSync('git ls-files docs/internal/*.md docs/internal/**/*.md').toString().trim().split('\n');

for (const file of files) {
    if (!file) continue;
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(/\*Verified against `[0-9a-f]+` on \d{4}-\d{2}-\d{2}\.\*/g, `*Verified against \`${commit}\` on ${date}.*`);
    fs.writeFileSync(file, content);
}
