import { RPCError } from "@compozy/extension-sdk";

export type SourceErrorCode =
  | "source_params_invalid"
  | "source_credential_absent"
  | "source_credential_expired"
  | "source_rate_limited"
  | "source_extension_failed";

export interface SourceErrorData {
  code: SourceErrorCode;
}

/** A check-in source failure: JSON-RPC error -32000 whose data.code the daemon reports. */
export class SourceError extends RPCError<SourceErrorData> {
  /** HTTP status behind the failure, for the stderr line only; never sent to the daemon. */
  readonly httpStatus: number | undefined;
  public constructor(code: SourceErrorCode, message: string, httpStatus?: number) {
    super(-32000, message, { code });
    this.httpStatus = httpStatus;
  }
}

export function sourceError(code: SourceErrorCode, message: string, httpStatus?: number): SourceError {
  return new SourceError(code, message, httpStatus);
}

export function paramsError(message: string): SourceError {
  return new SourceError("source_params_invalid", message);
}
