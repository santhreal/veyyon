#!/usr/bin/env bash
# Install the fixture-local TypeScript server used by the LSP write-through demo.
set -euo pipefail

DEMO_CWD="${VEYYON_DEMO_CWD:-$HOME/orbit}"
BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"

cat >"$DEMO_CWD/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true
  },
  "include": ["src/**/*.ts"]
}
JSON

(
  cd "$DEMO_CWD"
  "$BUN" add --dev --exact typescript@5.9.3 typescript-language-server@5.3.0 >/dev/null
)
