"""Host-tool result normalization: the boundary between user tool code and the
wire. A str becomes a single text-content payload; a payload dict passes
through copied; anything else is rejected with a clear TypeError instead of
surfacing an opaque ``dict()`` failure mid-RPC."""

import pytest

from veyyon_rpc import host_tool


def _make_tool(execute):
    return host_tool(
        name="probe",
        description="test tool",
        parameters={"type": "object"},
        execute=execute,
    )


def test_string_result_becomes_text_content() -> None:
    tool = _make_tool(lambda params, ctx: "done")
    assert tool.normalize_result("done") == {"content": [{"type": "text", "text": "done"}]}


def test_payload_dict_passes_through_as_copy() -> None:
    tool = _make_tool(lambda params, ctx: "unused")
    payload = {"content": [{"type": "text", "text": "hi"}], "details": {"n": 1}}
    normalized = tool.normalize_result(payload)
    assert normalized == payload
    assert normalized is not payload


@pytest.mark.parametrize("bad", [None, 42, ["text"], ("content",)])
def test_non_payload_result_raises_clear_type_error(bad) -> None:
    tool = _make_tool(lambda params, ctx: "unused")
    with pytest.raises(TypeError, match="Host tool result must be a string or a result payload dict"):
        tool.normalize_result(bad)
