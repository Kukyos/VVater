"""The assistant's loop, with a scripted model instead of the network."""

import json

from server.ocean import assistant


def test_tool_loop_and_number_check(monkeypatch):
    monkeypatch.setitem(assistant.TOOLS, "value_at", (
        lambda **kw: {"value": 28.93, "native_level_m": 5.0, "units": "degC"},
        assistant.TOOLS["value_at"][1]))
    script = iter([
        {"choices": [{"message": {"role": "assistant", "content": "", "tool_calls": [
            {"id": "a", "function": {"name": "value_at",
                                     "arguments": json.dumps({"lat": 15, "lon": 88, "depth_m": 5})}},
            {"id": "b", "function": {"name": "ui_action",
                                     "arguments": json.dumps({"action": "set_depth", "depth_m": 9e9})}},
            {"id": "c", "function": {"name": "ui_action",
                                     "arguments": json.dumps({"action": "delete_everything"})}},
        ]}}]},
        {"choices": [{"message": {"role": "assistant",
                                  "content": "It is 28.9 °C at the 5 m level, not 31.2 °C."}}]},
    ])
    out = assistant.run([{"role": "user", "content": "temperature at 15N 88E?"}],
                        transport=lambda payload: next(script))
    assert out["tools_used"] == ["value_at", "ui_action", "ui_action"]
    # The depth is clamped and the unknown action dropped, before the browser sees either.
    assert out["actions"] == [{"action": "set_depth", "depth_m": 2000.0}]
    # 28.9 is supported by the tool's 28.93; 31.2 is not, and is reported.
    assert out["unverified"] == ["31.2"]


def test_self_checks():
    assistant.demo()
