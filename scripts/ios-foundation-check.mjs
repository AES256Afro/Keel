import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
let checks = 0;

function check(message, condition) {
  assert.ok(condition, message);
  checks += 1;
}

const project = read("ios/project.yml");
const plist = read("ios/Keel/Info.plist");
const privacy = read("ios/Keel/PrivacyInfo.xcprivacy");
const bridge = read("ios/Keel/PencilBridge.swift");
const canvas = read("ios/Keel/PencilCanvasScreen.swift");
const uploader = read("ios/Keel/KeelAttachmentUploader.swift");
const webBridge = read("src/lib/apple-pencil.ts");
const editor = read("src/components/Editor.tsx");

check("the project targets iOS 17", project.includes('iOS: "17.0"'));
check("the project supports iPhone and iPad", project.includes('TARGETED_DEVICE_FAMILY: "1,2"'));
check("XcodeGen preserves the tracked privacy-aware Info.plist", project.includes("INFOPLIST_FILE: Keel/Info.plist") && !project.includes("\n    info:\n"));
check("the app refuses arbitrary transport loads", /<key>NSAllowsArbitraryLoads<\/key>\s*<false\/>/.test(plist));
check("the app declares its UserDefaults reason", privacy.includes("NSPrivacyAccessedAPICategoryUserDefaults") && privacy.includes("CA92.1"));
check("the native bridge accepts only main-frame messages", bridge.includes("message.frameInfo.isMainFrame"));
check("the native bridge validates page and attachment identifiers", bridge.includes("idPattern") && bridge.includes("attachmentPattern"));
check("the native bridge returns no drawing bytes through JavaScript", !bridge.includes("base64EncodedString"));
check("PencilKit drawing data is saved alongside the PNG", bridge.includes("drawing.dataRepresentation()") && bridge.includes("image.pngData()"));
check("the canvas defaults to Pencil-only input", canvas.includes("canvasView.drawingPolicy = .pencilOnly"));
check("the canvas supports the system Pencil tool picker", canvas.includes("PKToolPicker") && canvas.includes("UIPencilInteractionDelegate"));
check("native uploads carry the same-origin boundary", uploader.includes('forHTTPHeaderField: "Origin"') && uploader.includes('"same-origin"'));
check("native uploads reuse WKWebView cookies", uploader.includes("cookieStore.getAllCookies"));
check("the browser bridge is versioned and request-bound", webBridge.includes("version: 1") && webBridge.includes("requestId"));
check("the browser bridge accepts only Keel attachment URLs", webBridge.includes("ATTACHMENT_URL.test"));
check("the editor stores an editable Pencil attachment", editor.includes('"data-keel-pencil"') && editor.includes("result.drawing.url"));
check("the Pencil toolbar is native-app-only", editor.includes("applePencilBridgeAvailable") && editor.includes("pencilAvailable"));

const icon = path.join(root, "ios/Keel/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png");
check("the App Store icon exists", fs.existsSync(icon));
if (fs.existsSync(icon)) {
  const bytes = fs.readFileSync(icon);
  check("the App Store icon is a 1024x1024 PNG", bytes.subarray(1, 4).toString("ascii") === "PNG" && bytes.readUInt32BE(16) === 1024 && bytes.readUInt32BE(20) === 1024);
}

console.log(`iOS and Apple Pencil foundation passed ${checks}/${checks} checks.`);
