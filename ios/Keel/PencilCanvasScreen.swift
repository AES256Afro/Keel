import PencilKit
import SwiftUI
import WebKit

struct PencilCanvasScreen: UIViewControllerRepresentable {
    let session: PencilSession
    let serverURL: URL
    let cookieStore: WKHTTPCookieStore?
    let onCancel: () -> Void
    let onSave: (PKDrawing, UIImage) -> Void

    func makeUIViewController(context: Context) -> UINavigationController {
        let controller = PencilCanvasViewController(
            session: session,
            serverURL: serverURL,
            cookieStore: cookieStore,
            onCancel: onCancel,
            onSave: onSave
        )
        return UINavigationController(rootViewController: controller)
    }

    func updateUIViewController(_ controller: UINavigationController, context: Context) {}
}

final class PencilCanvasViewController: UIViewController, PKCanvasViewDelegate, UIPencilInteractionDelegate {
    private let session: PencilSession
    private let serverURL: URL
    private let cookieStore: WKHTTPCookieStore?
    private let onCancel: () -> Void
    private let onSave: (PKDrawing, UIImage) -> Void
    private let canvasView = PKCanvasView()
    private let toolPicker = PKToolPicker()
    private var pencilOnly = true

    init(
        session: PencilSession,
        serverURL: URL,
        cookieStore: WKHTTPCookieStore?,
        onCancel: @escaping () -> Void,
        onSave: @escaping (PKDrawing, UIImage) -> Void
    ) {
        self.session = session
        self.serverURL = serverURL
        self.cookieStore = cookieStore
        self.onCancel = onCancel
        self.onSave = onSave
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = session.action == .edit ? "Edit drawing" : "New drawing"
        view.backgroundColor = .systemBackground
        canvasView.translatesAutoresizingMaskIntoConstraints = false
        canvasView.backgroundColor = .systemBackground
        canvasView.delegate = self
        canvasView.drawingPolicy = .pencilOnly
        canvasView.minimumZoomScale = 0.5
        canvasView.maximumZoomScale = 4
        view.addSubview(canvasView)
        NSLayoutConstraint.activate([
            canvasView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            canvasView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            canvasView.topAnchor.constraint(equalTo: view.topAnchor),
            canvasView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .cancel,
            target: self,
            action: #selector(cancelTapped)
        )
        navigationItem.rightBarButtonItems = [
            UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(doneTapped)),
            UIBarButtonItem(image: UIImage(systemName: "hand.draw"), menu: inputMenu()),
        ]
        toolbarItems = [
            UIBarButtonItem(barButtonSystemItem: .undo, target: self, action: #selector(undoTapped)),
            UIBarButtonItem(barButtonSystemItem: .redo, target: self, action: #selector(redoTapped)),
            .flexibleSpace(),
            UIBarButtonItem(title: "Ruler", style: .plain, target: self, action: #selector(toggleRuler)),
        ]
        navigationController?.isToolbarHidden = false

        let pencilInteraction = UIPencilInteraction()
        pencilInteraction.delegate = self
        view.addInteraction(pencilInteraction)

        if session.action == .edit, let path = session.drawingURL {
            loadDrawing(path)
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        toolPicker.setVisible(true, forFirstResponder: canvasView)
        toolPicker.addObserver(canvasView)
        canvasView.becomeFirstResponder()
    }

    override func viewWillDisappear(_ animated: Bool) {
        toolPicker.removeObserver(canvasView)
        super.viewWillDisappear(animated)
    }

    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        toolPicker.setVisible(true, forFirstResponder: canvasView)
        canvasView.becomeFirstResponder()
    }

    @objc private func cancelTapped() { onCancel() }

    @objc private func doneTapped() {
        let drawing = canvasView.drawing
        let bounds = drawing.bounds.isEmpty ? canvasView.bounds : drawing.bounds.insetBy(dx: -24, dy: -24)
        let image = drawing.image(from: bounds, scale: UIScreen.main.scale)
        onSave(drawing, image)
    }

    @objc private func undoTapped() { canvasView.undoManager?.undo() }
    @objc private func redoTapped() { canvasView.undoManager?.redo() }
    @objc private func toggleRuler() { canvasView.isRulerActive.toggle() }

    private func inputMenu() -> UIMenu {
        UIMenu(children: [
            UIAction(title: "Pencil only", state: pencilOnly ? .on : .off) { [weak self] _ in
                self?.setPencilOnly(true)
            },
            UIAction(title: "Pencil and touch", state: pencilOnly ? .off : .on) { [weak self] _ in
                self?.setPencilOnly(false)
            },
        ])
    }

    private func setPencilOnly(_ value: Bool) {
        pencilOnly = value
        canvasView.drawingPolicy = value ? .pencilOnly : .anyInput
        navigationItem.rightBarButtonItems?[1].menu = inputMenu()
    }

    private func loadDrawing(_ path: String) {
        guard let cookieStore else { return }
        let uploader = KeelAttachmentUploader(serverURL: serverURL, cookieStore: cookieStore)
        Task {
            do {
                let data = try await uploader.download(path: path)
                let drawing = try PKDrawing(data: data)
                await MainActor.run { self.canvasView.drawing = drawing }
            } catch {
                await MainActor.run {
                    let alert = UIAlertController(
                        title: "Drawing unavailable",
                        message: error.localizedDescription,
                        preferredStyle: .alert
                    )
                    alert.addAction(UIAlertAction(title: "Start over", style: .default))
                    self.present(alert, animated: true)
                }
            }
        }
    }
}

private extension UIBarButtonItem {
    static func flexibleSpace() -> UIBarButtonItem {
        UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil)
    }
}
