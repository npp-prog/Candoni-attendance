import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { collection, doc, getDoc, onSnapshot } from 'firebase/firestore';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_SETTINGS } from '../../shared/defaults';
import type { MemberDoc, OrganizationDoc } from '../../shared/types';
import { auth, db, ORG_ID } from '../firebase';

export interface Branding {
  name: string;
  shortName: string;
  logoUrl: string | null;
}

interface AuthState {
  loading: boolean;
  user: User | null;
  orgId: string | null;
  member: (MemberDoc & { supervisorName?: string | null }) | null;
  org: OrganizationDoc | null;
  departments: Record<string, string>;
  branding: Branding;
  error: string | null;
  logout: () => Promise<void>;
}

const DEFAULT_BRANDING: Branding = { name: 'ClockUp', shortName: 'ClockUp', logoUrl: null };
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [member, setMember] = useState<AuthState['member']>(null);
  const [org, setOrg] = useState<OrganizationDoc | null>(null);
  const [departments, setDepartments] = useState<Record<string, string>>({});
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  const [profileReady, setProfileReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Public branding for the sign-in screen.
  useEffect(() => {
    getDoc(doc(db, 'branding', ORG_ID))
      .then((s) => s.exists() && setBranding({ ...DEFAULT_BRANDING, ...(s.data() as Branding) }))
      .catch(() => undefined);
  }, []);

  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setUser(u);
        setAuthReady(true);
        setProfileReady(false);
        setMember(null);
        setOrg(null);
        setOrgId(null);
        setError(null);
      }),
    [],
  );

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const unsubs: (() => void)[] = [];
    (async () => {
      try {
        const link = await getDoc(doc(db, 'users', user.uid));
        const oid = link.get('orgId') as string | undefined;
        if (!oid) {
          if (!cancelled) {
            setError('Your account is not linked to an employee profile. Contact HR.');
            setProfileReady(true);
          }
          return;
        }
        if (cancelled) return;
        setOrgId(oid);
        unsubs.push(
          onSnapshot(
            doc(db, 'organizations', oid, 'members', user.uid),
            (s) => {
              const m = s.exists() ? ({ ...(s.data() as MemberDoc), uid: s.id } as AuthState['member']) : null;
              setMember(m);
              if (!m) setError('No employee profile found. Contact HR.');
              setProfileReady(true);
            },
            () => {
              setError('Unable to load your profile.');
              setProfileReady(true);
            },
          ),
        );
      } catch {
        if (!cancelled) {
          setError('Unable to load your account. Check your connection and reload.');
          setProfileReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [user]);

  // Organization and departments are readable only while the member is active.
  const active = member?.active === true;
  useEffect(() => {
    if (!orgId || !active) return;
    const u1 = onSnapshot(
      doc(db, 'organizations', orgId),
      (s) => {
        if (!s.exists()) return;
        const d = s.data();
        const o: OrganizationDoc = {
          id: s.id,
          name: d.name,
          shortName: d.shortName ?? d.name,
          logoUrl: d.logoUrl ?? null,
          settings: { ...DEFAULT_SETTINGS, ...(d.settings ?? {}), retention: { ...DEFAULT_SETTINGS.retention, ...(d.settings?.retention ?? {}) } },
        };
        setOrg(o);
        setBranding({ name: o.name, shortName: o.shortName, logoUrl: o.logoUrl });
      },
      () => setError('Unable to load organization settings.'),
    );
    const u2 = onSnapshot(collection(db, 'organizations', orgId, 'departments'), (s) =>
      setDepartments(Object.fromEntries(s.docs.map((d) => [d.id, d.get('name') as string]))),
    );
    return () => {
      u1();
      u2();
    };
  }, [orgId, active]);

  const value = useMemo<AuthState>(
    () => ({
      loading: !authReady || (!!user && !profileReady) || (!!user && active && !org && !error),
      user,
      orgId,
      member,
      org,
      departments,
      branding,
      error,
      logout: async () => {
        await signOut(auth);
      },
    }),
    [authReady, user, profileReady, active, org, error, orgId, member, departments, branding],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}

/** For pages rendered only after the session gate: org and member are guaranteed. */
export function useSession() {
  const a = useAuth();
  if (!a.member || !a.org || !a.orgId || !a.user) throw new Error('useSession requires an active session');
  return { ...a, member: a.member, org: a.org, orgId: a.orgId, user: a.user, tz: a.org.settings.timezone };
}
