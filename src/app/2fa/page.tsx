import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getPending, PENDING_COOKIE } from "@/lib/pending-2fa";
import TwoFactorClient from "@/components/TwoFactorClient";

export const dynamic = "force-dynamic";

export default async function TwoFactorPage() {
  const store = await cookies();
  // No pending first-factor → nothing to complete.
  if (!getPending(store.get(PENDING_COOKIE)?.value)) redirect("/login");
  return <TwoFactorClient />;
}
