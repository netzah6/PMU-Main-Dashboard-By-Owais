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

    // Fetch both id and data so we can do targeted updates
    const { data: rows, error: err } = await supabaseRef.current
      .from(table)
      .select("id, data")
      .order("id", { ascending: true });

    if (err) {
      console.error(`[useTableData] ${table}:`, err.message);
      setError(err.message);
      setLoading(false);
      return;
    }

    if (!rows || rows.length === 0) {
      setData([]);
      setLoading(false);
      return;
    }

    type DbRow = { id: string; data: Record<string, unknown> };
    const mapped = (rows as DbRow[]).map((r) => {
      const rowData = r.data ?? {};
      return {
        ...rowData,
        _supabase_id: r.id,
        _row_number: rowData.row_number ?? null,
      } as T;
    });

    setData(mapped);
    setLoading(false);
  }, [table]);

  useEffect(() => {
    fetchData();
    if (!realtimeEnabled) return;

    const supabase = supabaseRef.current;
    const channel = supabase
      .channel(`realtime:${table}`)
      .on("postgres_changes", { event: "*", schema: "public", table }, () => {
        setSyncing(true);
        fetchData().then(() => setTimeout(() => setSyncing(false), 1500));
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [table, realtimeEnabled, fetchData]);

  return { data, loading, error, syncing, refetch: fetchData };
}
