import { collection, limit, onSnapshot, orderBy, query, where, type QueryConstraint } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { canReviewRequest, isAttendanceAdmin } from '../../../shared/roles';
import { REQUEST_TYPE_LABELS, type RequestType } from '../../../shared/types';
import { Alert, PageLoader, Button, Card, EmptyState, Field, Input, Modal, Pager, Select, Textarea, Toast, usePaged } from '../../components/ui';
import { useSession } from '../../context/AuthContext';
import { db } from '../../firebase';
import { callApi } from '../../lib/api';
import { fmtDateShort, fmtDateTime } from '../../lib/format';
import { RequestStatusBadge, RequestSummary } from '../employee/Requests';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function AdminRequests() {
  const { member, orgId, org, tz, departments } = useSession();
  const admin = isAttendanceAdmin(member.role);
  const [status, setStatus] = useState('pending');
  const [dept, setDept] = useState(admin ? '' : member.supervisedDepartmentIds[0] ?? '');
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<{ r: any; decision: 'approve' | 'reject' } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!admin && !dept) {
      setItems([]);
      return;
    }
    const c: QueryConstraint[] = [];
    if (dept) c.push(where('departmentId', '==', dept));
    if (status) c.push(where('status', '==', status));
    c.push(orderBy('createdAt', 'desc'), limit(300));
    setItems(null);
    return onSnapshot(
      query(collection(db, 'organizations', orgId, 'correctionRequests'), ...c),
      (s) => setItems(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (e) => setError(e.message),
    );
  }, [orgId, dept, status, admin]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (items ?? []).filter((r) => (!type || r.type === type) && (!q || r.memberName?.toLowerCase().includes(q) || r.employeeNumber?.toLowerCase().includes(q)));
  }, [items, type, search]);
  const paged = usePaged(filtered, 15);
  const deptOptions = admin ? Object.entries(departments) : member.supervisedDepartmentIds.map((d) => [d, departments[d] ?? d] as [string, string]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold text-navy-900">Correction, fieldwork & WFH approvals</h1>
      {org.settings.approvalMode === 'hr_only' && !admin && <Alert tone="info">Approvals are currently limited to HR. You can view requests in your departments.</Alert>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label="Status">
          {(id) => (
            <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="cancelled">Cancelled</option>
              <option value="">All</option>
            </Select>
          )}
        </Field>
        <Field label="Department">
          {(id) => (
            <Select id={id} value={dept} onChange={(e) => setDept(e.target.value)}>
              {admin && <option value="">All departments</option>}
              {deptOptions.map(([d, n]) => (
                <option key={d} value={d}>
                  {n}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Type">
          {(id) => (
            <Select id={id} value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All types</option>
              {(Object.keys(REQUEST_TYPE_LABELS) as RequestType[]).map((t) => (
                <option key={t} value={t}>
                  {REQUEST_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Search">{(id) => <Input id={id} type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Employee" />}</Field>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {!items && !error && <PageLoader />}
      {items && filtered.length === 0 && <EmptyState title={status === 'pending' ? 'No pending requests' : 'No requests found'} />}
      <ul className="flex flex-col gap-2">
        {paged.slice.map((r) => {
          const perm = canReviewRequest(member, { memberId: r.memberId, departmentId: r.departmentId }, org.settings.approvalMode);
          return (
            <li key={r.id}>
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold text-navy-900">
                      {r.memberName} <span className="text-sm font-normal text-slate-600">({r.employeeNumber})</span>
                    </p>
                    <p className="text-sm text-slate-700">
                      {REQUEST_TYPE_LABELS[r.type as RequestType]} · work date {fmtDateShort(r.workDate)} · {departments[r.departmentId] ?? r.departmentId}
                    </p>
                    <p className="text-xs text-slate-500">Submitted {fmtDateTime(r.createdAt, tz)}</p>
                  </div>
                  <RequestStatusBadge status={r.status} />
                </div>
                <div className="mt-2">
                  <RequestSummary r={r} tz={tz} />
                </div>
                {r.status === 'pending' &&
                  (perm.ok ? (
                    <div className="mt-3 flex gap-2">
                      <Button variant="teal" onClick={() => setReviewing({ r, decision: 'approve' })}>
                        ✓ Approve
                      </Button>
                      <Button variant="secondary" onClick={() => setReviewing({ r, decision: 'reject' })}>
                        ✕ Reject
                      </Button>
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-slate-600">{perm.reason}</p>
                  ))}
              </Card>
            </li>
          );
        })}
      </ul>
      <Pager {...paged} />
      {reviewing && (
        <ReviewDialog
          r={reviewing.r}
          decision={reviewing.decision}
          onClose={() => setReviewing(null)}
          onDone={(msg) => {
            setReviewing(null);
            setToast(msg);
          }}
        />
      )}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function ReviewDialog({ r, decision, onClose, onDone }: { r: any; decision: 'approve' | 'reject'; onClose: () => void; onDone: (m: string) => void }) {
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      await callApi('request.review', { id: r.id, decision, remarks });
      onDone(decision === 'approve' ? 'Request approved.' : 'Request rejected.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title={decision === 'approve' ? 'Approve request' : 'Reject request'}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-slate-700">
          {r.memberName} — {REQUEST_TYPE_LABELS[r.type as RequestType]} for {r.workDate}
        </p>
        {decision === 'approve' && (r.type === 'missing_punch' || r.type === 'incorrect_punch') && (
          <Alert tone="info">Approving records a separate adjustment. The original attendance event is preserved.</Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={decision === 'reject' ? 'Reason (required)' : 'Remarks (optional)'}>{(id) => <Textarea id={id} value={remarks} onChange={(e) => setRemarks(e.target.value)} />}</Field>
        <Button variant={decision === 'approve' ? 'teal' : 'danger'} loading={busy} disabled={decision === 'reject' && remarks.trim().length < 3} onClick={go}>
          Confirm {decision}
        </Button>
      </div>
    </Modal>
  );
}
