from __future__ import annotations

import pytest
from pydantic import ValidationError

from veybot.config import Settings, reset_settings_cache


def test_settings_load_from_env(env: dict[str, str]) -> None:
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.bot_login == "robveybot"
    assert cfg.repo_allowlist == frozenset({"octo/widget"})
    assert cfg.allows("octo/widget")
    assert cfg.allows("Octo/Widget")
    assert not cfg.allows("other/widget")


def test_settings_missing_required(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    """Empty out every credential source: validator MUST trip the
    'no GitHub access configured' branch. The `env` fixture keeps the other
    required fields satisfied so we isolate the credential-validator path."""
    monkeypatch.setenv("GITHUB_TOKEN", "")
    monkeypatch.setenv("VEYBOT_GH_PROXY_URL", "")
    monkeypatch.setenv("VEYBOT_GH_PROXY_HMAC_KEY", "")
    reset_settings_cache()
    with pytest.raises(ValidationError, match="no GitHub access configured"):
        Settings()  # type: ignore[call-arg]


def test_orchestrator_mode_loads_proxy_config(env: dict[str, str]) -> None:
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.github_token is None
    assert cfg.gh_proxy_url == "http://gh-proxy.invalid:8081"
    assert cfg.gh_proxy_hmac_key is not None
    assert cfg.gh_proxy_hmac_key.get_secret_value().startswith("test-hmac-key")


def test_rejects_token_and_proxy_together(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    monkeypatch.setenv("GITHUB_TOKEN", "x")
    reset_settings_cache()
    with pytest.raises(ValidationError):
        Settings()  # type: ignore[call-arg]


def test_rejects_proxy_url_without_key(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    monkeypatch.setenv("VEYBOT_GH_PROXY_HMAC_KEY", "")
    reset_settings_cache()
    with pytest.raises(ValidationError):
        Settings()  # type: ignore[call-arg]


def test_proxy_mode_loads_pat(proxy_env: dict[str, str]) -> None:
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.github_token is not None
    assert cfg.github_token.get_secret_value() == "ghp_test_token_value_xxxxxxxxxxxxxxxx"
    assert cfg.gh_proxy_url is None
    assert cfg.gh_proxy_hmac_key is None


def test_allowlist_csv_parsing(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    monkeypatch.setenv("VEYBOT_REPO_ALLOWLIST", "  alpha/one ,beta/two, ,gamma/three ")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.repo_allowlist == frozenset({"alpha/one", "beta/two", "gamma/three"})


def test_blank_replay_token_treated_as_disabled(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    monkeypatch.setenv("VEYBOT_REPLAY_TOKEN", "")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.replay_token is None


def test_whitespace_replay_token_treated_as_disabled(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    monkeypatch.setenv("VEYBOT_REPLAY_TOKEN", "   ")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.replay_token is None


def test_real_replay_token_preserved(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    monkeypatch.setenv("VEYBOT_REPLAY_TOKEN", "abc")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.replay_token is not None
    assert cfg.replay_token.get_secret_value() == "abc"


def test_blank_bot_login_rejected(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    monkeypatch.setenv("VEYBOT_BOT_LOGIN", "   ")
    reset_settings_cache()
    with pytest.raises(ValidationError):
        Settings()  # type: ignore[call-arg]


@pytest.mark.parametrize(
    "raw_login",
    [
        "veybot",
        " @veybot ",
        " @VEYBOT ",
        "veybot[bot]",
        "@veybot[bot]",
        " @VEYBOT[BOT] ",
    ],
)
def test_bot_login_normalizes_mention_case_and_app_suffix(
    monkeypatch: pytest.MonkeyPatch, env: dict[str, str], raw_login: str
) -> None:
    monkeypatch.setenv("VEYBOT_BOT_LOGIN", raw_login)
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.bot_login == "veybot"


def test_maintainer_logins_normalize_csv_entries(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    monkeypatch.setenv("VEYBOT_MAINTAINER_LOGINS", " can1357, @VEYBOT , @Alice[bot] ,, ")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.maintainer_logins == frozenset({"can1357", "veybot", "alice"})


@pytest.mark.parametrize(
    ("raw_login", "expected"),
    [
        ("veybot", "veybot"),
        (" @veybot ", "veybot"),
        (" @VEYBOT ", "veybot"),
        ("veybot[bot]", "veybot"),
        ("@veybot[bot]", "veybot"),
        (" @VEYBOT[BOT] ", "veybot"),
    ],
)
def test_maintainer_logins_common_entry_forms(
    monkeypatch: pytest.MonkeyPatch, env: dict[str, str], raw_login: str, expected: str
) -> None:
    monkeypatch.setenv("VEYBOT_MAINTAINER_LOGINS", raw_login)
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.maintainer_logins == frozenset({expected})


def test_model_pool_single(env: dict[str, str]) -> None:
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.model_pool == (cfg.model,)
    assert cfg.pick_model() == cfg.model


def test_model_pool_csv_parses(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    monkeypatch.setenv(
        "VEYBOT_MODEL",
        " codex/gpt-5.4 , anthropic/claude-sonnet-4-6 ,, anthropic/claude-opus-4-7 ",
    )
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.model_pool == (
        "codex/gpt-5.4",
        "anthropic/claude-sonnet-4-6",
        "anthropic/claude-opus-4-7",
    )


def test_pick_model_covers_full_pool(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    """With a 3-item pool and 500 picks, each option appears at least once."""
    monkeypatch.setenv("VEYBOT_MODEL", "a,b,c")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    seen = {cfg.pick_model() for _ in range(500)}
    assert seen == {"a", "b", "c"}


def test_max_concurrency_default_is_8(env: dict[str, str]) -> None:
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.max_concurrency == 8


def test_task_timeout_hard_grace_env_parses(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    monkeypatch.setenv("VEYBOT_TASK_TIMEOUT_HARD_GRACE_SECONDS", "12.5")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.task_timeout_hard_grace_seconds == 12.5


def test_port_and_ci_repair_default_to_enabled(env: dict[str, str]) -> None:
    """The whole point of the deployment is unattended draining, so a fresh
    install must already be draining. Defaulting these off would leave the
    operator with a bot that starts and does nothing, with no error."""
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.port_upstream_enabled is True
    assert cfg.ci_repair_enabled is True
    assert cfg.ci_max_repairs == 3
    assert cfg.port_label == "upstream-port"
    assert cfg.agent_profile == ""


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("false", False), ("0", False), ("true", True), ("1", True)],
)
def test_kill_switches_parse_from_env(
    monkeypatch: pytest.MonkeyPatch, env: dict[str, str], raw: str, expected: bool
) -> None:
    """These are the only way to stop a runaway agent without redeploying, so
    an unparsed value that silently stayed True would be unrecoverable in the
    moment the operator needs it."""
    monkeypatch.setenv("VEYBOT_PORT_UPSTREAM_ENABLED", raw)
    monkeypatch.setenv("VEYBOT_CI_REPAIR_ENABLED", raw)
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.port_upstream_enabled is expected
    assert cfg.ci_repair_enabled is expected


def test_port_label_and_agent_profile_are_stripped(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    """`VEYBOT_PORT_LABEL` is compared against GitHub's exact label text and
    `VEYBOT_AGENT_PROFILE` becomes an argv element. A stray newline from a
    heredoc-written `.env` would make the label never match any issue and the
    profile never resolve, both without an error."""
    monkeypatch.setenv("VEYBOT_PORT_LABEL", "  upstream-port\n")
    monkeypatch.setenv("VEYBOT_AGENT_PROFILE", "  work  ")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.port_label == "upstream-port"
    assert cfg.agent_profile == "work"


def test_blank_port_label_rejected(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    """An empty label would match nothing at all, quietly disabling the port
    task while `port_upstream_enabled` still reports True."""
    monkeypatch.setenv("VEYBOT_PORT_LABEL", "   ")
    reset_settings_cache()
    with pytest.raises(ValidationError):
        Settings()  # type: ignore[call-arg]


@pytest.mark.parametrize("raw", ["0", "-1"])
def test_non_positive_ci_max_repairs_rejected(monkeypatch: pytest.MonkeyPatch, env: dict[str, str], raw: str) -> None:
    """A cap of zero or less makes the attempt arithmetic post the exhausted
    comment on the first red suite forever; refuse the config instead."""
    monkeypatch.setenv("VEYBOT_CI_MAX_REPAIRS", raw)
    reset_settings_cache()
    with pytest.raises(ValidationError):
        Settings()  # type: ignore[call-arg]


def test_triage_trigger_ships_opt_in(env: dict[str, str]) -> None:
    """The shipped default MUST be `label`, not `auto`.

    Every triage is a real agent run against a real model. Under `auto` the
    bot bills the operator for every drive-by issue opened in an allowlisted
    repo, gated only by the rate limiter. This assertion is the tripwire for
    someone "restoring" the old behavior by editing the Settings default —
    note that `github_events.route`'s own parameter default is deliberately
    `auto`, so an argument-passing test would not catch that.
    """
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.triage_trigger == "label"
    assert cfg.triage_label == "veybot"


@pytest.mark.parametrize("mode", ["auto", "label", "mention", "off"])
def test_every_triage_trigger_mode_loads(monkeypatch: pytest.MonkeyPatch, env: dict[str, str], mode: str) -> None:
    """All four documented modes must actually be accepted. A mode that is
    documented but rejected by the model is a startup crash on a config the
    operator was told to use."""
    monkeypatch.setenv("VEYBOT_TRIAGE_TRIGGER", mode)
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.triage_trigger == mode


@pytest.mark.parametrize("raw", ["  AUTO ", "Label\n", "OFF", "\tMention"])
def test_triage_trigger_is_case_and_whitespace_normalized(
    monkeypatch: pytest.MonkeyPatch, env: dict[str, str], raw: str
) -> None:
    """`.env` files written by heredoc carry trailing newlines and operators
    type `AUTO`. Without normalization those become hard startup failures on a
    value the operator meant correctly."""
    monkeypatch.setenv("VEYBOT_TRIAGE_TRIGGER", raw)
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.triage_trigger == raw.strip().lower()


@pytest.mark.parametrize("raw", ["lable", "on", "auto,label", "true", "", "   ", "labels"])
def test_invalid_triage_trigger_is_refused_at_load(
    monkeypatch: pytest.MonkeyPatch, env: dict[str, str], raw: str
) -> None:
    """A typo'd trigger must crash the process, never fall back.

    Both plausible fallbacks are wrong in opposite directions: silently
    treating `lable` as `auto` spends money on every issue, and silently
    treating it as `off` leaves a bot that starts clean and does nothing. The
    operator gets a startup error instead.
    """
    monkeypatch.setenv("VEYBOT_TRIAGE_TRIGGER", raw)
    reset_settings_cache()
    with pytest.raises(ValidationError):
        Settings()  # type: ignore[call-arg]


def test_triage_label_is_stripped(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    """The label is compared against GitHub's exact label text, so a stray
    newline would make `issues.labeled` never match and triage would be dead
    with no error anywhere."""
    monkeypatch.setenv("VEYBOT_TRIAGE_LABEL", "  needs-veybot\n")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.triage_label == "needs-veybot"


@pytest.mark.parametrize("raw", ["", "   ", "\n\t"])
def test_blank_triage_label_refused_in_label_mode(
    monkeypatch: pytest.MonkeyPatch, env: dict[str, str], raw: str
) -> None:
    """Mirrors `_require_port_label`. In `label` mode an empty label matches no
    issue, so triage is silently disabled while `triage_trigger` still reports
    `label` — the operator sees a healthy bot that never picks anything up."""
    monkeypatch.setenv("VEYBOT_TRIAGE_TRIGGER", "label")
    monkeypatch.setenv("VEYBOT_TRIAGE_LABEL", raw)
    reset_settings_cache()
    with pytest.raises(ValidationError, match="VEYBOT_TRIAGE_LABEL"):
        Settings()  # type: ignore[call-arg]


@pytest.mark.parametrize("mode", ["auto", "mention", "off"])
def test_blank_triage_label_allowed_when_the_mode_never_reads_it(
    monkeypatch: pytest.MonkeyPatch, env: dict[str, str], mode: str
) -> None:
    """Refusing an unused empty label would make `VEYBOT_TRIAGE_TRIGGER=off`
    unbootable for anyone who cleared the label alongside it. Only `label`
    mode consults it, so only `label` mode may require it."""
    monkeypatch.setenv("VEYBOT_TRIAGE_TRIGGER", mode)
    monkeypatch.setenv("VEYBOT_TRIAGE_LABEL", "   ")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.triage_label == ""
    assert cfg.triage_trigger == mode


def test_triage_label_override_survives_to_settings(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    """Operators pick their own label; a hardcoded `veybot` in the routing path
    would ignore `VEYBOT_TRIAGE_LABEL` entirely."""
    monkeypatch.setenv("VEYBOT_TRIAGE_LABEL", "please-veybot")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.triage_label == "please-veybot"
    assert cfg.triage_trigger == "label"
