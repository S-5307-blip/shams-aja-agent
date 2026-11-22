import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { formatSar } from "@/lib/models";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const conversation = await db.conversation.findUnique({
    where: { id },
    include: { tenant: { select: { id: true, name: true } }, agent: { select: { id: true, name: true } }, messages: { orderBy: { seq: "asc" } } },
  });
  if (!conversation) notFound();
  const cost = await db.usageEvent.aggregate({ where: { conversationId: id }, _sum: { costMicroUsd: true } });

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <Link href={`/tenants/${conversation.tenant.id}`} className="text-sm text-muted">← {conversation.tenant.name}</Link>
        <h1 className="h1">محادثة مع {conversation.agent.name}</h1>
        <p className="text-sm text-muted">بدأت {formatDateTime(conversation.createdAt)} · مرجع المستخدم: {conversation.userRef ?? "—"} · التكلفة: {formatSar(cost._sum.costMicroUsd ?? 0)}</p>
      </div>
      <div className="space-y-3">
        {conversation.messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "card mr-auto max-w-[85%]" : "card ml-auto max-w-[85%] whitespace-pre-wrap bg-amber-50"}>
            <p className="mb-1 text-xs text-muted">{m.role === "user" ? "المستخدم" : "الوكيل"} · {formatDateTime(m.createdAt)}</p>
            <p className="whitespace-pre-wrap text-sm">{m.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
