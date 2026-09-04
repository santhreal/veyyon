"""The compose environment allowlist must cover the whole `.env` surface.

`docker-compose.yml` deliberately does NOT use `env_file:`, because that would
leak the gh-proxy's `GITHUB_TOKEN` into the orchestrator container. The price of
that deliberate choice is a hand-maintained allowlist, and a hand-maintained
allowlist silently strands settings: a key declared in `src/config.py` and
documented in `.env.example` but missing from compose takes its CODE DEFAULT in
Docker, forever, with nothing logged. The operator reads their `.env`, sees the
value they set, and gets something else.

That is not hypothetical. 26 settings were stranded this way at once, including
the entire project-adaptation block whose only purpose is to let veybot service
a project with a toolchain other than bun: in the container, none of it did
anything. `extra="forbid"` cannot catch this, because the key is spelled
correctly and simply never arrives.

These tests are the gate that makes the allowlist self-maintaining.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[1]
_COMPOSE = _ROOT / "docker-compose.yml"
_ENV_EXAMPLE = _ROOT / ".env.example"

# The one key that MUST NOT reach the orchestrator. The bot's PAT lives only in
# gh-proxy; the orchestrator talks to it over the internal network instead.
_ORCHESTRATOR_FORBIDDEN = {"GITHUB_TOKEN"}


def _compose_services() -> dict[str, dict]:
    return yaml.safe_load(_COMPOSE.read_text(encoding="utf-8"))["services"]


def _service_env(service: str) -> dict[str, str]:
    env = _compose_services()[service].get("environment") or {}
    return {key: str(value) for key, value in env.items()}


def _documented_keys() -> set[str]:
    """Every key `.env.example` documents, commented-out optionals included."""
    return set(re.findall(r"^#?\s*([A-Z][A-Z0-9_]+)=", _ENV_EXAMPLE.read_text(encoding="utf-8"), re.M))


def _interpolation_default(value: str) -> str | None:
    """The `X` in `${KEY:-X}`, or None for a container-fixed literal."""
    match = re.fullmatch(r"\$\{[A-Z][A-Z0-9_]*:-(.*)\}", value)
    return match.group(1) if match else None


class TestEveryDocumentedKeyReachesAContainer:
    def test_no_documented_setting_is_stranded(self):
        """A key in `.env.example` that no service passes through is dead config.

        This is the test that would have caught the 26-key gap. It fails with the
        names, so the fix is mechanical rather than a hunt.
        """
        passed_through = set(_service_env("veybot")) | set(_service_env("gh-proxy"))
        stranded = sorted(_documented_keys() - passed_through)
        assert stranded == [], (
            f"{len(stranded)} setting(s) documented in .env.example never reach a container, "
            f"so they silently take their code defaults in Docker: {stranded}"
        )

    def test_compose_passes_nothing_undocumented(self):
        """The reverse drift: a compose key absent from `.env.example`.

        `Settings` runs `extra="forbid"`, so an env var it does not declare is a
        startup crash. Catching it here names the key instead.
        """
        documented = _documented_keys()
        # Interpolation-only vars that configure compose itself, not Settings.
        compose_only = {"VEYYON_BASE"}
        for service in ("veybot", "gh-proxy"):
            unknown = sorted(set(_service_env(service)) - documented - compose_only)
            assert unknown == [], f"{service} passes undocumented key(s): {unknown}"


class TestDefaultsAgree:
    def test_compose_defaults_match_env_example(self):
        """`${KEY:-default}` must not disagree with the documented default.

        A silent disagreement here means `docker compose up` with no `.env`
        behaves differently from what the operator read. The real instance: the
        model default drifted to a model the project no longer runs.
        """
        documented: dict[str, str] = {}
        for line in _ENV_EXAMPLE.read_text(encoding="utf-8").splitlines():
            match = re.match(r"^#?\s*([A-Z][A-Z0-9_]+)=(.*)$", line)
            if match:
                documented.setdefault(match.group(1), match.group(2).strip())

        mismatches = []
        for service in ("veybot", "gh-proxy"):
            for key, raw in _service_env(service).items():
                default = _interpolation_default(raw)
                if default is None or key not in documented:
                    continue  # container-fixed literal, or a required `:?` var
                if default != documented[key]:
                    mismatches.append(f"{service}.{key}: compose={default!r} .env.example={documented[key]!r}")
        assert mismatches == [], "compose defaults disagree with .env.example: " + "; ".join(mismatches)


class TestTokenIsolation:
    """The security invariant the hand-maintained allowlist exists to protect."""

    def test_orchestrator_never_receives_the_pat(self):
        """`GITHUB_TOKEN` in the veybot container defeats the gh-proxy split.

        The orchestrator runs agent-authored `bash`; a PAT in its environment is
        one `printenv` away from the model.
        """
        assert _ORCHESTRATOR_FORBIDDEN.isdisjoint(_service_env("veybot"))

    def test_gh_proxy_holds_the_pat(self):
        """The negative twin: isolation must not be achieved by losing the token."""
        assert "GITHUB_TOKEN" in _service_env("gh-proxy")

    def test_compose_declares_no_env_file(self):
        """`env_file:` would hand the whole `.env`, PAT included, to every service.

        The allowlist is only a boundary while this stays true.
        """
        for name, service in _compose_services().items():
            assert "env_file" not in service, f"service {name} reintroduced env_file"


@pytest.mark.parametrize(
    "key",
    [
        "VEYBOT_PROJECT_MARKERS",
        "VEYBOT_WORKSPACE_BOOTSTRAP_COMMAND",
        "VEYBOT_PRE_PR_FIX_COMMAND",
        "VEYBOT_PRE_PR_CHECK_COMMAND",
        "VEYBOT_SLOT_EXTRA_GROUP",
        "VEYBOT_LLM_BASE_URL",
        "VEYBOT_LLM_API_KEY",
    ],
)
def test_portability_and_routing_keys_reach_the_orchestrator(key: str):
    """Named guards for the settings whose whole point is being operator-set.

    The generic test above covers these, but they are called out by name because
    stranding one produces no error at all: veybot just quietly runs `bun` on a
    Rust repo, or quietly declines to manage model routing.
    """
    assert key in _service_env("veybot")
