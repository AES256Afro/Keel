export const KEEL_PENCIL_RESULT_EVENT = "keel:pencil-result";
export const KEEL_PENCIL_READY_EVENT = "keel:pencil-ready";

const ATTACHMENT_URL = /^\/api\/attachments\/[A-Za-z0-9_-]+$/;

type NativeMessageHandler = {
  postMessage(message: unknown): void;
};

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        keelPencil?: NativeMessageHandler;
      };
    };
  }
}

export type PencilRequest = {
  action: "draw" | "edit";
  pageId: string;
  drawingUrl?: string;
};

export type PencilAttachment = {
  name: string;
  url: string;
};

export type PencilResult = {
  image: PencilAttachment;
  drawing: PencilAttachment;
};

type PencilResultDetail = {
  requestId?: unknown;
  status?: unknown;
  message?: unknown;
  image?: unknown;
  drawing?: unknown;
};

function validAttachment(value: unknown): value is PencilAttachment {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PencilAttachment>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    candidate.name.length <= 255 &&
    typeof candidate.url === "string" &&
    ATTACHMENT_URL.test(candidate.url)
  );
}

export function applePencilBridgeAvailable() {
  return typeof window !== "undefined" && Boolean(window.webkit?.messageHandlers?.keelPencil);
}

/**
 * Ask the trusted native iOS shell to present PencilKit.
 *
 * The bridge returns only same-origin attachment URLs. PNG and editable
 * PKDrawing bytes are uploaded by the native client using the WKWebView's
 * authenticated cookie jar, so neither session credentials nor drawing bytes
 * cross the JavaScript bridge.
 */
export function requestApplePencilDrawing(request: PencilRequest): Promise<PencilResult | null> {
  const handler = window.webkit?.messageHandlers?.keelPencil;
  if (!handler) return Promise.reject(new Error("Apple Pencil is available in the Keel iOS app."));
  if (!request.pageId || request.pageId.length > 191) {
    return Promise.reject(new Error("This page cannot accept a drawing."));
  }
  if (request.drawingUrl && !ATTACHMENT_URL.test(request.drawingUrl)) {
    return Promise.reject(new Error("The selected drawing is invalid."));
  }

  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The Apple Pencil session timed out."));
    }, 15 * 60_000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener(KEEL_PENCIL_RESULT_EVENT, onResult as EventListener);
    };

    const onResult = (event: Event) => {
      const detail = (event as CustomEvent<PencilResultDetail>).detail;
      if (!detail || detail.requestId !== requestId) return;
      cleanup();
      if (detail.status === "cancelled") {
        resolve(null);
        return;
      }
      if (detail.status === "error") {
        reject(new Error(typeof detail.message === "string" ? detail.message : "Drawing could not be saved."));
        return;
      }
      if (detail.status !== "saved" || !validAttachment(detail.image) || !validAttachment(detail.drawing)) {
        reject(new Error("The iOS app returned an invalid drawing result."));
        return;
      }
      resolve({ image: detail.image, drawing: detail.drawing });
    };

    window.addEventListener(KEEL_PENCIL_RESULT_EVENT, onResult as EventListener);
    handler.postMessage({
      version: 1,
      requestId,
      action: request.action,
      pageId: request.pageId,
      drawingUrl: request.drawingUrl ?? null,
    });
  });
}
