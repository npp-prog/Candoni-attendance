import { collection, onSnapshot, query, where, type QueryConstraint } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { isAttendanceAdmin } from '../../shared/roles';
import type { MemberDoc } from '../../shared/types';
import { useSession } from '../context/AuthContext';
import { db } from '../firebase';

export type MemberRow = MemberDoc & { supervisorName?: string | null };

/** Members visible to the viewer: all for HR/sysadmin, supervised departments for supervisors. */
export function useScopedMembers() {
  const { member, orgId } = useSession();
  const [map, setMap] = useState<Record<string, MemberRow[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const deptKey = member.supervisedDepartmentIds.join(',');
  useEffect(() => {
    const ref = collection(db, 'organizations', orgId, 'members');
    const queries: [string, QueryConstraint[]][] = isAttendanceAdmin(member.role)
      ? [['all', []]]
      : deptKey
        ? deptKey.split(',').map((d) => [d, [where('departmentId', '==', d)]])
        : [];
    if (!queries.length) {
      setLoaded(true);
      return;
    }
    let pending = queries.length;
    const unsubs = queries.map(([k, c]) =>
      onSnapshot(
        query(ref, ...c),
        (s) => {
          setMap((m) => ({ ...m, [k]: s.docs.map((d) => ({ ...(d.data() as MemberRow), uid: d.id })) }));
          if (--pending <= 0) setLoaded(true);
        },
        (e) => setError(e.message),
      ),
    );
    return () => unsubs.forEach((u) => u());
  }, [orgId, member.role, deptKey]);
  const members = Object.values(map)
    .flat()
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { members, error, loaded };
}

export function useCollection<T>(path: string[], constraints: QueryConstraint[] = [], key = '') {
  const [items, setItems] = useState<(T & { id: string })[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pathKey = path.join('/');
  useEffect(() => {
    const [first, ...rest] = path;
    return onSnapshot(
      query(collection(db, first, ...rest), ...constraints),
      (s) => setItems(s.docs.map((d) => ({ ...(d.data() as T), id: d.id }))),
      (e) => setError(e.message),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathKey, key]);
  return { items, error };
}
