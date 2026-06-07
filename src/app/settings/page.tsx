"use client";
import { useEffect, useState } from "react";
import { useUser } from "@/lib/hooks/useUser";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Navbar } from "@/components/layout/Navbar";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { UserPlus, Settings, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { UserRoleRecord, UserRole } from "@/lib/types";

export default function SettingsPage() {
  const { user, role, loading: userLoading } = useUser();
  const router = useRouter();
  const supabase = createClient();

  const [users, setUsers] = useState<UserRoleRecord[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<UserRole>("viewer");
  const [inviting, setInviting] = useState(false);

  useEffect(() => {
    if (!userLoading && role !== "admin") {
      router.push("/");
    }
  }, [userLoading, role, router]);

  useEffect(() => {
    if (role !== "admin") return;
    setLoadingUsers(true);
    supabase
      .from("user_roles")
      .select("*")
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        setUsers((data as UserRoleRecord[]) ?? []);
        setLoadingUsers(false);
      });
  }, [role, supabase]);

  async function fetchUsers() {
    setLoadingUsers(true);
    const { data } = await supabase
      .from("user_roles")
      .select("*")
      .order("created_at", { ascending: true });
    setUsers((data as UserRoleRecord[]) ?? []);
    setLoadingUsers(false);
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    try {
      const res = await fetch("/api/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      toast.success(`Invitation sent to ${inviteEmail}`);
      setInviteEmail("");
      fetchUsers();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setInviting(false);
    }
  }

  async function handleRoleChange(userId: string, newRole: UserRole) {
    const { error } = await supabase
      .from("user_roles")
      .update({ role: newRole })
      .eq("user_id", userId);
    if (error) {
      toast.error("Failed to update role");
    } else {
      toast.success("Role updated");
      fetchUsers();
    }
  }

  if (userLoading) return null;
  if (role !== "admin") return null;

  const roleVariant = (r: UserRole) =>
    r === "admin" ? "teal" : r === "editor" ? "blue" : "gray";

  return (
    <div className="flex flex-col min-h-screen">
      <Navbar userEmail={user?.email} />

      <div className="max-w-3xl mx-auto w-full px-6 py-8 space-y-8">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "#15B7AE20" }}>
            <Settings size={18} style={{ color: "#15B7AE" }} />
          </div>
          <div>
            <h1 className="text-xl font-bold text-[#1f3559]">Settings</h1>
            <p className="text-sm text-[#697a91]">User management — Admin only</p>
          </div>
        </div>

        {/* Invite form */}
        <div className="bg-white border border-[#e4ebf2] rounded-xl p-6 space-y-4">
          <h2 className="text-sm font-semibold text-[#1e2a3a] flex items-center gap-2">
            <UserPlus size={15} className="text-[#0e8f88]" />
            Invite New User
          </h2>
          <form onSubmit={handleInvite} className="flex gap-3">
            <input
              type="email"
              placeholder="user@pmu-bookings.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              required
              className="flex-1 px-3 py-2 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE]"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as UserRole)}
              className="px-3 py-2 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-sm text-[#34568a] focus:outline-none focus:border-[#15B7AE]"
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
              <option value="admin">Admin</option>
            </select>
            <button
              type="submit"
              disabled={inviting}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-[#1f3559] transition-all disabled:opacity-60"
              style={{ background: "#15B7AE" }}
            >
              {inviting ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
              Invite
            </button>
          </form>
        </div>

        {/* Users list */}
        <div className="bg-white border border-[#e4ebf2] rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-[#e4ebf2]">
            <h2 className="text-sm font-semibold text-[#1e2a3a]">Team Members</h2>
          </div>

          {loadingUsers ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : (
            <div className="divide-y divide-[#e4ebf2]">
              {users.map((u) => (
                <div key={u.id} className="flex items-center justify-between px-6 py-4">
                  <div>
                    <p className="text-sm font-medium text-[#1f3559]">{u.email}</p>
                    <p className="text-xs text-[#8595a8] font-mono">{u.user_id}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant={roleVariant(u.role)}>{u.role}</Badge>
                    {u.user_id !== user?.id && (
                      <select
                        value={u.role}
                        onChange={(e) => handleRoleChange(u.user_id, e.target.value as UserRole)}
                        className="px-2 py-1 bg-[#eef2f7] border border-[#d7e0ea] rounded text-xs text-[#34568a] focus:outline-none"
                      >
                        <option value="viewer">Viewer</option>
                        <option value="editor">Editor</option>
                        <option value="admin">Admin</option>
                      </select>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Role reference */}
        <div className="bg-white border border-[#e4ebf2] rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-medium text-[#34568a]">Role Permissions</h3>
          <div className="space-y-2 text-xs text-[#697a91]">
            <div className="flex gap-3">
              <Badge variant="teal">admin</Badge>
              <span>Full access — invite users, edit all data, manage roles</span>
            </div>
            <div className="flex gap-3">
              <Badge variant="blue">editor</Badge>
              <span>Can edit client data, notes, and step trackers</span>
            </div>
            <div className="flex gap-3">
              <Badge variant="gray">viewer</Badge>
              <span>Read-only access to all dashboards</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
