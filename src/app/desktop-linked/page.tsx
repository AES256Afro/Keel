/** Shown in the system browser after a desktop-app Google sign-in completes.
 *  The session was handed to the app window; nothing more to do here. */
import KeelMark from "@/components/KeelMark";

export default function DesktopLinkedPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--panel)] px-4">
      <div className="w-full max-w-sm text-center">
        <div className="mb-4 flex justify-center">
          <KeelMark size={56} />
        </div>
        <h1 className="text-xl font-semibold">You&apos;re signed in</h1>
        <p className="text-sm text-[var(--muted)] mt-2">
          Return to the Keel app - it&apos;s finishing signing you in now. You
          can close this tab.
        </p>
      </div>
    </div>
  );
}
