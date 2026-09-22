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
