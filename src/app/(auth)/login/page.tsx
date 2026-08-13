import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { googleConfigured } from "@/lib/oauth";
import AuthForm from "../AuthForm";
import { login } from "../actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; detail?: string }>;
}) {
  if (await getCurrentUser()) redirect("/");
  const { error, detail } = await searchParams;
  return (
    <AuthForm
      mode="login"
      action={login}
      googleEnabled={googleConfigured()}
      oauthError={error ?? null}
      oauthDetail={detail ?? null}
    />
  );
}
