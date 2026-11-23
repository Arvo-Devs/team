'use client';

// Add employee: an email, a full name when the
// app can make a login for someone new, and the roles to give. The server
// decides what happens: an account that is already there joins at once, the
// app makes a login for someone new and emails them, or it says why not, in
// a line under the form (the dialog stays open). Once it worked, the dialog
// says who got in and what they open, with Undo for the wrong person: Undo
// takes them off the team again and goes back to the form as it was.
import { Check, Copy } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import type { AddResult, TeamState } from '../shared/api';
import { Button, COPY_FAILED, Dialog, DialogContent, errorWords, Field, InlineError, Input, Spinner, useCopy, type TeamError } from '../ui/ui-deps';
import { useAddEmployee, useRemoveEmployee } from './api';
import { DialogSection, NoRoles, RolePicker } from './parts';
import { joinedLine, looksLikeEmail, madeLine, opensSentence, opensWith } from './words';

const EMAIL_LINE = 'Type a full email address, like jordan@company.com.';
const NAME_LINE = 'Type their full name, at least 2 letters.';

/** Which field a refusal belongs under; null puts it under the form. */
function fieldOf(error: TeamError | null): 'email' | 'name' | null {
  if (!error) return null;
  if (error.code === 'invalid_email' || error.param === 'email') return 'email';
  if (error.code === 'name_required' || error.param === 'name') return 'name';
  return null;
}

export function AddEmployeeDialog({
  open,
  onOpenChange,
  state,
  onNewRole,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: TeamState;
  /** "New role", for when there is none to give yet. */
  onNewRole: () => void;
}) {
  const formId = useId();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState<AddResult | null>(null);
  const add = useAddEmployee();
  const undo = useRemoveEmployee();
  const { copied, failed, copy } = useCopy();
  // isPending flips a render late, so without this a fast second click adds twice.
  const sending = useRef(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const askName = state.canMakeAccounts;
  const field = fieldOf(add.error);
  const emailError = tried && !looksLikeEmail(email) ? EMAIL_LINE : field === 'email' ? errorWords(add.error) : undefined;
  const nameError = askName && tried && name.trim().length === 1 ? NAME_LINE : field === 'name' ? errorWords(add.error) : undefined;
  const chosen = state.roles.filter((role) => roleIds.includes(role.id)).map((role) => role.id);
  const live = opensSentence("They'll open", opensWith(state, chosen), chosen.length, state.everyEmployee);

  // A refusal is about what was typed: it goes away as soon as something changes.
  const changed = () => {
    if (add.error) add.reset();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (!looksLikeEmail(email)) {
      emailRef.current?.focus();
      return;
    }
    if (askName && name.trim().length === 1) {
      nameRef.current?.focus();
      return;
    }
    if (sending.current) return;
    sending.current = true;
    try {
      const fullName = name.trim();
      setDone(await add.mutateAsync({ email: email.trim(), roleIds: chosen, ...(askName && fullName ? { name: fullName } : {}) }));
    } catch {
      // add.error holds it, and the form shows it.
    } finally {
      sending.current = false;
    }
  };

  const undoAdd = async () => {
    if (!done || sending.current) return;
    sending.current = true;
    try {
      await undo.mutateAsync({ id: done.employee.id, token: done.employee.token });
      // Back to the form as it was, to fix the email or cancel.
      add.reset();
      undo.reset();
      setDone(null);
    } catch {
      // undo.error shows in the done view.
    } finally {
      sending.current = false;
    }
  };

  if (done) {
    const who = done.employee.email ?? email.trim();
    const joined = done.outcome === 'joined';
    return (
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <DialogContent
          title={joined ? `${done.employee.name} is in` : done.emailed === false ? `We couldn't email ${who}` : `We emailed ${who}`}
          description={joined ? joinedLine(who, done.opens) : madeLine(done.opens, done.emailed)}
          footer={
            <Dialog.Close render={<Button variant="primary" autoFocus />} disabled={undo.isPending}>
              Done
            </Dialog.Close>
          }
        >
          <div className="flex flex-col gap-3">
            <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              Not who you meant?
              <button
                type="button"
                onClick={() => void undoAdd()}
                disabled={undo.isPending}
                className="inline-flex cursor-pointer items-center gap-1 rounded font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60"
              >
                {undo.isPending ? <Spinner className="size-3" /> : null}
                {undo.isPending ? 'Removing…' : 'Undo'}
              </button>
            </p>
            {undo.error ? <InlineError error={undo.error} /> : null}
          </div>
        </DialogContent>
      </Dialog.Root>
    );
  }

  const bottomError = add.error && !field ? add.error : null;
  const signUp = bottomError?.code === 'no_account' && state.signUpUrl ? state.signUpUrl : null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Add employee"
        footer={
          <>
            <Dialog.Close render={<Button variant="ghost" />}>Cancel</Dialog.Close>
            <Button variant="primary" type="submit" form={formId} disabled={add.isPending}>
              {add.isPending ? <Spinner /> : null}
              {add.isPending ? 'Adding…' : 'Add employee'}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-5">
          <Field label="Email" error={emailError}>
            <Input
              ref={emailRef}
              type="email"
              inputMode="email"
              autoComplete="off"
              autoFocus
              value={email}
              placeholder="jordan@company.com"
              onChange={(event) => {
                changed();
                setEmail(event.target.value);
              }}
            />
          </Field>
          {askName ? (
            <Field label="Full name" hint="Used for their new account if they don't have one yet." error={nameError}>
              <Input
                ref={nameRef}
                autoComplete="off"
                value={name}
                placeholder="Jordan Lee"
                onChange={(event) => {
                  changed();
                  setName(event.target.value);
                }}
              />
            </Field>
          ) : null}
          <DialogSection title="Roles">
            {state.roles.length > 0 ? (
              <RolePicker
                roles={state.roles}
                labels={state.labels}
                selected={roleIds}
                onChange={(next) => {
                  changed();
                  setRoleIds(next);
                }}
              />
            ) : (
              <NoRoles onNewRole={onNewRole} />
            )}
            <p aria-live="polite" className="text-[13px] leading-relaxed text-muted-foreground">
              {live}
            </p>
          </DialogSection>
          {bottomError ? (
            <InlineError
              error={bottomError}
              action={
                signUp ? (
                  <Button size="sm" onClick={(event) => void copy(signUp, event.currentTarget)}>
                    {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                    {copied ? 'Copied' : 'Copy sign-up link'}
                  </Button>
                ) : null
              }
            />
          ) : null}
          {signUp && failed ? (
            <p role="alert" className="-mt-3 text-xs leading-relaxed text-danger-strong">
              {COPY_FAILED}
            </p>
          ) : null}
        </form>
      </DialogContent>
    </Dialog.Root>
  );
}
