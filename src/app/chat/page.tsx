import { redirect } from "next/navigation";
import { currentUser } from "@/auth/session";
import { CATEGORY_LABELS, DIMENSIONS } from "@/brain/dimensions";
import { getDb } from "@/db";
import { loadBrainState, recentMessages } from "@/db/repo";
import { Chat } from "./Chat";

export default async function ChatPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const db = await getDb();
  const [messages, state] = await Promise.all([recentMessages(db, user.id, 60), loadBrainState(db, user.id)]);

  return (
    <Chat
      initialMessages={messages.map((m) => ({ role: m.role, content: m.content }))}
      initialValues={state.values}
      initialImpression={state.impression}
      dimensions={DIMENSIONS.map(({ key, label, category }) => ({ key, label, category }))}
      categories={CATEGORY_LABELS}
    />
  );
}
