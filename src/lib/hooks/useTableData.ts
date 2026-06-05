"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";

interface UseTableDataOptions {
  table: string;
  realtimeEnabled?: boolean;
}

export function useTableData<T>({ table, realtimeEnabled = false }: UseTableDataOptions) {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const supabaseRef = useRef(createClient());

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    type DbRow = { id: string; sheet_row: number | null; data: Record<string, unknown> };

    // Supabase caps each request at 1000 rows — page through with .range()
    const PAGE = 1000;
    let offset = 0;
    const all: DbRow[] = [];

    while (true) {
      const { data: rows, error: err } = await supabaseRef.current
        .from(table)
        .select("id, sheet_row, data")
        .order("sheet_row", { ascending: true })
        .range(offset, offset + PAGE - 1);

      if (err) {
        console.error(`[useTableData] ${table}:`, err.message);
        setError(err.message);
        setLoading(false);
        return;
      }
      if (!rows || rows.length === 0) break;
      all.push(...(rows as DbRow[]));
      if (rows.length < PAGE) break;
      offset += PAGE;
    }

    const mapped = all.map((r) => {
      const rowData = r.data ?? {};
      return {
        ...rowData,
        _supabase_id: r.id,
        _row_number: r.sheet_row ?? rowData.row_number ?? null,
      } as T;
    });

    setData(mapped);
    setLoading(false);
  }, [table]);

  useEffect(() => {
    fetchData();
    if (!realtimeEnabled) return;

    const supabase = supabaseRef.current;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const channel = supabase
      .channel(`realtime:${table}`)
      .on("postgres_changes", { event: "*", schema: "public", table }, () => {
        // Debounce: a bulk sync fires many events — refetch once after they settle
        setSyncing(true);
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          fetchData().then(() => setTimeout(() => setSyncing(false), 800));
        }, 600);
      })
      .subscribe();

    return () => {
      if (debounce) clearTimeout(debounce);
      supabase.removeChannel(channel);
    };
  }, [table, realtimeEnabled, fetchData]);

  return { data, loading, error, syncing, refetch: fetchData };
}
