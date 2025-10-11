"use client";
import { useEffect, useRef, useState } from "react";
import { fetchChatConversation, sendChatMessage } from "@/src/lib/api-client";
import { ChatMessage } from "@/src/lib/schemas";
import Link from "next/link";
import { Copy, Pencil } from "lucide-react";

export default function ChatPage() {
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
const [input, setInput] = useState("");
const [loading, setLoading] = useState(false);
const [initializing, setInitializing] = useState(true);
const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
const [editingDraft, setEditingDraft] = useState("");
const [editingLoading, setEditingLoading] = useState(false);
const disabled = loading || initializing || editingMessageId !== null || input.trim().length === 0;
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);

const editingMessage = editingMessageId ? messages.find((m) => m.id === editingMessageId) : undefined;
const editingIndex = editingMessageId ? messages.findIndex((m) => m.id === editingMessageId) : -1;
  const storageKey = "safepocket_chat_conversation_id";

const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
  const el = scrollAreaRef.current;
  if (el) {
    el.scrollTo({ top: el.scrollHeight, behavior });
  }
};

const copyToClipboard = async (content: string) => {
  try {
    await navigator.clipboard.writeText(content);
  } catch (error) {
    console.error("Failed to copy message", error);
  }
};

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
        requestAnimationFrame(() => scrollToBottom("auto"));
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
      requestAnimationFrame(() => scrollToBottom());
      const res = await sendChatMessage({
        conversationId,
        message: msg,
        truncateFromMessageId: editingMessage ? editingMessage.id : undefined,
      });
      setConversationId(res.conversationId);
      setMessages(res.messages);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(storageKey, res.conversationId);
      }
      setEditingMessageId(null);
      requestAnimationFrame(() => scrollToBottom());
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

  useEffect(() => {
    if (!initializing) {
      scrollToBottom("smooth");
    }
  }, [messages, initializing]);

function handleStartEdit(message: ChatMessage) {
  if (message.role !== "USER") return;
  setEditingMessageId(message.id);
  setEditingDraft(message.content);
  setEditingLoading(false);
  requestAnimationFrame(() => scrollToBottom("auto"));
}

async function handleCancelEdit() {
  setEditingMessageId(null);
  setEditingDraft("");
  setEditingLoading(false);
  try {
    const res = await fetchChatConversation(conversationId);
    setConversationId(res.conversationId);
    setMessages(res.messages);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, res.conversationId);
    }
    requestAnimationFrame(() => scrollToBottom("auto"));
  } catch (error) {
    console.error(error);
  }
}

async function handleSubmitEdit(event: React.FormEvent) {
  event.preventDefault();
  if (!editingMessageId || editingDraft.trim().length === 0 || editingLoading) return;
  const msg = editingDraft;
  setEditingLoading(true);
  try {
    const res = await sendChatMessage({
      conversationId,
      message: msg,
      truncateFromMessageId: editingMessageId,
    });
    setConversationId(res.conversationId);
    setMessages(res.messages);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, res.conversationId);
    }
    setEditingMessageId(null);
    setEditingDraft("");
    requestAnimationFrame(() => scrollToBottom());
  } catch (error) {
    console.error(error);
  } finally {
    setEditingLoading(false);
  }
}

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">AI Chat Assistant</h1>
        <Link href="/dashboard" className="text-sm text-blue-600 hover:underline">Dashboard</Link>
      </div>
      <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
        <div ref={scrollAreaRef} className="mb-4 h-80 overflow-y-auto space-y-3 pr-1">
          {initializing && (
            <p className="text-sm text-slate-500">読み込み中...</p>
          )}
          {!initializing && messages.length === 0 && (
            <p className="text-sm text-slate-500">
              メッセージを入力してください。支出やカテゴリについて質問できます。
            </p>
          )}
          {messages.map((m, idx) => {
            if (editingIndex >= 0 && idx > editingIndex) {
              return null;
            }
            const isUser = m.role === "USER";
            const isEditingTarget = editingMessageId === m.id;
            const bubbleTone = isUser ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-800";
            return (
              <div key={m.id} className={`group ${isUser ? "text-right" : "text-left"}`}>
                {isEditingTarget ? (
                  <form
                    onSubmit={handleSubmitEdit}
                    className={`inline-flex w-full flex-col gap-2 rounded px-3 py-2 text-sm ${bubbleTone}`}
                  >
                    <textarea
                      value={editingDraft}
                      onChange={(event) => setEditingDraft(event.target.value)}
                      className="min-h-[96px] w-full resize-none rounded border border-transparent bg-inherit text-inherit outline-none focus:border-white/30"
                      autoFocus
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        disabled={editingLoading}
                        className="rounded border border-white/30 px-3 py-1 text-xs font-medium text-white/80 hover:text-white"
                      >
                        キャンセルする
                      </button>
                      <button
                        type="submit"
                        disabled={editingLoading || editingDraft.trim().length === 0}
                        className="rounded bg-white px-3 py-1 text-xs font-medium text-blue-600 disabled:opacity-50"
                      >
                        送信する
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className={`inline-block rounded px-3 py-2 text-sm whitespace-pre-wrap ${bubbleTone}`}>
                      {m.content}
                    </div>
                    {isUser && !loading && !initializing && (
                      <div className="mt-1 flex items-center justify-end gap-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={() => copyToClipboard(m.content)}
                          className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:text-blue-600 focus-visible:outline-none focus-visible:ring focus-visible:ring-blue-200"
                        >
                          <Copy className="h-3.5 w-3.5" aria-hidden /> コピー
                        </button>
                        <button
                          type="button"
                          onClick={() => handleStartEdit(m)}
                          className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:text-blue-600 focus-visible:outline-none focus-visible:ring focus-visible:ring-blue-200"
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden /> 編集
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {(loading || editingLoading) && (
            <div className="text-left">
              <div className="inline-block rounded bg-slate-100 px-3 py-2 text-sm text-slate-600">
                アシスタントが返信を生成しています…
              </div>
            </div>
          )}
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
