import { collection, getDocs, limit, orderBy, query, startAfter, where, type DocumentSnapshot, type QueryConstraint } from 'firebase/firestore';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Field, PageLoader, Select } from '../../components/ui';
import { useSession } from '../../context/AuthContext';
import { db } from '../../firebase';
import { fmtDateTime, fmtMeters } from '../../lib/format';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ACTIONS = ['', 'attendance.adjust', 'request.approve', 'request.reject', 'request.submit', 'role.change', 'employee.create', 'employee.update', 'employee.activate', 'employee.deactivate', 'schedule.upsert', 'schedule.assign', 'workplace.upsert', 'holiday.upsert', 'settings.update', 'privacy.accept', 'summaries.rebuild', 'retention.run'];

function usePagedQuery(collName: string, constraints: QueryConstraint[], key: string) {
  const { orgId } = useSession();
  const [items, setItems] = useState<any[]>([]);
  const [cursor, setCursor] = useState<DocumentSnapshot | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    async (after: DocumentSnapshot | null) => {
      setLoading(true);
      try {
        const c = [...constraints, ...(after ? [startAfter(after)] : []), limit(25)];
        const snap = await getDocs(query(collection(db, 'organizations', orgId, collName), ...c));
        setItems((prev) => [...(after ? prev : []), ...snap.docs.map((d) => ({ id: d.id, ...d.data() }))]);
        setCursor(snap.docs[snap.docs.length - 1] ?? null);
        setDone(snap.size < 25);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orgId, collName, key],
  );
  useEffect(() => {
    load(null);
  }, [load]);
  return { items, loading, error, more: () => load(cursor), done };
}

export default function Audit() {
  const [tab, setTab] = useState<'audit' | 'attempts'>('audit');
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold text-navy-900">Audit & attempts</h1>
      <div className="flex gap-2" role="tablist">
        <Button role="tab" aria-selected={tab === 'audit'} variant={tab === 'audit' ? 'primary' : 'secondary'} onClick={() => setTab('audit')}>
          Audit log
        </Button>
        <Button role="tab" aria-selected={tab === 'attempts'} variant={tab === 'attempts' ? 'primary' : 'secondary'} onClick={() => setTab('attempts')}>
          Rejected attempts
        </Button>
      </div>
      {tab === 'audit' ? <AuditLog /> : <Attempts />}
    </div>
  );
}

function AuditLog() {
  const { tz } = useSession();
  const [action, setAction] = useState('');
  const c: QueryConstraint[] = action ? [where('action', '==', action), orderBy('at', 'desc')] : [orderBy('at', 'desc')];
  const { items, loading, error, more, done } = usePagedQuery('auditLogs', c, action);
  return (
    <>
      <Field label="Action">
        {(id) => (
          <Select id={id} value={action} onChange={(e) => setAction(e.target.value)} className="sm:w-80">
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a || 'All actions'}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
      {!loading && items.length === 0 && <EmptyState title="No audit entries" />}
      <ul className="flex flex-col gap-2">
        {items.map((a) => (
          <li key={a.id}>
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge tone="info">{a.action}</Badge>
                <span className="text-xs text-slate-600">{fmtDateTime(a.at, tz)}</span>
              </div>
              <p className="mt-1 text-sm">
                <strong>{a.actorName}</strong> ({a.actorRole}) · {a.targetType} <span className="font-mono text-xs">{a.targetId}</span>
              </p>
              {a.reason && <p className="text-sm text-slate-700">Reason: {a.reason}</p>}
              <details className="mt-1 text-xs">
                <summary className="cursor-pointer text-brand-700">Before / after</summary>
                <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-slate-50 p-2">{JSON.stringify({ before: a.before, after: a.after }, null, 2)}</pre>
              </details>
            </Card>
          </li>
        ))}
      </ul>
      {loading && <PageLoader />}
      {!done && !loading && (
        <Button variant="secondary" onClick={more}>
          Load more
        </Button>
      )}
    </>
  );
}

function Attempts() {
  const { tz } = useSession();
  const { items, loading, error, more, done } = usePagedQuery('attendanceAttempts', [orderBy('at', 'desc')], 'attempts');
  return (
    <>
      <p className="text-sm text-slate-600">Rejected clock-in/out attempts with the reason code. Coordinates are visible to HR and system administrators only.</p>
      {error && <Alert tone="danger">{error}</Alert>}
      {!loading && items.length === 0 && <EmptyState title="No rejected attempts" />}
      <ul className="flex flex-col gap-2">
        {items.map((a) => (
          <li key={a.id}>
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">{a.memberName}</span>
                <Badge tone="danger">{a.code}</Badge>
              </div>
              <p className="text-sm text-slate-700">
                {a.action} · {fmtDateTime(a.at, tz)}
              </p>
              <p className="text-sm text-slate-700">{a.message}</p>
              {a.location && (
                <p className="text-xs text-slate-600">
                  {a.location.lat?.toFixed?.(6)}, {a.location.lng?.toFixed?.(6)} · ±{Math.round(a.location.accuracy)} m
                  {a.details?.distanceMeters != null && ` · ${fmtMeters(a.details.distanceMeters)} from ${a.details.nearestWorkplace}`}
                </p>
              )}
            </Card>
          </li>
        ))}
      </ul>
      {loading && <PageLoader />}
      {!done && !loading && (
        <Button variant="secondary" onClick={more}>
          Load more
        </Button>
      )}
    </>
  );
}
