"""The bundled INCOIS intermediate must let plain OpenSSL verification (as on Linux, no
AIA chasing) succeed. truststore is extracted so Windows' AIA fetching can't mask a miss."""
import os

import certifi
import pytest
import requests
import truststore

import server.ocean  # noqa: F401 — builds the bundle, injects truststore

URL = "https://erddap.incois.gov.in/erddap/index.html"


@pytest.fixture(autouse=True)
def plain_openssl():
    truststore.extract_from_ssl()
    yield
    truststore.inject_into_ssl()


def test_bundle_verifies():
    assert requests.head(URL, timeout=30, verify=os.environ["REQUESTS_CA_BUNDLE"]).ok


def test_certifi_alone_does_not():
    # Guards the test above from passing for the wrong reason.
    with pytest.raises(requests.exceptions.SSLError):
        requests.head(URL, timeout=30, verify=certifi.where())
