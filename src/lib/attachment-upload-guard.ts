const MAX_UPLOADS_IN_FLIGHT = 2;
let uploadsInFlight = 0;

export class AttachmentUploadBusyError extends Error {
  constructor() {
    super("The server is busy receiving files. Please try again in a moment.");
    this.name = "AttachmentUploadBusyError";
  }
}

/** Bound aggregate upload buffering across the process. Excess work is shed
 * before the request body is read. */
export async function withAttachmentUploadSlot<T>(work: () => Promise<T>): Promise<T> {
  if (uploadsInFlight >= MAX_UPLOADS_IN_FLIGHT) throw new AttachmentUploadBusyError();
  uploadsInFlight++;
  try {
    return await work();
  } finally {
    uploadsInFlight--;
  }
}
