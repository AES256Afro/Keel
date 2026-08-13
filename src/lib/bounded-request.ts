export class RequestBodyTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestBodyTooLargeError";
  }
}

/**
 * Read a request body with a hard byte ceiling before any high-level parser can
 * buffer it. Used for streaming routes that intentionally bypass the proxy.
 */
export async function readBoundedRequestBody(
  req: Request,
  maxBytes: number,
  tooLargeMessage: string
): Promise<Uint8Array> {
  const claimed = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(claimed) && claimed > maxBytes) {
    throw new RequestBodyTooLargeError(tooLargeMessage);
  }
  if (!req.body) return new Uint8Array();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError(tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
