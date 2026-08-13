"use client";

import Link from "next/link";
import { useActionState } from "react";
import KeelMark from "@/components/KeelMark";

type Action = (
  prev: { error?: string } | undefined,
  formData: FormData
) => Promise<{ error?: string }>;

export default function AuthForm({
  mode,
  action,
  googleEnabled = false,
  oauthError,
  oauthDetail,
}: {
  mode: "login" | "register";
  action: Action;
  googleEnabled?: boolean;
  oauthError?: string | null;
  oauthDetail?: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--panel)] px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="mb-3 flex justify-center">
            <KeelMark size={56} />
          </div>
          <h1 className="text-2xl font-bold">Keel</h1>
          <p className="text-sm text-[var(--muted)] mt-1">
            Pages, blocks and databases. No AI.
          </p>
        </div>
        <form
          action={formAction}
          className="bg-[var(--elevated)] rounded-lg border border-[var(--border)] shadow-sm p-6 space-y-4"
        >
          <h2 className="font-semibold text-lg">
            {mode === "login" ? "Sign in" : "Create your account"}
          </h2>
          {mode === "register" && (
            <label className="block">
              <span className="text-sm text-[var(--muted)]">Name</span>
              <input
                name="name"
                required
                className="mt-1 w-full rounded border border-[var(--border)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
          )}
          <label className="block">
            <span className="text-sm text-[var(--muted)]">Email</span>
            <input
              name="email"
              type="email"
              required
              className="mt-1 w-full rounded border border-[var(--border)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>
          <label className="block">
            <span className="text-sm text-[var(--muted)]">Password</span>
            <input
              name="password"
              type="password"
              required
              minLength={mode === "register" ? 8 : undefined}
              className="mt-1 w-full rounded border border-[var(--border)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>
          {state?.error && (
            <div className="text-sm text-[var(--danger)]">
              <p>{state.error}</p>
              {/* The error itself is deliberately generic - telling someone
                  "that account uses Google" confirms the address is registered.
                  This static hint helps the same user without disclosing it. */}
              {mode === "login" && googleEnabled && (
                <p className="mt-1 text-xs text-[var(--muted)]">
                  If you created this account with Google, use{" "}
                  <strong>Continue with Google</strong> below.
                </p>
              )}
            </div>
          )}
          {oauthError && !state?.error && (
            <p className="text-sm text-[var(--danger)]">
              Google sign-in failed  -  please try again.
              {oauthDetail && (
                <span className="block mt-1 text-xs text-[var(--muted)] break-words">
                  {oauthDetail}
                </span>
              )}
            </p>
          )}
          <button
            type="submit"
            disabled={pending}
            className="w-full rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] py-2 text-sm font-medium hover:bg-[var(--btn-hover)] disabled:opacity-50"
          >
            {pending ? "…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
          {googleEnabled && (
            <>
              <div className="flex items-center gap-3 text-xs text-[var(--faint)]">
                <span className="flex-1 border-t border-[var(--border-soft)]" />
                or
                <span className="flex-1 border-t border-[var(--border-soft)]" />
              </div>
              <a
                href="/api/auth/google"
                className="w-full flex items-center justify-center gap-2 rounded border border-[var(--border)] py-2 text-sm font-medium hover:bg-[var(--hover)]"
              >
                <span className="font-bold text-[var(--link)]">G</span> Continue with Google
              </a>
            </>
          )}
          <p className="text-sm text-[var(--muted)] text-center">
            {mode === "login" ? (
              <>
                No account?{" "}
                <Link className="text-[var(--link)] hover:underline" href="/register">
                  Register
                </Link>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <Link className="text-[var(--link)] hover:underline" href="/login">
                  Sign in
                </Link>
              </>
            )}
          </p>
        </form>
      </div>
    </div>
  );
}
