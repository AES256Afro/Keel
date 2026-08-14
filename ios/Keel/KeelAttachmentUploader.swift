import Foundation
import WebKit

struct UploadedAttachment: Decodable {
    let name: String
    let url: String
}

private struct UploadResponse: Decodable {
    let attachment: UploadedAttachment
}

enum KeelUploadError: LocalizedError {
    case invalidServer
    case unauthenticated
    case rejected(String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .invalidServer: return "The Keel server address is invalid."
        case .unauthenticated: return "Your Keel session expired. Sign in and try again."
        case .rejected(let message): return message
        case .invalidResponse: return "The Keel server returned an invalid upload response."
        }
    }
}

final class KeelAttachmentUploader {
    private let serverURL: URL
    private let cookieStore: WKHTTPCookieStore

    init(serverURL: URL, cookieStore: WKHTTPCookieStore) {
        self.serverURL = serverURL
        self.cookieStore = cookieStore
    }

    func upload(data: Data, filename: String, mime: String, pageID: String) async throws -> UploadedAttachment {
        guard let base = URL(string: "/", relativeTo: serverURL)?.absoluteURL,
              let endpoint = URL(string: "/api/attachments", relativeTo: base)?.absoluteURL else {
            throw KeelUploadError.invalidServer
        }
        let boundary = "KeelPencil-\(UUID().uuidString)"
        var body = Data()
        body.appendUTF8("--\(boundary)\r\n")
        body.appendUTF8("Content-Disposition: form-data; name=\"pageId\"\r\n\r\n")
        body.appendUTF8("\(pageID)\r\n")
        body.appendUTF8("--\(boundary)\r\n")
        body.appendUTF8("Content-Disposition: form-data; name=\"file\"; filename=\"\(safeFilename(filename))\"\r\n")
        body.appendUTF8("Content-Type: \(mime)\r\n\r\n")
        body.append(data)
        body.appendUTF8("\r\n--\(boundary)--\r\n")

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.httpBody = body
        request.timeoutInterval = 120
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue(String(body.count), forHTTPHeaderField: "Content-Length")
        request.setValue(origin(for: base), forHTTPHeaderField: "Origin")
        request.setValue("same-origin", forHTTPHeaderField: "Sec-Fetch-Site")
        let cookies = await allCookies()
        if !cookies.isEmpty {
            let fields = HTTPCookie.requestHeaderFields(with: cookies)
            for (name, value) in fields { request.setValue(value, forHTTPHeaderField: name) }
        }

        let (responseData, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw KeelUploadError.invalidResponse }
        if http.statusCode == 401 { throw KeelUploadError.unauthenticated }
        guard http.statusCode == 201 else {
            let message = (try? JSONSerialization.jsonObject(with: responseData) as? [String: Any])?["error"] as? String
            throw KeelUploadError.rejected(message ?? "Keel refused the drawing upload (\(http.statusCode)).")
        }
        guard let decoded = try? JSONDecoder().decode(UploadResponse.self, from: responseData),
              decoded.attachment.url.range(of: "^/api/attachments/[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
            throw KeelUploadError.invalidResponse
        }
        return decoded.attachment
    }

    func download(path: String) async throws -> Data {
        guard path.range(of: "^/api/attachments/[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
              let endpoint = URL(string: path, relativeTo: serverURL)?.absoluteURL else {
            throw KeelUploadError.invalidResponse
        }
        var request = URLRequest(url: endpoint)
        request.timeoutInterval = 60
        let cookies = await allCookies()
        let fields = HTTPCookie.requestHeaderFields(with: cookies)
        for (name, value) in fields { request.setValue(value, forHTTPHeaderField: name) }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw KeelUploadError.rejected("The editable PencilKit attachment could not be loaded.")
        }
        guard data.count <= 50 * 1024 * 1024 else {
            throw KeelUploadError.rejected("The PencilKit attachment is too large to edit.")
        }
        return data
    }

    private func allCookies() async -> [HTTPCookie] {
        await withCheckedContinuation { continuation in
            cookieStore.getAllCookies { continuation.resume(returning: $0) }
        }
    }

    private func origin(for url: URL) -> String {
        var components = URLComponents()
        components.scheme = url.scheme
        components.host = url.host
        components.port = url.port
        return components.string ?? url.absoluteString
    }

    private func safeFilename(_ value: String) -> String {
        String(value.map { $0 == "\"" || $0 == "\r" || $0 == "\n" ? "_" : $0 }.prefix(180))
    }
}

private extension Data {
    mutating func appendUTF8(_ string: String) {
        append(string.data(using: .utf8)!)
    }
}
