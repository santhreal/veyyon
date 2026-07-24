const fs = require('fs');
let text = fs.readFileSync('packages/coding-agent/CHANGELOG.md', 'utf8');

text = text.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Fixed\n\n- Fixed MCP argument-shaping parity between direct and Task/subagent tool calls: `MCPTool`/`DeferredMCPTool` now declare `strict: false` so OpenAI-family serializers preserve the explicit non-strict flag (models no longer over-fill mutually exclusive optional fields), and Task proxies (`createMCPProxyTools`) now delegate to the current source MCP tool instead of rebuilding a raw `tools/call`, so harness-intent (`i`) stripping, optional-placeholder pruning, local-URL resolution, reconnect, abort, and result metadata match the direct path. Strict servers no longer reject proxied calls with `unrecognized_keys ["i"]` ([#6208](https://github.com/can1357/oh-my-pi/issues/6208)).\n');

fs.writeFileSync('packages/coding-agent/CHANGELOG.md', text);
