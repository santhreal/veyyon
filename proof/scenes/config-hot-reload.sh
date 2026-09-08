#!/usr/bin/env bash
# One live session, same disk edit: off = not yet reloaded, on = /reload-config.
# No provider turn is needed; the real command displays the effective routing diff.
settle 16
submit "/reload-config"
settle 3
config=/sandbox/home/.veyyon/profiles/default/agent/config.yml
# Preserve the recorder's seed, including any existing subagent namespace.
bun -e 'const f = process.argv[1]; const c = Bun.YAML.parse(await Bun.file(f).text()); c.subagent = {...c.subagent, sharedModel: true, model: "openai/reload-proof"}; await Bun.write(f, Bun.YAML.stringify(c));' "$config"
shot off
submit "/reload-config"
settle 4
shot on
# Idempotency is visible through the same production command.
submit "/reload-config"
settle 3
shot unchanged
