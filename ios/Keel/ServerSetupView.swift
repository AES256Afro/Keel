import SwiftUI

struct ServerSetupView: View {
    @EnvironmentObject private var model: AppModel
    @State private var address = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Your Keel server") {
                    TextField("https://notes.example.com", text: $address)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                    if let error = model.setupError {
                        Text(error).foregroundStyle(.red)
                    }
                }
                Section {
                    Button("Connect") { model.connect(to: address) }
                        .disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Section {
                    Text("Keel for iOS connects to a Keel server you control. Your notes remain on that server. Apple Pencil drawings are saved to the current page as an image plus editable PencilKit ink.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Connect to Keel")
        }
    }
}
