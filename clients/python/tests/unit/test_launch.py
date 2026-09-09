from __future__ import annotations

import json
import sys

import pytest

from agent_android import cli
from agent_android.client import AgentAndroidClient
from agent_android.repl import AriaReplSession


def test_chooser_is_not_reported_as_success_and_preserves_duplicate_choices(monkeypatch, capsys):
    client = AgentAndroidClient("http://192.168.3.200:8080")
    sent = []
    details = {"status": "selection_required", "launched": False,
               "choices": [{"index": 1, "label": "App"}, {"index": 2, "label": "App"}]}

    def request(payload, **kwargs):
        sent.append((payload, kwargs))
        return {"success": True, "data": {"outputs": {"launchResult": details}}}

    monkeypatch.setattr(client, "_api_call", request)
    assert client.launch_app("pkg.app", raw=True) is False
    assert json.loads(capsys.readouterr().out) == details
    assert sent[0][0]["operations"][0]["parameters"]["selectionHandling"] == "return"
    assert sent[0][1]["timeout"] == 13


def test_explicit_choice_and_total_budget_are_sent_once(monkeypatch, capsys):
    client = AgentAndroidClient("http://device:8080")
    requests = []

    def request(payload, **kwargs):
        requests.append((payload, kwargs))
        return {"success": True, "data": {"outputs": {"launchResult": {"status": "launched", "launched": True}}}}

    monkeypatch.setattr(client, "_api_call", request)
    assert client.launch_app("pkg.app", choice_index=2, timeout_ms=3000)
    assert len(requests) == 1
    assert requests[0][0]["operations"][0]["parameters"]["choiceIndex"] == 2
    assert requests[0][1]["timeout"] == 8
    assert "Launched: pkg.app" in capsys.readouterr().out


def test_old_server_missing_launch_result_fails_without_retry(monkeypatch, capsys):
    client = AgentAndroidClient("http://device:8080")
    requests = []
    monkeypatch.setattr(client, "_api_call", lambda *a, **kw: requests.append(a) or {"success": True})
    assert not client.launch_app("pkg.app")
    assert len(requests) == 1
    assert "Update the phone-side" in capsys.readouterr().out


@pytest.mark.parametrize("args", [
    {"choice_index": 0}, {"choice_index": 1.5}, {"choice_index": True},
    {"choice_index": 1, "choice_text": "App"}, {"choice_text": " "},
    {"timeout_ms": 999}, {"timeout_ms": 30001},
])
def test_invalid_launch_options_do_not_send_requests(monkeypatch, args):
    client = AgentAndroidClient("http://device:8080")
    monkeypatch.setattr(client, "_api_call", lambda *_a, **_kw: pytest.fail("Unexpected request"))
    with pytest.raises(ValueError):
        client.launch_app("pkg.app", **args)


@pytest.mark.parametrize("status, expected", [("launched", 0), ("selection_required", 2), ("failed", 1)])
def test_cli_launch_exit_codes_and_flags(monkeypatch, status, expected):
    calls = []

    class Client:
        def __init__(self, url, token=None):
            self.base_url = url
            self.last_launch_result = {"status": status}

        def launch_app(self, package, **kwargs):
            calls.append((package, kwargs))
            return status == "launched"

    monkeypatch.setattr(cli, "AgentAndroidClient", Client)
    monkeypatch.setattr(sys, "argv", ["agent-android", "--url", "http://device:8080", "--launch", "pkg.app",
                                      "--launch-choice", "2", "--launch-timeout", "5", "--raw"])
    with pytest.raises(SystemExit) as exc:
        cli.main()
    assert exc.value.code == expected
    assert calls == [("pkg.app", {"choice_index": 2, "choice_text": None, "timeout_ms": 5000, "raw": True})]


def test_repl_launch_choice_parsing_and_cache_invalidation(monkeypatch):
    # Reuse the real client so validation and REPL behavior stay aligned.
    client = AgentAndroidClient("http://device:8080")
    session = AriaReplSession.__new__(AriaReplSession)
    session.client = client
    calls = []
    monkeypatch.setattr(client, "launch_app", lambda *a, **kw: calls.append((a, kw)) or False)
    monkeypatch.setattr(session, "_invalidate_tree", lambda: calls.append("invalidate"))
    assert session._cmd_launch(["pkg.app", "--choice", "2", "--timeout", "4"]) is False
    assert calls == [(("pkg.app",), {"choice_index": 2, "timeout_ms": 4000}), "invalidate"]
