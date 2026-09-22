"""Ocean data ingestion and co-location.

TLS note, and it is not incidental: `erddap.incois.gov.in` serves **only its leaf
certificate** and omits the intermediate, so Python's bundled CA set cannot build a
chain and every request fails with CERTIFICATE_VERIFY_FAILED. curl succeeds, which makes
it look like a Python bug; it is a server misconfiguration.

`truststore` routes verification through the OS trust store, which fetches the missing
intermediate via the certificate's AIA extension. Verification stays fully on — we never
pass `verify=False` at a trust boundary just because a server is misconfigured.

If this ever fails on a Linux deployment (OpenSSL does not chase AIA as readily), the
fix is to bundle the intermediate and point `REQUESTS_CA_BUNDLE` at it, not to disable
verification. Logged in docs/11-deferred.md.
"""

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
