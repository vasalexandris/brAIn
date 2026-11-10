import { redirect } from "next/navigation";
import { isAdmin, isApproved } from "@/auth/access";
import { currentUser } from "@/auth/session";
import { CATEGORY_LABELS, DIMENSIONS } from "@/brain/dimensions";
import { getDb } from "@/db";
import { toProposal } from "@/brain/pipeline";
import { latestSearch, loadBrainState, recentMessages } from "@/db/repo";
import { BUILD } from "@/build";
import { Chat } from "./Chat";
import { Waiting } from "./Waiting";

export default async function ChatPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!isApproved(user)) return <Waiting name={user.name} rejected={user.status === "rejected"} />;

  const db = await getDb();
  const [messages, state, search] = await Promise.all([
    recentMessages(db, user.id, 60),
    loadBrainState(db, user.id),
    latestSearch(db, user.id),
  ]);

  return (
    <Chat
      initialMessages={messages.map((m) => ({ role: m.role, content: m.content }))}
      initialValues={state.values}
      initialImpression={state.impression}
      initialSelfImage={state.selfImage}
      build={BUILD}
      initialSearch={search?.status === "pending" ? toProposal(search) : null}
      dimensions={DIMENSIONS.map(({ key, label, category }) => ({ key, label, category }))}
      categories={CATEGORY_LABELS}
      admin={isAdmin(user)}
    />
  );
}
