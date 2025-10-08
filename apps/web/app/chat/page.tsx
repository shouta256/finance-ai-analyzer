"use client";
import { useState } from "react";
import { sendChatMessage } from "@/src/lib/api-client";
import { ChatMessage } from "@/src/lib/schemas";
import Link from "next/link";

export default function ChatPage() {
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const disabled = loading || input.trim().length === 0;

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "USER",
      content: input,
      createdAt: new Date().toISOString(),
    } as ChatMessage; // optimistic
    setMessages((m) => [...m, userMsg]);
    const msg = input;
    setInput("");
    setLoading(true);
    try {
      const res = await sendChatMessage({ conversationId, message: msg });
      setConversationId(res.conversationId);
      setMessages(res.messages);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">AI Chat Assistant</h1>
        <Link href="/dashboard" className="text-sm text-blue-600 hover:underline">Dashboard</Link>
      </div>
      <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-4 h-80 overflow-y-auto space-y-3 pr-1">
          {messages.length === 0 && (
            <p className="text-sm text-slate-500">
              メッセージを入力してください。支出やカテゴリについて質問できます。
            </p>
          )}
          {messages.map(m => (
            <div key={m.id} className={m.role === "USER" ? "text-right" : "text-left"}>
              <div className={`inline-block rounded px-3 py-2 text-sm whitespace-pre-wrap ${m.role === "USER" ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-800"}`}>
                {m.content}
              </div>
            </div>
          ))}
        </div>
        <form onSubmit={handleSend} className="flex gap-2">
          <input
            className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            placeholder="例: 先月の飲食カテゴリーはどれくらい?"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
          />
          <button
            type="submit"
            disabled={disabled}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >{loading ? "送信中" : "送信"}</button>
        </form>
      </div>
    </main>
  );
}
