"""An IOOS outage must read as "gliders unavailable", not fail the observation list."""

from types import SimpleNamespace

import pytest

from server.ocean import glider, instruments


def test_ioos_error_is_an_unavailable_instrument(monkeypatch, tmp_path):
    monkeypatch.setattr(glider.requests, "get",
                        lambda *a, **k: SimpleNamespace(status_code=503, text="Service Unavailable"))
    with pytest.raises(instruments.UNAVAILABLE):
        glider.fetch_deployment("ru29-20180812T0220", tmp_path)
