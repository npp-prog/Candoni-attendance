import { useAuth } from '../context/AuthContext';
import { cx } from './ui';

/** Organization logo (configurable) with a built-in fallback mark. */
export function BrandMark({ size = 40, className }: { size?: number; className?: string }) {
  const { branding } = useAuth();
  if (branding.logoUrl) {
    return <img src={branding.logoUrl} alt={`${branding.name} logo`} width={size} height={size} className={cx('rounded-xl object-contain', className)} style={{ width: size, height: size }} />;
  }
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} role="img" aria-label={`${branding.name} logo`}>
      <rect width="64" height="64" rx="14" fill="#0b1f3a" />
      <circle cx="32" cy="32" r="18" fill="none" stroke="#14a39a" strokeWidth="5" />
      <path d="M32 21v11l8 5" fill="none" stroke="#ffffff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function BrandHeader({ compact }: { compact?: boolean }) {
  const { branding } = useAuth();
  return (
    <div className="flex items-center gap-3">
      <BrandMark size={compact ? 32 : 44} />
      <div className="min-w-0 leading-tight">
        <p className={cx('truncate font-bold text-navy-900', compact ? 'text-base' : 'text-lg')}>{compact ? branding.shortName : branding.name}</p>
        {!compact && <p className="text-xs text-slate-600">Attendance</p>}
      </div>
    </div>
  );
}
