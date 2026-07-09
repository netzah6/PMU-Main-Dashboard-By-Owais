"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, Sparkles, ChevronDown, ChevronRight, Copy, ExternalLink, Check } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Draft = { contactName: string; channel: string; draft: string; voice: string; conversationUrl: string };
type Msg = { role: "user" | "assistant"; content: string; queries?: string[]; drafts?: Draft[] };

export default function AskPage() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);

  const send = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setError(null);
    setInput("");
    const history = [...msgs, { role: "user" as const, content: q }];
    setMsgs(history);
    setBusy(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      setMsgs((m) => [...m, { role: "assistant", content: json.answer, queries: json.queries, drafts: json.drafts }]);
    } catch (e) {
      setError(`${e}`.replace("Error: ", ""));
      setMsgs((m) => m.slice(0, -1));
      setInput(q);
    } finally {
      setBusy(false);
    }
  }, [busy, msgs]);

  return (
    <div className="flex flex-col h-full max-w-3xl mx-auto w-full p-4 sm:p-6">
      <div className="mb-3">
        <h1 className="text-xl font-bold text-[#1f3559] flex items-center gap-2"><Sparkles size={18} className="text-[#15B7AE]" /> AI</h1>
        <p className="text-sm text-[#697a91]">Ask about clients, leads and payments · get client reports · check unread messages · draft replies in your voice.</p>
      </div>

      <div className="flex-1 overflow-y-auto space-y-3 pb-4">
        {msgs.length === 0 && (
          <div className="pt-16 text-center text-sm text-[#8595a8]">
            Ask anything, type a client&apos;s name for their report, ask &quot;what&apos;s unread?&quot;, or &quot;draft a reply to …&quot;.
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn(
              "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words",
              m.role === "user"
                ? "bg-[#15B7AE] text-white rounded-br-md"
                : "bg-white border border-[#e4ebf2] text-[#1f3559] rounded-bl-md",
            )}>
              {m.content}
              {m.role === "assistant" && (m.drafts ?? []).map((d, j) => <DraftCard key={j} d={d} />)}
              {m.role === "assistant" && (m.queries?.length ?? 0) > 0 && <QueryDetails queries={m.queries!} />}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-md px-4 py-2.5 bg-white border border-[#e4ebf2] text-sm text-[#697a91] flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-[#15B7AE]" /> Querying the data…
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && <div className="mb-2 px-3 py-2 rounded-lg border border-[#f5c2cf] bg-[#fde8ee] text-[#e11d48] text-xs">{error}</div>}

      <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. How many leads does Sabby Beauty have this month?"
          className="flex-1 px-4 py-3 bg-white border border-[#d7e0ea] rounded-xl text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}
          className="px-4 py-3 rounded-xl bg-[#15B7AE] hover:bg-[#0e8f88] text-white disabled:opacity-50 flex items-center gap-1.5 text-sm font-semibold">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </button>
      </form>
    </div>
  );
}

function DraftCard({ d }: { d: Draft }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(d.draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }, [d.draft]);
  return (
    <div className="mt-2.5 rounded-xl border border-[#a7e3df] bg-[#f7fdfc] p-3">
      <p className="text-[10px] font-bold uppercase tracking-wide text-[#0e8f88] mb-1.5">
        Draft for {d.contactName}{d.channel ? ` · ${d.channel}` : ""}{d.voice ? ` · in ${d.voice}'s style` : ""}
      </p>
      <p className="text-sm text-[#1f3559] whitespace-pre-wrap">{d.draft}</p>
      <div className="flex items-center gap-2 mt-2.5">
        <button
          onClick={() => { copy(); window.open(d.conversationUrl, "_blank", "noopener"); toast.success("Draft copied — paste it in the chat"); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#15B7AE] hover:bg-[#0e8f88] text-white text-xs font-semibold">
          <ExternalLink size={12} /> Copy &amp; open chat
        </button>
        <button onClick={() => { copy(); toast.success("Draft copied"); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#a7e3df] text-[#0e8f88] hover:bg-white text-xs font-semibold">
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
        </button>
        <span className="text-[10px] text-[#8595a8]">draft only — you send it</span>
      </div>
    </div>
  );
}

function QueryDetails({ queries }: { queries: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 pt-2 border-t border-[#f1f5f9]">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-[10px] font-semibold text-[#8595a8] hover:text-[#0e8f88]">
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} {queries.length} {queries.length === 1 ? "query" : "queries"} run
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {queries.map((q, i) => (
            <pre key={i} className="text-[10px] leading-snug bg-[#f8fafc] border border-[#eef3f8] rounded-lg p-2 overflow-x-auto text-[#34568a]">{q}</pre>
          ))}
        </div>
      )}
    </div>
  );
}
