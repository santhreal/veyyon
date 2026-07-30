# Container harness for the real `/secret` flow.
#
# Reuses the repo's own runtime image rather than inventing a base:
#
#     docker build --target runtime -t veyyon:dev -f Dockerfile .
#
# That image already carries bun, the compiled `veyyon_natives` addon, an
# installed `node_modules`, the generated tool views, and a `/usr/local/bin/veyyon`
# shim that runs the real CLI from `$VEYYON_ROOT`. The root `Dockerfile` documents
# this exact composition ("Consume as a base in another Dockerfile"), and
# `Dockerfile.veybot` does the same thing.
#
# Nothing is installed here: the base already ships `script` (util-linux),
# `sha256sum` and `openssl`, which is everything the harness needs.
#
# WHY A CONTAINER RATHER THAN A SANDBOXED HOME. `/secret list` and the stored-name
# completion read the global, profile AND project vault scopes. On a developer
# machine that means the run shows that developer's real credential names, so the
# output is neither reproducible nor safe to paste. A fresh container gives an
# empty vault and a HOME nothing has ever written a credential into, with no
# `HOME=` override and no `VEYYON_CONFIG_DIR` (which the code rejects as an
# absolute path anyway — see `packages/utils/src/dirs.ts getConfigDirName`).

ARG VEYYON_BASE=veyyon:dev
FROM ${VEYYON_BASE}

# HOME is the isolation. The image owns it, so no caller can point it at a real
# one. `veyyon config path` is what the harness asks for the resolved agent dir;
# nothing here hardcodes `.veyyon/profiles/default/agent`.
ENV HOME=/harness/home \
    HARNESS_HOME=/harness/home \
    HARNESS_PROJECT=/harness/project \
    HARNESS_WORK=/harness/work \
    HARNESS_MOCK_PORT=8899 \
    VEYYON_ROOT=/veyyon \
    TERM=xterm-256color \
    NO_COLOR=1

RUN mkdir -p /harness/home /harness/project /harness/work /harness/bin

COPY scripts/secret-harness/entrypoint.sh /harness/bin/entrypoint.sh
COPY scripts/secret-harness/mock-provider.ts /harness/bin/mock-provider.ts
COPY scripts/secret-harness/leak-paths.ts /harness/bin/leak-paths.ts
RUN chmod +x /harness/bin/entrypoint.sh

WORKDIR /harness/project
ENTRYPOINT ["/usr/bin/tini", "--", "/harness/bin/entrypoint.sh"]
