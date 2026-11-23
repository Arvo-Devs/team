'use client';

// Manage (one employee): which of the viewer's roles they have, what that
// opens, and Remove employee. A manager sees only the roles they hold; the
// person's other roles stay as they are, and the dialog says how many. The
// save sends the token the dialog opened with, so a change someone else
// made in the meantime is never overwritten: the dialog says so and offers
// Start over, which reads the team again and opens them afresh.
import { UserMinus } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import type { EmployeeView, TeamState } from '../shared/api';
import { Button, ConfirmDialog, Dialog, DialogContent, formatDate, InlineError, Spinner, type TeamError } from '../ui/ui-deps';
import { useManageEmployee, useRemoveEmployee } from './api';
import { DialogSection, NoRoles, RolePicker } from './parts';
import { addedLine, hiddenRolesLine, opensSentence, opensWith } from './words';

const REMOVE_LINE = 'They lose every page their roles open, from their next click. Their account stays, and you can add them again later.';

export function ManageEmployeeDialog({
  open,
  onOpenChange,
  employee,
  gone,
  state,
  onStartOver,
  onNewRole,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The person as they were when the dialog opened (their token with them). */
  employee: EmployeeView;
  /** Start over found them gone. */
  gone: boolean;
  state: TeamState;
  /** Read the team again and open this person afresh. */
  onStartOver: () => void;
  onNewRole: () => void;
}) {
  const formId = useId();
  const [roleIds, setRoleIds] = useState<string[]>(() => [...employee.roleIds]);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const save = useManageEmployee();
  const remove = useRemoveEmployee();
  // isPending flips a render late, so without this a fast second click sends twice.
  const sending = useRef(false);
  const name = employee.name;

  const chosen = state.roles.filter((role) => roleIds.includes(role.id)).map((role) => role.id);
  const hidden = employee.hiddenRoles;
  const opens = opensWith(state, chosen);
  // With roles this viewer can't see, the pages those open are not in the list: say nothing rather than something untrue.
  const live = hidden > 0 && opens.length === 0 ? null : opensSentence('Can open', opens, chosen.length + hidden, state.everyEmployee);

  /** Someone else removed them: the deck's line with their name (the route doesn't know it). */
  const goneLine = `Someone else removed ${name}.`;
  const wordsFor = (error: TeamError | null) => (error?.code === 'employee_gone' ? goneLine : undefined);
  const actionFor = (error: TeamError | null) =>
    error?.code === 'stale' ? (
      <Button size="sm" onClick={onStartOver}>
        Start over
      </Button>
    ) : error?.code === 'employee_gone' ? (
      <Button size="sm" onClick={() => onOpenChange(false)}>
        Close
      </Button>
    ) : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const before = new Set(employee.roleIds);
    // Nothing changed: nothing to send.
    if (chosen.length === before.size && chosen.every((id) => before.has(id))) {
      onOpenChange(false);
      return;
    }
    if (sending.current) return;
    sending.current = true;
    try {
      await save.mutateAsync({ id: employee.id, roleIds: chosen, token: employee.token });
      onOpenChange(false);
    } catch {
      // save.error shows under the form.
    } finally {
      sending.current = false;
    }
  };

  const removeEmployee = async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      await remove.mutateAsync({ id: employee.id, token: employee.token });
      setConfirmRemove(false);
      onOpenChange(false);
    } catch {
      // remove.error shows in the confirm.
    } finally {
      sending.current = false;
    }
  };

  if (gone) {
    return (
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <DialogContent title={name} footer={<Dialog.Close render={<Button variant="primary" />}>Close</Dialog.Close>}>
          <p className="text-sm text-foreground">{goneLine}</p>
        </DialogContent>
      </Dialog.Root>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={name}
        description={addedLine(employee.email, formatDate(employee.addedAt), employee.addedBy)}
        footerStart={
          employee.canRemove ? (
            <Button
              variant="danger"
              disabled={save.isPending}
              onClick={() => {
                remove.reset();
                setConfirmRemove(true);
              }}
            >
              <UserMinus aria-hidden />
              Remove employee
            </Button>
          ) : null
        }
        footer={
          <>
            <Dialog.Close render={<Button variant="ghost" />}>Cancel</Dialog.Close>
            {employee.canManage ? (
              <Button variant="primary" type="submit" form={formId} disabled={save.isPending}>
                {save.isPending ? <Spinner /> : null}
                {save.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            ) : null}
          </>
        }
      >
        <form id={formId} onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
          <DialogSection title="Roles">
            {state.roles.length > 0 ? (
              <RolePicker
                roles={state.roles}
                labels={state.labels}
                selected={roleIds}
                disabled={!employee.canManage}
                onChange={(next) => {
                  if (save.error) save.reset();
                  setRoleIds(next);
                }}
              />
            ) : (
              <NoRoles onNewRole={onNewRole} />
            )}
            {live ? (
              <p aria-live="polite" className="text-[13px] leading-relaxed text-muted-foreground">
                {live}
              </p>
            ) : null}
            {hidden > 0 ? <p className="text-[13px] leading-relaxed text-muted-foreground">{hiddenRolesLine(name, hidden)}</p> : null}
          </DialogSection>
          {!employee.canRemove ? <p className="text-xs leading-relaxed text-muted-foreground">Only someone who manages all of {name}'s roles can remove them.</p> : null}
          {save.error ? <InlineError error={save.error} words={wordsFor(save.error)} action={actionFor(save.error)} /> : null}
        </form>
        <ConfirmDialog
          open={confirmRemove}
          onOpenChange={setConfirmRemove}
          title={`Remove ${name}?`}
          consequence={REMOVE_LINE}
          confirmLabel="Remove"
          pendingLabel="Removing…"
          pending={remove.isPending}
          danger
          onConfirm={() => void removeEmployee()}
        >
          {remove.error ? <InlineError error={remove.error} words={wordsFor(remove.error)} action={actionFor(remove.error)} /> : null}
        </ConfirmDialog>
      </DialogContent>
    </Dialog.Root>
  );
}
