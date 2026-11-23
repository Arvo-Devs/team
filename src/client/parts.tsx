'use client';

// The small pieces the Team page's tabs and dialogs share: a person as an
// initials avatar with the
// name and email, roles as outline tags, a key tile by each role, the lock
// tag on Mass Access, and the role rows with what each one opens. Long
// names wrap instead of pushing the page sideways.
import { KeyRound, LockKeyhole, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RoleView } from '../shared/api';
import { Avatar, Button, Checkbox, cn, Skeleton, Tip } from '../ui/ui-deps';
import { roleOpens } from './words';

/** A row in a checklist (a role, a page, an action): a hover tint, and a stronger one while it is ticked. */
export const ROW = 'min-h-10 rounded-lg border border-transparent p-2 hover:bg-accent';
export const ROW_TICKED = 'border-primary/25 bg-primary/5 hover:bg-primary/10';

/** One of someone's roles: an outline tag. */
export function RoleTag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-md border border-input px-2 py-0.5 text-xs leading-4 font-medium [overflow-wrap:anywhere] text-foreground">
      {children}
    </span>
  );
}

/** The key tile by a role's name. */
export function KeyTile() {
  return (
    <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-[7px] border border-primary/25 bg-primary/10 text-primary">
      <KeyRound className="size-3.5" />
    </span>
  );
}

/** In place of Manage on a Mass Access row. Focusable, so the line under it shows from the keyboard too. */
export function MassAccessTag() {
  return (
    <Tip content="Opens every page. Not changed here.">
      <span
        tabIndex={0}
        className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring"
      >
        <LockKeyhole className="size-3" aria-hidden />
        Mass Access
      </span>
    </Tip>
  );
}

/** On the viewer's own row. */
export function YouTag() {
  return <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap text-muted-foreground">You</span>;
}

/** Who a row is about: initials avatar, name (and "You"), email under it. */
export function Person({ id, name, email, image, you }: { id: string; name: string; email: string | null; image: string | null; you: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar src={image} name={name} seed={id} />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="min-w-0 font-medium [overflow-wrap:anywhere] text-foreground">{name}</span>
          {you ? <YouTag /> : null}
        </p>
        {email && email !== name ? <p className="text-xs [overflow-wrap:anywhere] text-muted-foreground">{email}</p> : null}
      </div>
    </div>
  );
}

/** Someone's roles as tags, then "+2 more" for the ones the viewer can't see, or "No roles". */
export function RoleTags({ roleIds, hidden, roles }: { roleIds: readonly string[]; hidden: number; roles: ReadonlyMap<string, RoleView> }) {
  const shown = roleIds.flatMap((id) => {
    const role = roles.get(id);
    return role ? [role] : [];
  });
  // A role id this viewer has no name for counts with the hidden ones.
  const more = hidden + (roleIds.length - shown.length);
  if (shown.length === 0 && more === 0) return <span className="text-[13px] text-muted-foreground">No roles</span>;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {shown.map((role) => (
        <RoleTag key={role.id}>{role.name}</RoleTag>
      ))}
      {more > 0 ? <span className="px-0.5 text-xs font-medium whitespace-nowrap text-muted-foreground">+{more} more</span> : null}
    </span>
  );
}

/** The roles to tick in Add employee and Manage: each with what it opens under its name. */
export function RolePicker({
  roles,
  labels,
  selected,
  onChange,
  disabled,
}: {
  roles: readonly RoleView[];
  labels: Readonly<Record<string, string>>;
  selected: readonly string[];
  onChange: (roleIds: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label="Roles" className="grid gap-0.5 rounded-xl border border-border bg-background/50 p-1.5">
      {roles.map((role) => {
        const ticked = selected.includes(role.id);
        const opens = roleOpens(role, labels);
        return (
          <Checkbox
            key={role.id}
            checked={ticked}
            disabled={disabled}
            onCheckedChange={(next) => onChange(next ? [...selected.filter((id) => id !== role.id), role.id] : selected.filter((id) => id !== role.id))}
            description={opens ? `Opens ${opens}` : undefined}
            className={cn(ROW, ticked && ROW_TICKED)}
          >
            <span className="font-medium [overflow-wrap:anywhere]">{role.name}</span>
          </Checkbox>
        );
      })}
    </div>
  );
}

/** Where a role would be picked but none exists yet. */
export function NoRoles({ onNewRole }: { onNewRole?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-input px-3 py-3">
      <p className="min-w-0 flex-1 basis-52 text-[13px] leading-relaxed text-muted-foreground">No roles yet. Make one first, so they can open something.</p>
      {onNewRole ? (
        <Button size="sm" onClick={onNewRole}>
          <Plus aria-hidden />
          New role
        </Button>
      ) : null}
    </div>
  );
}

/** A section heading inside a dialog, with an optional count at the right. */
export function DialogSection({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
        {aside ? <span className="text-xs text-muted-foreground tabular-nums">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** A bar of text still on its way, inside a heading or a line (a span, so it is allowed there). */
export function TextSkeleton({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('inline-block max-w-full animate-pulse rounded-md bg-muted align-middle', className)}>
      &nbsp;
    </span>
  );
}

/** What a list shows while it loads: four rows. */
export function SkeletonRows() {
  return (
    <div aria-busy="true" className="divide-y divide-border">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} data-skeleton-row="" className="flex items-center gap-3 px-4 py-3 sm:px-5">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40 max-w-full" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
