'use client';

// The Roles tab: each role the viewer can see (Mass Access: all; a manager:
// the ones they hold), what it opens and how many people have it. Mass
// Access also gets one quiet line naming the pages no role opens yet. A
// table where the card is wide enough, tappable blocks under 640px.
import { ChevronRight, KeyRound, Pencil, Plus } from 'lucide-react';
import type { RoleView, TeamState } from '../shared/api';
import { Button, EmptyState, Table, TBody, Td, Th, THead, Tr } from '../ui/ui-deps';
import { KeyTile } from './parts';
import { peopleWord, roleOpens } from './words';

export function RolesTab({ state, onNew, onEdit }: { state: TeamState; onNew: () => void; onEdit: (role: RoleView) => void }) {
  if (state.roles.length === 0) {
    return (
      <EmptyState
        icon={KeyRound}
        title="No roles yet"
        action={
          <Button variant="primary" size="sm" onClick={onNew}>
            <Plus aria-hidden />
            New role
          </Button>
        }
      >
        A role is the set of pages one job needs. Make one for each job, like Marketing or Support.
      </EmptyState>
    );
  }
  const unassigned = state.unassigned ?? [];
  return (
    <>
      {unassigned.length > 0 ? (
        <p className="border-b border-border px-4 py-2.5 text-[13px] leading-relaxed text-muted-foreground sm:px-5">Not in any role yet: {unassigned.join(', ')}.</p>
      ) : null}
      <Table label="Roles" className="hidden @min-[640px]:block">
        <THead>
          <Th>Role</Th>
          <Th>Opens</Th>
          <Th>People</Th>
          <Th align="right">
            <span className="sr-only">Edit</span>
          </Th>
        </THead>
        <TBody>
          {state.roles.map((role) => {
            const opens = roleOpens(role, state.labels);
            return (
              <Tr key={role.id}>
                <Td className="py-2.5">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <KeyTile />
                    <span className="min-w-0 font-medium [overflow-wrap:anywhere] text-foreground">{role.name}</span>
                  </span>
                </Td>
                <Td className="py-2.5 text-[13px] leading-relaxed text-muted-foreground">{opens || 'No pages'}</Td>
                <Td className="text-[13px] whitespace-nowrap text-foreground">{peopleWord(role.people)}</Td>
                <Td align="right">
                  <Button size="sm" aria-label={`Edit ${role.name}`} onClick={() => onEdit(role)}>
                    <Pencil aria-hidden />
                    Edit
                  </Button>
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
      <ul aria-label="Roles" className="divide-y divide-border @min-[640px]:hidden">
        {state.roles.map((role) => {
          const opens = roleOpens(role, state.labels);
          return (
            <li key={role.id}>
              <button
                type="button"
                onClick={() => onEdit(role)}
                className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left text-sm outline-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              >
                <KeyTile />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium [overflow-wrap:anywhere] text-foreground">{role.name}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{opens ? `Opens ${opens}` : 'No pages'}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{peopleWord(role.people)}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
