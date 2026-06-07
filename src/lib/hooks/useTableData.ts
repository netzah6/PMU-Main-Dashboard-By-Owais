"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";

interface UseTableDataOptions {
  table: string;
  realtimeEnabled?: boolean;
}

// Module-level cache shared across all pages/components for the session.
// Navigating away and back shows cached rows instantly, then revalidates.
const tableCache = new Map<string, unknown[]>();
const inflight = new Map<string, Promise<unknown[]>>();

async function loadTable(table: string): Promise<unknown[]> {
  const supabase = createClient();
  type DbRow = { id: string; sheet_row: number | null; data: Record<string, unknown> };

  const PAGE = 1000;
  let offset = 0;
  const all: DbRow[] = [];

  while (true) {
    const { data: rows, error } = await supabase
      .from(table)
      .select("id, sheet_row, data")
      .order("sheet_row", { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) break;
    all.push(...(rows as DbRow[]));
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  return all.map((r) => {
    const rowData = r.data ?? {};
    return { ...rowData, _supabase_id: r.id, _row_number: r.sheet_row ?? rowData.row_number ?? null };
  });
}

export function useTableData<T>({ table, realtimeEnabled = false }: UseTableDataOptions) {
  // Seed from cache so navigation is instant
  const cached = tableCache.get(table) as T[] | undefined;
  const [data, setData] = useState<T[]>(cached ?? []);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const supabaseRef = useRef(createClient());

  const fetchData = useCallback(async (background = false) => {
    if (!background && !tableCache.has(table)) setLoading(true);
    setError(null);
    try {
      // De-dupe concurrent requests for the same table
      let p = inflight.get(table);
      if (!p) { p = loadTable(table); inflight.set(table, p); }
      const rows = await p.finally(() => inflight.delete(table));

      tableCache.set(table, rows);
      setData(rows as T[]);
    } catch (e) {
      console.error(`[useTableData] ${table}:`, e);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [table]);

  useEffect(() => {
    // If we have cache, revalidate quietly in the background; else show loader
    fetchData(Boolean(tableCache.get(table)));

    if (!realtimeEnabled) return;

    const supabase = supabaseRef.current;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const channel = supabase
      .channel(`realtime:${table}`)
      .on("postgres_changes", { event: "*", schema: "public", table }, () => {
        setSyncing(true);
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          fetchData(true).then(() => setTimeout(() => setSyncing(false), 800));
        }, 600);
      })
      .subscribe();

    return () => {
      if (debounce) clearTimeout(debounce);
      supabase.removeChannel(channel);
    };
  }, [table, realtimeEnabled, fetchData]);

  return { data, loading, error, syncing, refetch: () => fetchData(true) };
}
