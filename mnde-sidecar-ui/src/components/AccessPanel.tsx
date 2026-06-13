import { useEffect, useState } from "react";
import type { AuthRole, AuthSession } from "../auth/model";
import { bootstrapAdmin, getRbacStatus, upsertRbacAssignment, type RbacAssignment, type RbacStatus } from "../auth/rbac";

interface AccessPanelProps {
  session?: AuthSession;
  onSessionChange: (session: AuthSession) => void;
  authorityGate?: { allowed: boolean; reason: string };
}

const roles: AuthRole[] = ["VIEWER", "OPERATOR", "AUDITOR", "ADMIN"];

export function AccessPanel({ session, onSessionChange, authorityGate }: AccessPanelProps) {
  const [status, setStatus] = useState<RbacStatus>({ bootstrapped: false, can_bootstrap: false, assignments: [] });
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ email: "", user_id: "", display_name: "", role: "VIEWER" as AuthRole });
  const isAdmin = session?.role === "ADMIN";
  const authorityChangeBlocked = status.bootstrapped && authorityGate?.allowed === false;

  async function refresh() {
    setStatus(await getRbacStatus());
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleBootstrap() {
    setMessage("Creating initial authority custodian...");
    const updated = await bootstrapAdmin();
    onSessionChange(updated);
    await refresh();
    setMessage("Initial authority custodian recorded.");
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("Recording authority assignment...");
    setStatus(await upsertRbacAssignment({
      email: form.email,
      user_id: form.user_id,
      display_name: form.display_name,
      role: form.role
    }));
    setForm({ email: "", user_id: "", display_name: "", role: "VIEWER" });
    setMessage("Authority assignment recorded. User must log out and log in again before the authority change is effective.");
  }

  return (
    <div className="space-y-3">
      <section className="authority-panel p-4">
        <div className="authority-eyebrow">Authority Registry</div>
        <h2 className="safe-text mt-1 text-lg font-semibold text-ink">Execution Authority Assignments</h2>
        <p className="safe-text mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Identity establishes who is present. MNDe authority assignments define who may alter policy, replay decisions, export audit records, or control runtime execution.
        </p>
        {message ? <div className="safe-text mt-3 border border-signal/30 bg-signal/10 px-3 py-2 text-xs text-signal">{message}</div> : null}
      </section>

      {!status.bootstrapped ? (
        <section className="border border-warn/35 bg-warn/10 p-4">
          <div className="safe-text text-sm font-semibold text-warn">No authority custodian has been recorded.</div>
          <p className="safe-text mt-2 text-sm leading-relaxed text-muted">
            Bootstrap records the currently signed-in account as the first authority custodian. After this record exists, only custodians may grant authority.
          </p>
          <button className="button mt-3 px-4 text-ink disabled:opacity-45" disabled={!status.can_bootstrap || !session} onClick={handleBootstrap} type="button">
            Record initial custodian
          </button>
          {!status.can_bootstrap ? <p className="safe-text mt-2 text-xs text-danger">Initial custodian cannot be recorded until an enterprise session is present.</p> : null}
        </section>
      ) : null}

      {isAdmin ? (
        <section className="border border-line bg-panel p-4">
          <div className="authority-eyebrow">Grant Authority</div>
          <form className="grid-safe mt-3 grid grid-cols-1 gap-3 md:grid-cols-2" onSubmit={handleSubmit}>
            <label className="block">
              <span className="label">Email</span>
              <input className="input" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="user@company.com" />
            </label>
            <label className="block">
              <span className="label">User ID</span>
              <input className="input" value={form.user_id} onChange={(event) => setForm({ ...form, user_id: event.target.value })} placeholder="optional Entra subject" />
            </label>
            <label className="block">
              <span className="label">Display name</span>
              <input className="input" value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} placeholder="User name" />
            </label>
            <label className="block">
              <span className="label">Role</span>
              <select className="input" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as AuthRole })}>
                {roles.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            </label>
            <button className="button col-span-2 h-10 px-4 text-ink disabled:opacity-45" disabled={authorityChangeBlocked} title={authorityChangeBlocked ? authorityGate?.reason : undefined} type="submit">Record authority assignment</button>
          </form>
          {authorityChangeBlocked ? <p className="safe-text mt-2 text-xs text-danger">Authority changes blocked: {authorityGate?.reason}</p> : null}
        </section>
      ) : status.bootstrapped ? (
        <section className="border border-danger/35 bg-danger/10 p-4 text-sm text-danger">
          Custodian authority is required to grant or change MNDe authority assignments.
        </section>
      ) : null}

      <section className="border border-line bg-panel">
        <div className="border-b border-line px-4 py-3 text-[11px] uppercase tracking-[0.16em] text-muted">Authority Assignments</div>
        <div className="divide-y divide-line">
          {status.assignments.length === 0 ? <div className="p-4 text-sm text-muted">No authority assignments recorded.</div> : null}
          {status.assignments.map((assignment) => <AssignmentRow assignment={assignment} key={`${assignment.user_id ?? ""}:${assignment.email ?? ""}`} />)}
        </div>
      </section>
    </div>
  );
}

function AssignmentRow({ assignment }: { assignment: RbacAssignment }) {
  return (
    <div className="grid-safe grid grid-cols-[minmax(0,1fr)_120px] gap-4 px-4 py-3 text-sm">
      <div className="min-w-0">
        <div className="safe-text font-semibold text-ink">{assignment.display_name || assignment.email || assignment.user_id}</div>
        <div className="mt-1 break-all font-mono text-xs text-muted">{assignment.email ?? "no email"} / {assignment.user_id ?? "no user id"}</div>
      </div>
      <div className="safe-mono font-mono text-signal">{assignment.role}</div>
    </div>
  );
}
