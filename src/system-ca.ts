import tls from "node:tls";

type CaApi = {
  getCACertificates?: (type: "default" | "system") => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
};

/**
 * Trusts the operating system's CA store in addition to Node's bundled roots.
 *
 * Corporate TLS inspection (Netskope, Zscaler) re-signs company hosts with a CA that only the OS
 * store knows. CompozyOS starts extensions with a scrubbed environment, so NODE_EXTRA_CA_CERTS from
 * the user's shell does not reach this process; without this, every request to an inspected host
 * fails with SELF_SIGNED_CERT_IN_CHAIN. Needs Node 22.19+/24.5+; older runtimes keep the default
 * roots (and still honor NODE_EXTRA_CA_CERTS when it is set).
 */
export function trustSystemCertificates(api: CaApi = tls as unknown as CaApi): boolean {
  if (typeof api.getCACertificates !== "function" || typeof api.setDefaultCACertificates !== "function") {
    return false;
  }
  const system = api.getCACertificates("system");
  if (system.length === 0) return false;
  api.setDefaultCACertificates([...new Set([...api.getCACertificates("default"), ...system])]);
  return true;
}

const CERTIFICATE_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
]);

/** Describes a failed fetch without its message text, which may echo request details. */
export function networkFailureReason(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : "";
  if (!code) return "network error";
  if (CERTIFICATE_CODES.has(code)) {
    return `TLS certificate not trusted (${code}); install the network's CA in the operating system store`;
  }
  return `network error (${code})`;
}
