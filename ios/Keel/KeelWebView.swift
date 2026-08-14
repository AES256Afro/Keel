import SwiftUI
import WebKit

struct KeelWebView: UIViewRepresentable {
    let serverURL: URL
    @ObservedObject var pencilBridge: PencilBridge

    func makeCoordinator() -> Coordinator {
        Coordinator(serverURL: serverURL, pencilBridge: pencilBridge)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.applicationNameForUserAgent = "Keel-iOS/1.2.5"
        configuration.userContentController.add(context.coordinator, name: PencilBridge.handlerName)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        pencilBridge.attach(webView)
        webView.load(URLRequest(url: serverURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard webView.url?.origin != serverURL.origin else { return }
        webView.load(URLRequest(url: serverURL))
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: PencilBridge.handlerName)
        coordinator.pencilBridge.detach(webView)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let serverURL: URL
        let pencilBridge: PencilBridge

        init(serverURL: URL, pencilBridge: PencilBridge) {
            self.serverURL = serverURL
            self.pencilBridge = pencilBridge
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            pencilBridge.receive(message)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            pencilBridge.announceReady()
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            if url.origin == serverURL.origin {
                decisionHandler(.allow)
                return
            }
            if navigationAction.navigationType == .linkActivated, ["http", "https"].contains(url.scheme?.lowercased()) {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }
    }
}

private extension URL {
    var origin: String {
        var components = URLComponents()
        components.scheme = scheme?.lowercased()
        components.host = host?.lowercased()
        components.port = port
        return components.string ?? absoluteString
    }
}
