import { redirect } from "next/navigation";
import { currentUser } from "@/auth/session";
import { AuthForm } from "../AuthForm";

export default async function Page() {
  if (await currentUser()) redirect("/chat");
  return <AuthForm mode="login" />;
}
