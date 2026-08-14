import Combine
import Foundation
import PencilKit
import UIKit
import WebKit

struct PencilSession: Identifiable, Equatable {
    enum Action: String { case draw, edit }

    let id: String
    let action: Action
    let pageID: String
    let drawingURL: String?
}

@MainActor
final class PencilBridge: ObservableObject {
    static let handlerName = "keelPencil"
    static let resultEvent = "keel:pencil-result"
    static let readyEvent = "keel:pencil-ready"

    @Published var session: PencilSession?
    @Published var isSaving = false
    @Published var lastError: String?
    @Published var showError = false

    private weak var webView: WKWebView?
    private(set) var cookieStore: WKHTTPCookieStore?
    private let idPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{1,191}$")
    private let attachmentPattern = try! NSRegularExpression(pattern: "^/api/attachments/[A-Za-z0-9_-]+$")

    func attach(_ webView: WKWebView) {
        self.webView = webView
        cookieStore = webView.configuration.websiteDataStore.httpCookieStore
    }

    func detach(_ webView: WKWebView) {
        if self.webView === webView {
            self.webView = nil
            cookieStore = nil
            session = nil
        }
    }

    func announceReady() {
        webView?.evaluateJavaScript("window.dispatchEvent(new Event('\(Self.readyEvent)'))")
    }

    func receive(_ message: WKScriptMessage) {
        guard message.name == Self.handlerName,
              message.frameInfo.isMainFrame,
              let body = message.body as? [String: Any],
              body["version"] as? Int == 1,
              let requestID = body["requestId"] as? String,
              let actionValue = body["action"] as? String,
              let action = PencilSession.Action(rawValue: actionValue),
              let pageID = body["pageId"] as? String,
              valid(idPattern, requestID),
              valid(idPattern, pageID) else {
            return
        }
        let drawingURL = body["drawingUrl"] as? String
        guard drawingURL == nil || valid(attachmentPattern, drawingURL!) else { return }
        guard session == nil else {
            emit(requestID: requestID, payload: ["status": "error", "message": "Another drawing is already open."])
            return
        }
        session = PencilSession(id: requestID, action: action, pageID: pageID, drawingURL: drawingURL)
    }

    func cancel(_ current: PencilSession) {
        guard session == current else { return }
        emit(requestID: current.id, payload: ["status": "cancelled"])
        session = nil
    }

    func save(_ current: PencilSession, drawing: PKDrawing, image: UIImage) async {
        guard session == current, !isSaving, let webView, let cookieStore, let serverURL = webView.url else { return }
        guard let png = image.pngData() else {
            fail(current, message: "PencilKit could not render this drawing.")
            return
        }
        isSaving = true
        defer { isSaving = false }
        do {
            let uploader = KeelAttachmentUploader(serverURL: serverURL, cookieStore: cookieStore)
            let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
            let imageAttachment = try await uploader.upload(
                data: png,
                filename: "Apple Pencil \(stamp).png",
                mime: "image/png",
                pageID: current.pageID
            )
            let drawingAttachment = try await uploader.upload(
                data: drawing.dataRepresentation(),
                filename: "Apple Pencil \(stamp).pkdrawing",
                mime: "application/octet-stream",
                pageID: current.pageID
            )
            emit(requestID: current.id, payload: [
                "status": "saved",
                "image": ["name": imageAttachment.name, "url": imageAttachment.url],
                "drawing": ["name": drawingAttachment.name, "url": drawingAttachment.url],
            ])
            session = nil
        } catch {
            fail(current, message: error.localizedDescription)
        }
    }

    private func fail(_ current: PencilSession, message: String) {
        lastError = message
        showError = true
        emit(requestID: current.id, payload: ["status": "error", "message": message])
        session = nil
    }

    private func emit(requestID: String, payload: [String: Any]) {
        var detail = payload
        detail["requestId"] = requestID
        detail["version"] = 1
        guard JSONSerialization.isValidJSONObject(detail),
              let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('\(Self.resultEvent)', { detail: \(json) }))"
        )
    }

    private func valid(_ regex: NSRegularExpression, _ value: String) -> Bool {
        regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }
}
