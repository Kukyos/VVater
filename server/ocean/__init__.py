"""Ocean data ingestion and co-location.

TLS note, and it is not incidental: `erddap.incois.gov.in` serves **only its leaf
certificate** and omits the intermediate, so Python's bundled CA set cannot build a
chain and every request fails with CERTIFICATE_VERIFY_FAILED. curl succeeds, which makes
it look like a Python bug; it is a server misconfiguration.

`truststore` routes verification through the OS trust store, which fetches the missing
intermediate via the certificate's AIA extension. Verification stays fully on — we never
pass `verify=False` at a trust boundary just because a server is misconfigured.

OpenSSL on Linux (Render) does not chase AIA, so the same request fails there. The
intermediate (GlobalSign RSA OV SSL CA 2018, fetched from the leaf's AIA URL, expires
2028-11-21) is bundled in `certs/` and appended to certifi's roots; the combined file is
what both requests and truststore's Linux backend verify against. It is only an
intermediate — it still has to chain to a root already in the bundle.
"""


def _bundle_intermediate() -> None:
    import os
    import tempfile
    from pathlib import Path

    import certifi

    pem = Path(__file__).with_name("certs") / "globalsign-rsa-ov-ssl-ca-2018.pem"
    bundle = Path(tempfile.gettempdir()) / "ocean-ca-bundle.pem"
    bundle.write_text(Path(certifi.where()).read_text() + "\n" + pem.read_text())
    # setdefault: an operator-supplied bundle wins.
    os.environ.setdefault("SSL_CERT_FILE", str(bundle))
    os.environ.setdefault("REQUESTS_CA_BUNDLE", str(bundle))


_bundle_intermediate()

try:
    import truststore

    truststore.inject_into_ssl()
except ImportError:  # pragma: no cover - truststore is in requirements.txt
    pass


def _load_env() -> None:
    """Read .env into the environment without adding a dependency.

    The Copernicus toolbox reads COPERNICUSMARINE_SERVICE_USERNAME/PASSWORD from the
    environment, and every entry point (API, eval harness, tests) needs them, so this
    happens once at import rather than in each caller. Existing environment variables
    win, so a real deployment can set them properly and this becomes a no-op.
    """
    import os
    from pathlib import Path

    env = Path(__file__).resolve().parents[2] / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


_load_env()
