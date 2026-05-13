export class FailClosedError extends Error {
  readonly layer: string;
  readonly code: string;

  constructor(
    layer: string,
    code: string,
    message: string
  ) {
    super(message);
    this.name = "FailClosedError";
    this.layer = layer;
    this.code = code;
  }
}
