'use client';

// The Employees tab: everyone on the team, with a search box. A table where
// the card is wide enough, the same people as tappable blocks under 640px.
// Mass Access viewers see the Mass Access accounts first (they open every
// page and are not changed here), when each person was last seen, and every
// role; a manager sees the roles they hold and "+N more" for the rest. The
// viewer's own row says "You" and has no Manage.
import { ChevronRight, Plus, Search, UserPlus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { EmployeeView, MassAccessView, RoleView, TeamState } from '../shared/api';
import { Button, EmptyState, Input, RelativeTime, Table, TBody, Td, Th, THead, Tr } from '../ui/ui-deps';
import { MassAccessTag, Person, RoleTags } from './parts';
import { matches } from './words';

type Row = { kind: 'mass-access'; person: MassAccessView } | { kind: 'employee'; person: EmployeeView };

/** True when the viewer may open Manage for this person. */
const manageable = (employee: EmployeeView) => !employee.you && (employee.canManage || employee.canRemove);

/** The people on the team, minus anyone also listed as Mass Access (their Mass Access row says it all). */
export function teamMembers(state: Pick<TeamState, 'employees' | 'massAccess'>): EmployeeView[] {
  const massAccess = new Set((state.massAccess ?? []).map((person) => person.id));
  return state.employees.filter((employee) => !massAccess.has(employee.id));
}

export function EmployeesTab({
  state,
  onAdd,
  onNewRole,
  onManage,
}: {
  state: TeamState;
  onAdd: () => void;
  onNewRole: () => void;
  onManage: (employee: EmployeeView) => void;
}) {
  const [query, setQuery] = useState('');
  const roles = useMemo(() => new Map(state.roles.map((role) => [role.id, role])), [state.roles]);
  const employees = teamMembers(state);

  if (employees.length === 0) {
    return state.roles.length > 0 ? (
      <EmptyState
        icon={Users}
        title="No employees yet"
        action={
          <Button variant="primary" size="sm" onClick={onAdd}>
            <UserPlus aria-hidden />
            Add employee
          </Button>
        }
      >
        Add someone by email and pick their role.
      </EmptyState>
    ) : (
      <EmptyState
        icon={Users}
        title="No employees yet"
        action={
          <Button variant="primary" size="sm" onClick={onNewRole}>
            <Plus aria-hidden />
            New role
          </Button>
        }
      >
        Start with a role: the pages one job needs, like Marketing. Then add the people who do that job.
      </EmptyState>
    );
  }

  const rows: Row[] = [
    ...(state.massAccess ?? []).map((person): Row => ({ kind: 'mass-access', person })),
    ...employees.map((person): Row => ({ kind: 'employee', person })),
  ];
  const shown = rows.filter((row) =>
    row.kind === 'mass-access'
      ? matches(query, row.person.name, row.person.email, 'Mass Access', 'Every page')
      : matches(query, row.person.name, row.person.email, ...row.person.roleIds.map((id) => roles.get(id)?.name)),
  );
  // Only Mass Access viewers are told when people were last seen.
  const lastSeen = state.viewer.massAccess || employees.some((employee) => employee.lastSeenAt !== undefined);

  return (
    <>
      <div className="border-b border-border px-4 py-3 sm:px-5">
        <label className="relative block w-full max-w-sm">
          <span className="sr-only">Search employees</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground/80" aria-hidden />
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, email or role" className="pl-9" />
        </label>
      </div>
      {shown.length === 0 ? (
        <EmptyState
          compact
          title={`No one matches “${query.trim()}”.`}
          action={
            <Button size="sm" onClick={() => setQuery('')}>
              Clear search
            </Button>
          }
        />
      ) : (
        <>
          <Table label="Employees" className="hidden @min-[640px]:block">
            <THead>
              <Th>Employee</Th>
              <Th>Roles</Th>
              {lastSeen ? <Th>Last seen</Th> : null}
              <Th align="right">
                <span className="sr-only">Manage</span>
              </Th>
            </THead>
            <TBody>
              {shown.map((row) => (
                <EmployeeRow key={`${row.kind}:${row.person.id}`} row={row} roles={roles} lastSeen={lastSeen} onManage={onManage} />
              ))}
            </TBody>
          </Table>
          <ul aria-label="Employees" className="divide-y divide-border @min-[640px]:hidden">
            {shown.map((row) => (
              <EmployeeBlock key={`${row.kind}:${row.person.id}`} row={row} roles={roles} lastSeen={lastSeen} onManage={onManage} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** "2 days ago", the date for older, or "No recent sign-in". */
function LastSeen({ iso }: { iso: string | null }) {
  return <RelativeTime iso={iso} fallback="No recent sign-in" />;
}

function EmployeeRow({ row, roles, lastSeen, onManage }: { row: Row; roles: ReadonlyMap<string, RoleView>; lastSeen: boolean; onManage: (employee: EmployeeView) => void }) {
  const { person } = row;
  return (
    <Tr>
      <Td className="py-2.5">
        <Person id={person.id} name={person.name} email={person.email} image={person.image} you={person.you} />
      </Td>
      <Td className="py-2.5">
        {row.kind === 'mass-access' ? <span className="text-[13px] text-foreground">Every page</span> : <RoleTags roleIds={row.person.roleIds} hidden={row.person.hiddenRoles} roles={roles} />}
      </Td>
      {lastSeen ? (
        <Td className="text-[13px] whitespace-nowrap text-muted-foreground">{person.lastSeenAt !== undefined ? <LastSeen iso={person.lastSeenAt} /> : null}</Td>
      ) : null}
      <Td align="right" className="whitespace-nowrap">
        {row.kind === 'mass-access' ? (
          <MassAccessTag />
        ) : manageable(row.person) ? (
          <Button size="sm" aria-label={`Manage ${row.person.name}`} onClick={() => onManage(row.person)}>
            Manage
            <ChevronRight aria-hidden />
          </Button>
        ) : null}
      </Td>
    </Tr>
  );
}

/** The same person as a block, for under 640px: tap it to manage them. */
function EmployeeBlock({ row, roles, lastSeen, onManage }: { row: Row; roles: ReadonlyMap<string, RoleView>; lastSeen: boolean; onManage: (employee: EmployeeView) => void }) {
  const { person } = row;
  const content = (
    <div className="min-w-0 flex-1">
      <Person id={person.id} name={person.name} email={person.email} image={person.image} you={person.you} />
      <div className="mt-2 flex flex-col gap-1.5 pl-11">
        {row.kind === 'mass-access' ? (
          <span className="flex flex-wrap items-center gap-2 text-[13px] text-foreground">
            Every page
            <MassAccessTag />
          </span>
        ) : (
          <RoleTags roleIds={row.person.roleIds} hidden={row.person.hiddenRoles} roles={roles} />
        )}
        {lastSeen && person.lastSeenAt !== undefined ? (
          <p className="text-xs text-muted-foreground">
            {person.lastSeenAt ? (
              <>
                Last seen <LastSeen iso={person.lastSeenAt} />
              </>
            ) : (
              'No recent sign-in'
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
  if (row.kind === 'employee' && manageable(row.person)) {
    const employee = row.person;
    return (
      <li>
        <button
          type="button"
          onClick={() => onManage(employee)}
          className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left text-sm outline-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          {content}
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </li>
    );
  }
  return <li className="flex items-center gap-2 px-4 py-3 text-sm">{content}</li>;
}
