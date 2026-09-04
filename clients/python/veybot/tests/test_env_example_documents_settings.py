"""`.env.example` is the only place an operator learns a knob exists.

veybot is configured entirely through environment variables. There is no
settings UI and no `--help` that enumerates them, so a setting absent from
`.env.example` is unreachable in practice: the behaviour ships, and nobody
turns it on.

That is not hypothetical. Twenty three of fifty four settings were missing at
once, and they were not obscure ones. `VEYBOT_PORT_UPSTREAM_ENABLED`,
`VEYBOT_PORT_LABEL`, `VEYBOT_CI_REPAIR_ENABLED`, `VEYBOT_CI_MAX_REPAIRS`,
`VEYBOT_TRIAGE_TRIGGER` and `VEYBOT_AGENT_PROFILE` were all undocumented, which
is the whole of upstream porting, the whole of CI repair, and the opt-in switch
that stops the bot triaging every issue in the tracker. An operator working
from the template could not enable any of it.

These tests read the real `Settings` model rather than the text of
`config.py`, so a field renamed, added, or removed is caught by what the class
actually declares.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from veybot.config import Settings

#: Keys `docker compose` interpolates that are deliberately not `Settings`
#: fields. `VEYYON_ROOT` selects which veyyon checkout gets mounted, which is a
#: property of the deployment, not of the running orchestrator.
COMPOSE_ONLY_KEYS = frozenset({"VEYYON_ROOT"})

ENV_EXAMPLE = Path(__file__).resolve().parent.parent / ".env.example"


def _documented_keys() -> set[str]:
    """Every `KEY=` in the template, whether or not the line is commented out.

    A commented key still documents the knob: several are commented precisely
    because setting them is mutually exclusive with another mode.
    """
    keys: set[str] = set()
    for line in ENV_EXAMPLE.read_text().splitlines():
        stripped = line.lstrip().lstrip("#").lstrip()
        name, separator, _ = stripped.partition("=")
        if separator and name.isupper() and name.replace("_", "").isalnum():
            keys.add(name)
    return keys


def _setting_aliases() -> set[str]:
    """The environment variable name of every field the orchestrator reads."""
    return {field.alias or name for name, field in Settings.model_fields.items()}


def test_every_setting_is_documented_in_env_example() -> None:
    """A setting the template never mentions cannot be set by an operator.

    This is the check that would have caught port_upstream, ci_repair and the
    triage trigger shipping with no way to reach them.
    """
    missing = sorted(_setting_aliases() - _documented_keys())
    assert missing == [], (
        "these settings exist in Settings but are absent from .env.example, "
        f"so no operator can discover or set them: {missing}"
    )


def test_env_example_documents_no_setting_that_no_longer_exists() -> None:
    """The inverse defect: a knob the template promises and the code ignores.

    Setting one of these does nothing at all, silently, which is worse than an
    error because the operator believes the behaviour is configured.
    """
    stale = sorted(_documented_keys() - _setting_aliases() - COMPOSE_ONLY_KEYS)
    assert stale == [], (
        f"these keys are documented in .env.example but are not Settings fields, so setting them has no effect: {stale}"
    )


@pytest.mark.parametrize(
    "alias",
    [
        "VEYBOT_PORT_UPSTREAM_ENABLED",
        "VEYBOT_PORT_LABEL",
        "VEYBOT_CI_REPAIR_ENABLED",
        "VEYBOT_CI_MAX_REPAIRS",
        "VEYBOT_TRIAGE_TRIGGER",
        "VEYBOT_TRIAGE_LABEL",
        "VEYBOT_AGENT_PROFILE",
    ],
)
def test_the_deployment_critical_knobs_stay_documented(alias: str) -> None:
    """Name the six knobs that were missing, one assertion each.

    The set comparison above already covers them, but it fails as a single
    opaque list. Naming them individually means a regression says which
    capability just became unreachable, and these are the ones a headless
    deployment cannot run without.
    """
    assert alias in _documented_keys(), f"{alias} is no longer documented in .env.example"
    assert alias in _setting_aliases(), f"{alias} is documented but Settings no longer reads it"
