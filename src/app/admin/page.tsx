import { notFound, redirect } from "next/navigation";
import { isAdmin } from "@/auth/access";
import { currentUser } from "@/auth/session";
import { getDb } from "@/db";
import { listUsers } from "@/db/repo";
import { Users } from "./Users";

export default async function AdminPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!isAdmin(user)) notFound();

  const users = await listUsers(await getDb());
  return (
    <Users
      users={users
        .filter((u) => u.id !== user.id)
        .map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          status: u.status,
          created: u.createdAt.toLocaleDateString("el-GR", { timeZone: "Europe/Athens" }),
        }))}
    />
  );
}
