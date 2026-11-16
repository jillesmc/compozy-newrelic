import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { networkFailureReason, trustSystemCertificates } from "../src/system-ca.ts";

// Invariant: requests to hosts re-signed by a corporate TLS-inspection CA work without
// NODE_EXTRA_CA_CERTS, and a failed request names its cause instead of a bare "network error".
describe("system CA trust", () => {
  test("Should add the operating system CAs to the default roots once", () => {
    let installed: string[] = [];
    const ok = trustSystemCertificates({
      getCACertificates: type => (type === "system" ? ["corp-ca", "shared-root"] : ["shared-root", "bundled"]),
      setDefaultCACertificates: certs => {
        installed = certs;
      },
    });
    assert.equal(ok, true);
    assert.deepEqual(installed.sort(), ["bundled", "corp-ca", "shared-root"]);
  });

  test("Should keep the default roots on runtimes without the CA API or without system CAs", () => {
    assert.equal(trustSystemCertificates({}), false);
    let called = false;
    const ok = trustSystemCertificates({
      getCACertificates: () => [],
      setDefaultCACertificates: () => {
        called = true;
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  });

  test("Should name certificate and network causes of a failed request", () => {
    const failure = (code?: string) => Object.assign(new TypeError("fetch failed"), { cause: code ? { code } : undefined });
    assert.match(networkFailureReason(failure("SELF_SIGNED_CERT_IN_CHAIN")), /TLS certificate not trusted \(SELF_SIGNED_CERT_IN_CHAIN\)/);
    assert.equal(networkFailureReason(failure("ECONNREFUSED")), "network error (ECONNREFUSED)");
    assert.equal(networkFailureReason(failure()), "network error");
  });
});
