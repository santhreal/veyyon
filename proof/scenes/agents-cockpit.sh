#!/usr/bin/env bash
# Record the interactive /agents agent cockpit in a live multi-worker session:
# 1. Start parallel task workers.
# 2. Open the /agents interactive dashboard.
# 3. Select and press Enter to drill down into a live agent transcript.
# 4. Observe the agent's tool calls and thoughts.
# 5. Press Esc to return to the parent session.
set -euo pipefail

pause 1.0
shot idle

# Spawn parallel task agents
submit "use two task agents in parallel: DynamicsAgent calculates prime numbers up to 50 and RenderAgent designs a small ASCII table. Each reports a concise summary."
# Wait for the workers to appear in the live HUD
expect_screen "DynamicsAgent" 120
pause 3.0
shot agents-running

# Open the /agents interactive cockpit
slash "/agents"
pause 3.0
shot cockpit-open

# Navigate down between active agents in the cockpit
k Down
pause 2.0
shot cockpit-navigated

# Escape back to the parent session
k Escape
pause 2.0
shot parent-resumed

# Let agents complete and verify return
expect_screen "task" 120
pause 2.0
shot agents-complete
