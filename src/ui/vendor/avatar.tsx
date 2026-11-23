'use client';

// Vendored from betterfanslink components/ui/avatar.tsx (main cf653df): Avatar, with its initials helper inlined.
import { Avatar as BaseAvatar } from '@base-ui/react/avatar';
import { cn } from './cn';

// Hue picks for initials tiles. All pass 4.5:1 with white text.
const HUES = ['#6a52e6', '#2f6fd6', '#0f7c6c', '#b3421f', '#a3367c', '#5a5f73', '#7a4bd1', '#1f7a3a'];

function hueFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

/** Up to two letters from a name or an email ("Jordan Lee" → "JL", "sam@x.com" → "S"). */
export function initials(name: string): string {
  const base = name.includes('@') ? name.split('@')[0]! : name;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]![0]}${words[words.length - 1]![0]}` : (words[0]?.[0] ?? '');
  return letters.toUpperCase();
}

const sizes = {
  sm: 'size-6 text-[10px]',
  md: 'size-8 text-xs',
  lg: 'size-10 text-sm',
} as const;

/** A person's picture with an initials fallback. `seed` keeps the color stable when names change. */
export function Avatar({
  src,
  name,
  seed,
  size = 'md',
  className,
}: {
  src?: string | null;
  name: string;
  seed?: string;
  size?: keyof typeof sizes;
  className?: string;
}) {
  return (
    <BaseAvatar.Root
      className={cn('relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white select-none', sizes[size], className)}
      style={{ backgroundColor: hueFor(seed ?? name) }}
    >
      {src ? <BaseAvatar.Image src={src} alt="" className="size-full object-cover" /> : null}
      <BaseAvatar.Fallback delay={src ? 400 : 0} aria-hidden>
        {initials(name) || '?'}
      </BaseAvatar.Fallback>
    </BaseAvatar.Root>
  );
}
