import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var serverURL: URL?
    @Published var setupError: String?

    private static let serverKey = "keel.serverURL"

    init() {
        if let stored = UserDefaults.standard.string(forKey: Self.serverKey) {
            serverURL = Self.normalizedServerURL(stored)
        }
    }

    func connect(to value: String) {
        guard let url = Self.normalizedServerURL(value) else {
            setupError = "Enter an HTTPS Keel address. HTTP is allowed only for localhost development."
            return
        }
        UserDefaults.standard.set(url.absoluteString, forKey: Self.serverKey)
        setupError = nil
        serverURL = url
    }

    func disconnect() {
        UserDefaults.standard.removeObject(forKey: Self.serverKey)
        serverURL = nil
        setupError = nil
    }

    static func normalizedServerURL(_ value: String) -> URL? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              let host = components.host?.lowercased(),
              components.user == nil,
              components.password == nil else { return nil }
        let local = host == "localhost" || host == "127.0.0.1" || host == "::1"
        guard components.scheme == "https" || (components.scheme == "http" && local) else { return nil }
        components.path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard components.path.isEmpty, components.query == nil, components.fragment == nil else { return nil }
        components.path = "/"
        return components.url
    }
}
