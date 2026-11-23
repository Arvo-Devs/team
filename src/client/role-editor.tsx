'use client';

// The role editor ("New role" / "Edit role"): a role's name and the pages
// it opens, as a grouped checklist: the app's nav sections, two columns when the
// list is at least 560px wide, ticked rows tinted, a lock on the pages every
// employee gets. A page's actions show under it, indented, once it is
// ticked, and unticking the page drops them. The list is what this viewer
// may give (the server's catalog); the server keeps whatever else the role
// stores, so the editor only ever sends what it shows (design §6, rule 4).
import { LockKeyhole, Trash2 } from 'lucide-react';
import { useId, useMemo, useRef, useState, type FormEvent, type Ref } from 'react';
import { newRoleId, type CatalogPage, type CatalogSection, type RoleView, type TeamState } from '../shared/api';
import { Button, Checkbox, cn, ConfirmDialog, Dialog, DialogContent, errorWords, Field, InlineError, Input, Spinner, type TeamError } from '../ui/ui-deps';
import { useCreateRole, useDeleteRole, useEditRole } from './api';
import { DialogSection, ROW, ROW_TICKED } from './parts';
import { deleteRoleLine } from './words';

/** The Team page's own row says what managing the team means, in place of its nav line. */
export const TEAM_PAGE_LINE = 'Add and remove employees and change roles. They can only give pages they can open themselves.';

/** A locked row's line: the page every employee opens without a role. */
export const EVERY_EMPLOYEE_LINE = 'Included for every employee';

/** What the editor needs to know about the catalog, read once. */
type CatalogFacts = {
  /** The grants this viewer may tick, in nav order. */
  grants: string[];
  /** Each action this viewer may give, with its page's grant (null for an every-employee page, which is always open). */
  actionPage: Map<string, string | null>;
  /** Each action key's place in the nav. */
  actionOrder: Map<string, number>;
  /** The Team page, when this viewer may give it. */
  team: { grant: string; label: string } | null;
};

function factsOf(catalog: readonly CatalogSection[]): CatalogFacts {
  const facts: CatalogFacts = { grants: [], actionPage: new Map(), actionOrder: new Map(), team: null };
  for (const section of catalog) {
    for (const page of section.pages) {
      if (!page.locked && page.grant) {
        facts.grants.push(page.grant);
        if (page.teamPage) facts.team = { grant: page.grant, label: page.label };
      }
      for (const action of page.actions) {
        facts.actionPage.set(action.key, page.locked ? null : page.grant);
        facts.actionOrder.set(action.key, facts.actionOrder.size);
      }
    }
  }
  return facts;
}

/** An action counts only with its page: ticked, or open to every employee anyway. */
function keeps(facts: CatalogFacts, pages: readonly string[], key: string): boolean {
  const page = facts.actionPage.get(key);
  return page === null || (page !== undefined && pages.includes(page));
}

/** Which field a refusal belongs under: the name, the pages, or neither (it goes at the bottom). */
function fieldOf(error: TeamError | null): 'name' | 'pages' | null {
  if (!error) return null;
  if (error.code === 'name_taken' || error.param === 'name') return 'name';
  if (error.code === 'no_pages' || error.param === 'pages') return 'pages';
  return null;
}

export function RoleEditorDialog({
  open,
  onOpenChange,
  role,
  gone,
  state,
  onStartOver,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The role as it was when the editor opened, or null for a new one. */
  role: RoleView | null;
  /** Start over found the role deleted. */
  gone: boolean;
  state: TeamState;
  /** Read the team again and open this role afresh (after "Someone else changed this…"). */
  onStartOver: () => void;
}) {
  const formId = useId();
  const facts = useMemo(() => factsOf(state.catalog), [state.catalog]);
  // Made once per editor, so a double click or a retry makes one role.
  const [id] = useState(() => role?.id ?? newRoleId());
  const [name, setName] = useState(role?.name ?? '');
  const [pages, setPages] = useState<string[]>(() => (role ? facts.grants.filter((grant) => role.pages.includes(grant)) : []));
  const [actions, setActions] = useState<string[]>(() => (role ? role.actions.filter((key) => keeps(facts, role.pages, key)) : []));
  const [tried, setTried] = useState(false);
  const [confirm, setConfirm] = useState<'delete' | 'team' | null>(null);
  const create = useCreateRole();
  const edit = useEditRole();
  const remove = useDeleteRole();
  // isPending flips a render late, so without this a fast second click sends twice.
  const sending = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const saveError = (role ? edit.error : create.error) ?? null;
  const field = fieldOf(saveError);
  // Nothing ticked at all, the server's own rule: an action on a page every employee opens counts too.
  const empty = pages.length === 0 && !actions.some((key) => keeps(facts, pages, key));
  const nameError = tried && !name.trim() ? 'Give the role a name.' : field === 'name' ? errorWords(saveError) : undefined;
  const pagesError = tried && empty ? 'Tick at least one page.' : field === 'pages' ? errorWords(saveError) : undefined;
  const pending = create.isPending || edit.isPending;

  // A manager taking the Team page off a role they hold, with no other role of theirs that opens it, is about to lock themselves out.
  const team = facts.team;
  const takesTeamOff =
    !!role &&
    !!team &&
    !state.viewer.massAccess &&
    role.mine &&
    role.pages.includes(team.grant) &&
    !pages.includes(team.grant) &&
    !state.roles.some((other) => other.mine && other.id !== role.id && other.pages.includes(team.grant));

  const changed = () => {
    if (create.error) create.reset();
    if (edit.error) edit.reset();
  };
  const onPage = (grant: string, ticked: boolean) => {
    changed();
    setPages((now) => (ticked ? [...now.filter((g) => g !== grant), grant] : now.filter((g) => g !== grant)));
    if (!ticked) setActions((now) => now.filter((key) => facts.actionPage.get(key) !== grant));
  };
  const onAction = (key: string, ticked: boolean) => {
    changed();
    setActions((now) => (ticked ? [...now.filter((k) => k !== key), key] : now.filter((k) => k !== key)));
  };

  const send = async () => {
    if (sending.current) return;
    sending.current = true;
    const body = {
      name: name.trim(),
      pages: facts.grants.filter((grant) => pages.includes(grant)),
      actions: actions.filter((key) => keeps(facts, pages, key)).sort((a, b) => (facts.actionOrder.get(a) ?? 0) - (facts.actionOrder.get(b) ?? 0)),
    };
    try {
      if (role) await edit.mutateAsync({ id: role.id, version: role.version, ...body });
      else await create.mutateAsync({ id, ...body });
      setConfirm(null);
      onOpenChange(false);
    } catch {
      // The error shows in the editor, under its field or at the bottom.
      setConfirm(null);
    } finally {
      sending.current = false;
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (!name.trim()) {
      nameRef.current?.focus();
      return;
    }
    if (empty) {
      listRef.current?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (takesTeamOff) {
      setConfirm('team');
      return;
    }
    void send();
  };

  const deleteRole = async () => {
    if (!role || sending.current) return;
    sending.current = true;
    try {
      await remove.mutateAsync({ id: role.id, version: role.version });
      setConfirm(null);
      onOpenChange(false);
    } catch {
      // remove.error shows in the confirm.
    } finally {
      sending.current = false;
    }
  };

  /** The button the deck gives a refusal: Start over for a stale role, Close for a deleted one. */
  const errorAction = (error: TeamError | null) =>
    error?.code === 'stale' ? (
      <Button size="sm" onClick={onStartOver}>
        Start over
      </Button>
    ) : error?.code === 'role_gone' ? (
      <Button size="sm" onClick={() => onOpenChange(false)}>
        Close
      </Button>
    ) : null;

  if (gone) {
    return (
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <DialogContent title="Edit role" footer={<Dialog.Close render={<Button variant="primary" />}>Close</Dialog.Close>}>
          <p className="text-sm text-foreground">Someone else deleted this role.</p>
        </DialogContent>
      </Dialog.Root>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title={role ? 'Edit role' : 'New role'}
        footerStart={
          role ? (
            <Button
              variant="danger"
              disabled={pending}
              onClick={() => {
                remove.reset();
                setConfirm('delete');
              }}
            >
              <Trash2 aria-hidden />
              Delete role
            </Button>
          ) : null
        }
        footer={
          <>
            <Dialog.Close render={<Button variant="ghost" />}>Cancel</Dialog.Close>
            <Button variant="primary" type="submit" form={formId} disabled={pending}>
              {pending ? <Spinner /> : null}
              {pending ? 'Saving…' : role ? 'Save changes' : 'Create role'}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-5">
          <RoleEditorFields
            state={state}
            isNew={!role}
            name={name}
            onName={(next) => {
              changed();
              setName(next);
            }}
            nameError={nameError}
            nameRef={nameRef}
            pages={pages}
            actions={actions}
            onPage={onPage}
            onAction={onAction}
            pagesError={pagesError}
            listRef={listRef}
          />
          {saveError && !field ? <InlineError error={saveError} action={errorAction(saveError)} /> : null}
        </form>
        {role ? (
          <ConfirmDialog
            open={confirm === 'delete'}
            onOpenChange={(next) => setConfirm(next ? 'delete' : null)}
            title={`Delete ${role.name}?`}
            consequence={deleteRoleLine(role.people)}
            confirmLabel="Delete role"
            pendingLabel="Deleting…"
            pending={remove.isPending}
            danger
            onConfirm={() => void deleteRole()}
          >
            {remove.error ? <InlineError error={remove.error} action={errorAction(remove.error)} /> : null}
          </ConfirmDialog>
        ) : null}
        {role && team ? (
          <ConfirmDialog
            open={confirm === 'team'}
            onOpenChange={(next) => setConfirm(next ? 'team' : null)}
            title={`Take ${team.label} off a role you're in?`}
            consequence="You'll lose this page too, and won't be able to come back to it."
            confirmLabel="Take it off"
            pendingLabel="Saving…"
            pending={pending}
            danger
            onConfirm={() => void send()}
          />
        ) : null}
      </DialogContent>
    </Dialog.Root>
  );
}

/** The editor's fields: the name, then the pages. Drawn by the dialog, and alone in tests. */
export function RoleEditorFields({
  state,
  isNew,
  name,
  onName,
  nameError,
  nameRef,
  pages,
  actions,
  onPage,
  onAction,
  pagesError,
  listRef,
}: {
  state: Pick<TeamState, 'catalog' | 'viewer'>;
  isNew: boolean;
  name: string;
  onName: (name: string) => void;
  nameError?: string;
  nameRef?: Ref<HTMLInputElement>;
  pages: readonly string[];
  actions: readonly string[];
  onPage: (grant: string, ticked: boolean) => void;
  onAction: (key: string, ticked: boolean) => void;
  pagesError?: string;
  listRef?: Ref<HTMLDivElement>;
}) {
  const tickable = state.catalog.flatMap((section) => section.pages.flatMap((page) => (!page.locked && page.grant ? [page.grant] : [])));
  const ticked = tickable.filter((grant) => pages.includes(grant)).length;
  return (
    <>
      <Field label="Name" hint="Name it after the job." error={nameError}>
        <Input ref={nameRef} value={name} onChange={(event) => onName(event.target.value)} placeholder="e.g. Marketing" autoComplete="off" autoFocus={isNew} />
      </Field>
      <DialogSection title="Pages" aside={`${ticked} of ${tickable.length}`}>
        <p className="-mt-1.5 text-xs leading-relaxed text-muted-foreground">People in this role can open the pages you tick.</p>
        {pagesError ? (
          <p role="alert" className="text-xs leading-relaxed text-danger-strong">
            {pagesError}
          </p>
        ) : null}
        <PagesChecklist catalog={state.catalog} pages={pages} actions={actions} onPage={onPage} onAction={onAction} listRef={listRef} />
      </DialogSection>
      {isNew && !state.viewer.massAccess ? <p className="text-[13px] leading-relaxed text-muted-foreground">You'll be in this role too, so you can manage it.</p> : null}
    </>
  );
}

/**
 * The pages as a grouped checklist: one group per nav section (a section
 * with no label has no heading), flowing down one column and then a second
 * once the list is 560px wide. The line between the columns is a see-through
 * gray, so it needs no color name of its own and reads on light and dark.
 */
export function PagesChecklist({
  catalog,
  pages,
  actions,
  onPage,
  onAction,
  listRef,
}: {
  catalog: readonly CatalogSection[];
  pages: readonly string[];
  actions: readonly string[];
  onPage: (grant: string, ticked: boolean) => void;
  onAction: (key: string, ticked: boolean) => void;
  listRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div ref={listRef} role="group" aria-label="Pages" className="@container min-w-0 overflow-hidden rounded-xl border border-border bg-background/50">
      {/* Pulled up a pixel, so the line over the first group in each column hides under the box's own border. */}
      <div className="-mt-px columns-1 gap-0 [column-rule:1px_solid_rgb(127_127_127/0.22)] @min-[560px]:columns-2">
        {catalog.map((section, index) =>
          section.pages.length === 0 ? null : (
            <fieldset key={`${index}:${section.label ?? ''}`} className="m-0 block min-w-0 break-inside-avoid border-x-0 border-t border-b-0 border-border p-2">
              {section.label ? <legend className="float-left mb-1 w-full px-2 pt-1 text-xs font-semibold text-muted-foreground">{section.label}</legend> : null}
              <div className="clear-both grid gap-0.5">
                {section.pages.map((page) => (
                  <PageRow key={page.grant ?? `every:${page.label}`} page={page} pages={pages} actions={actions} onPage={onPage} onAction={onAction} />
                ))}
              </div>
            </fieldset>
          ),
        )}
      </div>
    </div>
  );
}

function PageRow({
  page,
  pages,
  actions,
  onPage,
  onAction,
}: {
  page: CatalogPage;
  pages: readonly string[];
  actions: readonly string[];
  onPage: (grant: string, ticked: boolean) => void;
  onAction: (key: string, ticked: boolean) => void;
}) {
  const grant = page.locked ? null : page.grant;
  const open = grant === null || pages.includes(grant);
  return (
    <div className="grid min-w-0 gap-0.5" data-page={page.grant ?? page.label}>
      {grant === null ? (
        <div data-locked="" className="flex min-h-10 items-start gap-2.5 rounded-lg border border-border bg-muted/60 p-2 text-sm">
          <span className="mt-0.5 grid size-[18px] shrink-0 place-items-center text-muted-foreground">
            <LockKeyhole className="size-3.5" aria-hidden />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="font-medium [overflow-wrap:anywhere] text-foreground">{page.label}</span>
            <span className="text-xs leading-relaxed text-muted-foreground/80">{EVERY_EMPLOYEE_LINE}</span>
          </span>
        </div>
      ) : (
        <Checkbox
          checked={open}
          onCheckedChange={(ticked) => onPage(grant, ticked)}
          description={page.teamPage ? TEAM_PAGE_LINE : (page.description ?? undefined)}
          className={cn(ROW, open && ROW_TICKED)}
        >
          <span className="font-medium [overflow-wrap:anywhere]">{page.label}</span>
        </Checkbox>
      )}
      {open && page.actions.length > 0 ? (
        <div role="group" aria-label={`Inside ${page.label}`} className="ml-7 grid gap-0.5">
          {page.actions.map((action) => {
            const ticked = actions.includes(action.key);
            return (
              <Checkbox
                key={action.key}
                checked={ticked}
                onCheckedChange={(next) => onAction(action.key, next)}
                description={action.description ?? undefined}
                className={cn('min-h-9 rounded-lg border border-transparent px-2 py-1.5 hover:bg-accent', ticked && ROW_TICKED)}
              >
                <span className="[overflow-wrap:anywhere]">{action.label}</span>
              </Checkbox>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
