# Keel for iOS and iPadOS

Keel's iOS client is a native companion for an existing Keel server. The server remains the source of truth for accounts, workspaces, notes, attachments, access controls, and backups. The app does not try to embed Node.js, Prisma, or SQLite inside an iOS process.

## What this foundation ships

- A SwiftUI iPhone and iPad shell around the responsive Keel application.
- A server chooser that accepts HTTPS origins, with localhost HTTP allowed only for development.
- Persistent `WKWebView` cookies so normal Keel password sessions survive relaunches.
- External links leave the app instead of receiving the authenticated Keel cookie context.
- A versioned, main-frame-only JavaScript bridge named `keelPencil`.
- A native PencilKit canvas with the system tool picker, pressure, tilt, azimuth, palm rejection, predicted low-latency strokes, undo, redo, ruler, zoom, Pencil-only input, optional finger drawing, and Pencil double-tap tool-picker recovery.
- A PNG rendition plus editable `PKDrawing` data uploaded to the current page through Keel's existing attachment authorization, size, and quota checks.
- An editor action to create a drawing or reopen the selected PencilKit drawing.
- A privacy manifest and an App Store-sized icon.

Apple Pencil hardware works on supported iPads. The same canvas remains usable with touch on iPhone and iPad when `Pencil and touch` is selected.

This uses Apple's [`PKCanvasView`](https://developer.apple.com/documentation/pencilkit/pkcanvasview), which captures Apple Pencil and finger input and stores it as a PencilKit drawing. The system tool picker also inherits Apple Pencil Pro squeeze behavior on supported OS and hardware without a Keel-specific gesture implementation.

## Generate and open the project

Install the full Xcode application first. Command Line Tools alone cannot build or archive an iOS app.

```bash
brew install xcodegen
cd ios
xcodegen generate
open Keel.xcodeproj
```

In Xcode:

1. Select the Keel target, then Signing & Capabilities.
2. Choose your Apple Developer team.
3. Replace `com.keelnotes.Keel` if that bundle identifier is unavailable to your team.
4. Run on an iPad with Apple Pencil for hardware validation.
5. Use Product, Archive only after the server, privacy, sign-in, and distribution checklist below is complete.

The CI job generates the same project and builds it for the iOS Simulator with code signing disabled. Simulator success proves the Swift sources and project are buildable, but it cannot prove Pencil pressure, hover, palm rejection, or App Store signing.

## Server requirements

- Production servers must use HTTPS with a certificate trusted by iOS.
- Registration and instance claiming remain server concerns. The app does not weaken them.
- The attachment endpoint must be reachable at the same origin as the Keel UI.
- The app sends the current `WKWebView` session cookies only to that configured origin.
- Password sign-in is the dependable bootstrap path today. Google OAuth commonly refuses embedded web views, so it must not be the only way an iOS operator can sign in.

## Pencil drawing format

Saving produces two page attachments:

- `Apple Pencil <timestamp>.png` is the portable rendition shown by Keel, public page sharing, exports, and non-Apple clients.
- `Apple Pencil <timestamp>.pkdrawing` stores PencilKit's editable vector/ink representation.

The TipTap image node stores the editable attachment URL in `data-keel-pencil`. Selecting that image and choosing `Edit Pencil drawing` reloads the native data into PencilKit. Editing currently creates a new PNG and drawing pair, so a later cleanup milestone should remove superseded attachment pairs once the server has an atomic replacement API.

## Distribution checklist

Before TestFlight or App Store submission:

- Join the Apple Developer Program and create the final App ID, signing certificate, and provisioning profile.
- Install full Xcode and produce a signed archive from a clean `main` revision.
- Test on at least one real Pencil-capable iPad and one iPhone.
- Supply App Store screenshots, support URL, privacy-policy URL, category, age rating, and review notes explaining that Keel connects to a user-controlled server.
- Decide the supported Google sign-in flow. Apple's current [App Review Guideline 4.8](https://developer.apple.com/app-store/review/guidelines/) requires an equivalent privacy-preserving login option when a third-party service is used for the primary account unless an exception applies. Implement Sign in with Apple or document and confirm a valid exception before submission.
- Confirm whether arbitrary self-hosted server entry matches the intended App Review distribution model. A private or unlisted app may be a better first pilot than a public listing.
- Add account deletion before public App Store submission. Keel currently has no account-deletion flow, while Apple requires apps that support account creation to let users [initiate account deletion in the app](https://developer.apple.com/support/offering-account-deletion-in-your-app/).
- Run an archive privacy report and resolve every required-reason API warning. Apple's [privacy manifest documentation](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files) is the source of truth; the initial manifest declares Keel's app-only `UserDefaults` use as `CA92.1`.
- Test offline, expired-session, invalid-certificate, oversized-drawing, interrupted-upload, and server-switch behavior.

## Remaining milestones

1. Hardware Pencil QA and visual polish on 11-inch and 13-inch iPads.
2. Atomic replacement and cleanup for edited drawing attachment pairs.
3. A supported system-browser OAuth return flow, plus Sign in with Apple if the final App Store model requires it.
4. Offline reading and a conflict-safe outbox for text, images, and drawings.
5. Background refresh and push notifications after the server API contract is designed.
6. TestFlight signing, accessibility audit, App Store privacy answers, and review submission.
