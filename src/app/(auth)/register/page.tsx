import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { googleConfigured } from "@/lib/oauth";
import AuthForm from "../AuthForm";
import { register } from "../actions";

export default async function RegisterPage() {
  if (await getCurrentUser()) redirect("/");
  return <AuthForm mode="register" action={register} googleEnabled={googleConfigured()} />;
}
