"use client";
import { useEffect, useState } from "react";
import { fetchChatConversation, sendChatMessage } from "@/src/lib/api-client";
import { ChatMessage } from "@/src/lib/schemas";
import Link from "next/link";

export default function ChatPage() {
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const disabled = loading || initializing || input.trim().length === 0;

  const editingMessage = editingMessageId ? messages.find((m) => m.id === editingMessageId) : undefined;
  const storageKey = "safepocket_chat_conversation_id";

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setInitializing(true);
      try {
        const storedId = typeof window !== "undefined" ? window.localStorage.getItem(storageKey) ?? undefined : undefined;
        const res = await fetchChatConversation(storedId);
        if (cancelled) return;
        setConversationId(res.conversationId);
        setMessages(res.messages);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(storageKey, res.conversationId);
        }
      } catch (error) {
        console.error(error);
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(storageKey);
        }
      } finally {
        if (!cancelled) setInitializing(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    const msg = input;
    const previousMessages = messages;
    setInput("");
    setLoading(true);
    try {
      if (editingMessage) {
        setMessages((current) => current.map((m) => (m.id === editingMessage.id ? { ...m, content: msg } : m)));
      } else {
        const userMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "USER",
          content: msg,
          createdAt: new Date().toISOString(),
        } as ChatMessage;
        setMessages((current) => [...current, userMsg]);
      }
      const res = await sendChatMessage({ conversationId, message: msg });
      setConversationId(res.conversationId);
      setMessages(res.messages);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(storageKey, res.conversationId);
      }
      setEditingMessageId(null);
    } catch (err) {
      console.error(err);
      setMessages(previousMessages);
      setInput(msg);
      if (editingMessage) {
        setEditingMessageId(editingMessage.id);
      }
    } finally {
      setLoading(false);
    }
  }

  function handleStartEdit(message: ChatMessage) {
    setEditingMessageId(message.id);
    setInput(message.content);
  }

  function handleCancelEdit() {
    setEditingMessageId(null);
    setInput("");
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">AI Chat Assistant</h1>
        <Link href="/dashboard" className="text-sm text-blue-600 hover:underline">Dashboard</Link>
      </div>
      <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-4 h-80 overflow-y-auto space-y-3 pr-1">
          {initializing && (
            <p className="text-sm text-slate-500">読み込み中...</p>
          )}
          {!initializing && messages.length === 0 && (
            <p className="text-sm text-slate-500">
              メッセージを入力してください。支出やカテゴリについて質問できます。
            </p>
          )}
          {messages.map((m) => {
            const isUser = m.role === "USER";
            const isEditingTarget = editingMessageId === m.id;
            return (
              <div key={m.id} className={isUser ? "text-right" : "text-left"}>
                <div className={`group relative inline-block rounded px-3 py-2 text-sm whitespace-pre-wrap ${isUser ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-800"}`}>
                  {m.content}
                  {isUser && !loading && !initializing && (
                    <button
                      type="button"
                      onClick={() => handleStartEdit(m)}
                      className="absolute -right-8 top-1/2 inline-flex -translate-y-1/2 items-center rounded-full border border-slate-200 bg-white p-1 text-slate-500 opacity-0 shadow transition-opacity duration-150 group-hover:opacity-100 hover:text-blue-600 focus-visible:outline-none focus-visible:ring focus-visible:ring-blue-200"
                    >
                      <span className="sr-only">メッセージを編集</span>
                      <span aria-hidden>✏️</span>
                    </button>
                  )}
                  {isEditingTarget && (
                    <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-xs text-blue-600">編集モード</span>
                  )}
                </div>
              </div>
            );
          })}
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
          {editingMessage && (
            <button
              type="button"
              onClick={handleCancelEdit}
              className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
              disabled={loading}
            >キャンセル</button>
          )}
        </form>
      </div>
    </main>
  );
}
