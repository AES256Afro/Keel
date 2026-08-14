import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var pencilBridge = PencilBridge()

    var body: some View {
        Group {
            if let serverURL = model.serverURL {
                NavigationStack {
                    KeelWebView(serverURL: serverURL, pencilBridge: pencilBridge)
                        .ignoresSafeArea(edges: .bottom)
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Menu {
                                    Button("Change server", role: .destructive) {
                                        model.disconnect()
                                    }
                                } label: {
                                    Image(systemName: "ellipsis.circle")
                                }
                                .accessibilityLabel("Keel app options")
                            }
                        }
                }
                .sheet(item: $pencilBridge.session) { session in
                    PencilCanvasScreen(
                        session: session,
                        serverURL: serverURL,
                        cookieStore: pencilBridge.cookieStore,
                        onCancel: { pencilBridge.cancel(session) },
                        onSave: { drawing, image in
                            Task { await pencilBridge.save(session, drawing: drawing, image: image) }
                        }
                    )
                    .interactiveDismissDisabled(pencilBridge.isSaving)
                }
            } else {
                ServerSetupView()
            }
        }
        .alert("Apple Pencil", isPresented: $pencilBridge.showError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(pencilBridge.lastError ?? "The drawing could not be saved.")
        }
    }
}
