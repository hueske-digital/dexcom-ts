/** Base class of every error this library throws on purpose. */
export class DexcomError extends Error {
  override name = "DexcomError";
}

/** Credentials or tokens were rejected; the user has to sign in (again). */
export class DexcomAuthError extends DexcomError {
  override name = "DexcomAuthError";
}

/** Dexcom answered with an unexpected HTTP status. */
export class DexcomHttpError extends DexcomError {
  override name = "DexcomHttpError";
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

/** Dexcom answered, but the payload does not match the documented shape. */
export class DexcomResponseError extends DexcomError {
  override name = "DexcomResponseError";
}

/** The request asks for something the source cannot deliver, such as Share data older than 24 h. */
export class DexcomRangeError extends DexcomError {
  override name = "DexcomRangeError";
}
