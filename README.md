# @arvo/team

A Team page for your app's Admin section: roles that each open a chosen set
of the app's pages, and the employees put in those roles, so each hire gets
exactly the pages their job needs. Built like
[@arvo/traffic](https://github.com/Arvo-Devs/traffic) and
[@arvo/signup-funnel](https://github.com/Arvo-Devs/signup-funnel): one
package, installed in each app pinned to a commit, with its page in the app's
Admin section.

**One check behind the nav, the page and the data.** The app's nav list says
who may open each page. The same check hides the nav item, answers "page not
found" for the page and refuses the data behind it, so the three never
disagree.

**Every app lists its own pages and keeps its own team.** The package knows
nothing about any one app: the app gives it its nav list, a database
connection, who is signed in, who has Mass Access (the app's top account) and
its accounts. Nothing goes to a central server. It is for the company's own
staff: a customer's team inside its own workspace stays the app's own.

## What it does

- **Roles open pages.** A role is the few pages one job needs (Marketing
  opens Email and Traffic), plus actions inside a page it gets apart from the
  page ("Change the email settings"). Several roles open every page any of
  them gives.
- **The Team page** has three tabs: Employees (add someone by email, change
  their roles, remove them), Roles (made from the app's own list of pages)
  and, for Mass Access only, History (every change, as a sentence). The tab
  is in the address (`?tab=roles`). On a phone the lists become blocks you
  tap, and dialogs stay in the middle of the screen.
- **Managers give only what they have**, and an account joins at once by its
  confirmed email ([The rules](#the-rules)).
- **It fails closed and never breaks the app.** A page nobody chose opens
  for Mass Access only, and looking through someone else's account (log in
  as, view as) opens only `everyone` pages and writes nothing. A mistake in
  the nav list or config is one line in the log and, for Mass Access, on the
  Team page, with changes off until it is fixed. When the team can't be
  read, employees get no team pages on that request and Mass Access keeps
  every page.

## Installing

Pin to a **commit SHA** (tags move; the SHA is the pin):

```jsonc
// package.json
"dependencies": {
  "@arvo/team": "github:Arvo-Devs/team#<full-commit-sha>"
}
```

```ts
// next.config.ts: the package ships TypeScript source, and the app compiles it
transpilePackages: ["@arvo/team"],
```

Updating means reading `git diff <old-sha>..<new-sha>` in this repo, moving
the SHA, installing, and committing the lockfile; a version that changes the
tables adds a migration file to copy in, in order. Install with a frozen
lockfile in builds. A fix to the page or the rules is made here, never in one
app.

## Requirements

The same as @arvo/traffic, so an app that has Traffic has them all:

- **Next.js 16.3+ (App Router), React 19.2+ and Node 24+**, with
  **@tanstack/react-query v5** around the page (your `QueryClientProvider`).
  The peer dependencies are `next`, `react`, `@tanstack/react-query`,
  `@base-ui/react`, `lucide-react`, `clsx`, `class-variance-authority`,
  `tailwind-merge` and `postgres`, at the versions in `package.json`.
- **Postgres 14 or later, through a
  [postgres.js](https://github.com/porsager/postgres) client.** Any client
  works (wrapped by drizzle or not, `fetch_types` off, a camel-case
  `transform`): the package reads everything as JSON it parses itself. A
  small pool of its own is the simple choice.
- **Tailwind CSS v4.** Add a source line (the path is from your CSS file) so
  Tailwind sees the page's classes:

  ```css
  @source "../node_modules/@arvo/team/src";
  ```

## Theming

The page uses the color names @arvo/traffic and @arvo/signup-funnel use, the
shadcn way: `background`, `foreground`, `card`, `muted`, `muted-foreground`,
`border`, `input`, `primary`, `primary-foreground`, `accent`, `ring`, and the
`success`/`warning`/`danger` `-strong`, `-soft` and `-border` trios. An app
that already maps these for the Traffic page has nothing to add. Otherwise
import the defaults once:

```css
@import "@arvo/team/styles/tokens.css";
```

Adapting to another design system means editing one file, `src/ui/ui-deps.ts`.

## The nav list

**The app's nav list is its list of pages:** one list in one place, with
every signed-in page in it. The left nav, the page check and the Team page's
checklist all read it, so they can't drift apart. Each item says who may
open it:

```ts
// lib/nav.ts: plain data, imported by the server and by the browser's nav
import type { TeamNav, TeamNavItem } from "@arvo/team/nav";
import { Filter, Gauge, House, Inbox, KeyRound, TrendingUp, Users, type LucideIcon } from "lucide-react";

type NavItem = TeamNavItem & { icon: LucideIcon }; // the app's own fields pass through untouched

export const NAV: TeamNav<NavItem> = [
  {
    label: null,
    items: [
      { label: "Home", href: "/dashboard", icon: House, access: "everyone" },
      { label: "Overview", href: "/dashboard/overview", icon: Gauge, access: "employees", description: "How the business is doing." },
    ],
  },
  {
    label: "Admin",
    items: [
      { label: "Email", href: "/dashboard/admin/email", icon: Inbox, access: "role", grant: "email",
        description: "Read and answer the emails customers send to support.",
        actions: [{ key: "email.settings", label: "Change the email settings" }] },
      { label: "Traffic", href: "/dashboard/admin/traffic", icon: TrendingUp, access: "role", grant: "traffic",
        description: "Visits to the site and where they came from. Includes making tracking links.",
        subpages: true }, // /dashboard/admin/traffic/links/42 is Traffic's too
      { label: "Sign-up funnel", href: "/dashboard/admin/signup-funnel", icon: Filter, access: "role", grant: "signup-funnel" },
      { label: "Team", href: "/dashboard/admin/team", icon: Users, access: "role", grant: "team" },
      { label: "Log in as", href: "/dashboard/admin/log-in-as", icon: KeyRound, access: "mass-access" },
    ],
  },
];

/** Grants and action keys of pages that left the app. Never take one out of this list. */
export const RETIRED_GRANTS: readonly string[] = [];
```

| `access` | Who opens it | In the role editor |
|---|---|---|
| `everyone` | Anyone signed in: the customers' pages. Never in the Admin section. | Not shown |
| `employees` | Every employee, whatever their roles (an internal tool's Overview) | A locked row, "Included for every employee" |
| `role` | The employees whose roles give its `grant`, and Mass Access | A box to tick |
| `mass-access` | Only Mass Access (log in as, the page that lists every workspace) | Not shown |

- **`access` is required on every item,** with no default. A missing or
  unknown one opens for nobody but Mass Access, and `navProblem` names it.
- **A `role` page needs a `grant`:** a short name that never changes, like
  `email`, never taken from the address, so the page can move. A lower case
  letter, then lower case letters, digits, dots, dashes and underscores, at
  most 60 in all; each grant and action key is used once in the whole list.
- **`actions`** (on `role` and `employees` pages only) are things inside a
  page a role gets apart from it, with keys in the same format. An action
  counts only with its page: it shows under the page once that is ticked,
  and unticking the page drops it.
- **`subpages: true`** makes the addresses under a page that page too.
  Without it, an address the list doesn't name opens for Mass Access only.
  Even with it, a deeper page in the same branch wins: with Home at
  `/dashboard` (`subpages: true`), an unlisted `/dashboard/admin/new` is
  nobody's, because Email at `/dashboard/admin/email` is deeper. Only checks
  by address use this. List every page.
- **A grant is never reused.** When a page leaves the app, put its grant and
  its actions' keys in `RETIRED_GRANTS` (the config's `retiredGrants`). The
  server takes them off every role, with a History line per role, and
  `navProblem` refuses a live page that uses one, so a later page can't open
  for the old role's people.
- **A section labelled Admin can't hold an `everyone` page.**
- **The Team page is in the list too,** as a `role` page (given to whoever
  manages the team) or `mass-access`. Its label is the page's title, and no
  other page may have it: "Team", or "Staff" where customers already have a
  page called Team.

`@arvo/team/nav` is plain TypeScript, with no Node and no React, so the
browser's nav can import it:

| Export | What it is |
|---|---|
| `TeamNav`, `TeamNavSection`, `TeamNavItem`, `TeamNavAction`, `TeamAccessKind`, `TeamView` | The types. A view is what one person may open, `{ massAccess, employee, pages, actions }`: plain JSON. |
| `ACCESS_KINDS`, `NOBODY` | The four kinds, and the view of someone the check knows nothing about (`everyone` pages only) |
| `canOpenPage(view, item)` | The rule, for one nav item |
| `canOpenRef(view, nav, ref)`, `canDoAction(view, nav, key)` | The same for a grant or an address (`subpages` included), and for an action with its page |
| `filterNav(nav, view)` | The nav as one person sees it; a section left empty goes too |
| `pageFor(nav, path)`, `pageForRef(nav, ref)` | The nav item an address or a reference belongs to, or null |
| `grantsOf(nav)`, `navProblem(nav, { teamPage, retiredGrants })` | Every grant and action key, for your test's snapshot; what is wrong with the list in one sentence, or null |

## Setting it up

**1. The tables.** Copy `migrations/0001_team.sql` into the app's migrations
([Migrations](#migrations)) and give the app's database login its rights
([Grants](#grants)). Until it has run, nobody gets a team page, Mass Access
keeps every page, and the server log says once to run it.

**2. One server file.** Lazy, so nothing connects at build time:

```ts
// lib/team.server.ts
import { cache } from "react";
import { createTeam, type TeamUser } from "@arvo/team";
import { NAV, RETIRED_GRANTS } from "@/lib/nav";

let cached: ReturnType<typeof createTeam> | null = null;
export function team() {
  cached ??= createTeam({
    db: teamDb,                        // () => postgres.Sql | null, or a Promise of one; null answers 503
    signedInUser,                      // (request, { fresh }) => Promise<TeamUser | null>
    hasMassAccess,                     // (userId) => boolean | Promise<boolean>: read every time; only true counts
    nav: NAV,
    teamPage: "/dashboard/admin/team", // the Team page's own address in the nav
    siteHosts: ["app.example.com"],    // a change from any other host is refused before anything is read
    accounts,                          // { byIds, byEmail, massAccess? }
    signOutEverywhere,                 // (userId) => Promise<void>
    createAccount,                     // or signUpUrl: "https://app.example.com/sign-up"
    retiredGrants: RETIRED_GRANTS,
    // basePath: "/api/team",          // where the route file is mounted
    // log: (line, error) => {},       // default console.error
  });
  return cached;
}

/** What this person may open, read once per request: for the nav. */
export const myTeamView = cache(async () => team().view(await currentUser()));
```

All but `createAccount`, `signUpUrl`, `retiredGrants`, `basePath` and `log`
are required. A missing or wrong one never throws: the log says what is
wrong, and changes stay off until it is fixed.

- **`signedInUser`** answers `{ id, email?, name?, emailVerified?, viewedAs? }`.
  `fresh` is true before any change: skip any session cache then. `viewedAs`
  is true while someone looks through this account (log in as, a staff "view
  as"): the package then gives only `everyone` pages and writes nothing.
- **`accounts`**: `byIds(ids)` (at most 500 a call; missing ones left out),
  `byEmail(email)` (already trimmed and lower-cased) and, optionally,
  `massAccess()` (listed first, for Mass Access only). An account is
  `{ id, name?, email?, emailVerified?, image?, lastSeenAt? }`, read live and
  never kept: a deleted one shows as "Deleted account", and no `lastSeenAt`
  reads "No recent sign-in".
- **`signOutEverywhere`** ends every session the account has, after an
  existing account joins (so a session someone opened on it before its email
  was confirmed can't use the new pages) and after a removal. If it fails,
  the change stands and the log says so.
- **`createAccount` or `signUpUrl`**, for an email with no account.
  `createAccount({ email, name, addedBy })` is for apps where people can't
  sign up on their own: Add employee also asks for a full name, and the app
  makes the login and emails a link to set the password. It answers
  `{ id, created, emailed? }`, or null when it couldn't: `created: false`
  when the email already had an account (the rules for one then apply),
  `emailed: false` when the email didn't go out (the page says so, and points
  them to Forgot password on the sign-in page). `signUpUrl` is for apps with
  open sign-up: the page offers it to copy. With neither, the page says to
  sign up first.

**An example for Better Auth,** with postgres.js. **Adapt it:** it uses
snake_case columns, where Better Auth's own default is camelCase
(`"emailVerified"`, `"userId"`), and an app may keep its accounts in another
schema or on another pool. Read your app's schema before you copy a line.

```ts
// lib/team.server.ts, continued
import { randomBytes } from "node:crypto";
import { headers } from "next/headers";
import postgres from "postgres";
import type { TeamAccount, TeamAccounts, TeamCreateAccount } from "@arvo/team";
import { auth } from "@/lib/auth";                   // the app's Better Auth
import { hasMassAccess } from "@/lib/mass-access";   // the app's one check, by account id

let pool: postgres.Sql | null = null;
/** A small pool of its own, made on first use; null without a database. */
const teamDb = () => (process.env.DATABASE_URL ? (pool ??= postgres(process.env.DATABASE_URL, { max: 3 })) : null);
/** For the hooks below: they throw rather than answer "nobody". */
function sqlNow() {
  const sql = teamDb();
  if (!sql) throw new Error("No database");
  return sql;
}

type Found = Awaited<ReturnType<typeof auth.api.getSession>>;
const toTeamUser = (found: Found): TeamUser | null =>
  found && {
    id: found.user.id,
    email: found.user.email,
    name: found.user.name,
    emailVerified: found.user.emailVerified,
    viewedAs: Boolean(found.session.impersonatedBy), // log in as, from Better Auth's admin plugin
  };

/** For the routes. `fresh` skips Better Auth's cookie cache before a change. */
export async function signedInUser(request: Request, { fresh }: { fresh: boolean }) {
  return toTeamUser(await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: fresh } }));
}
/** For pages and layouts. */
export async function currentUser() {
  return toTeamUser(await auth.api.getSession({ headers: await headers() }));
}

/** An account's columns, with last seen: its newest session's last refresh, leaving out log in as. */
const ACCOUNT = (sql: postgres.Sql) => sql`
  u.id, u.name, u.email, u.email_verified as "emailVerified", u.image,
  (select max(s.updated_at) from "session" s where s.user_id = u.id and s.impersonated_by is null) as "lastSeenAt"`;

const accounts: TeamAccounts = {
  byIds: async (ids) => {
    if (ids.length === 0) return [];
    const sql = sqlNow();
    return sql<TeamAccount[]>`select ${ACCOUNT(sql)} from "user" u where u.id in ${sql([...ids])}`;
  },
  byEmail: async (email) => {
    const sql = sqlNow();
    const [row] = await sql<TeamAccount[]>`select ${ACCOUNT(sql)} from "user" u where lower(u.email) = ${email} limit 1`;
    return row ?? null;
  },
  massAccess: async () => {
    const sql = sqlNow(); // Mass Access is Better Auth's admin role on the account
    return sql<TeamAccount[]>`select ${ACCOUNT(sql)} from "user" u where 'admin' = any (string_to_array(coalesce(u.role, ''), ','))`;
  },
};

async function signOutEverywhere(userId: string) {
  await sqlNow()`delete from "session" where user_id = ${userId}`;
}

/** No sign-up of their own: a login with a password nobody knows, then the app's reset email as the link to set one. */
const createAccount: TeamCreateAccount = async ({ email, name }) => {
  const made = await auth.api
    .createUser({ body: { email, name, password: randomBytes(32).toString("base64url") } }) // never pass a role
    .catch(() => null);
  if (!made?.user) {
    const existing = await accounts.byEmail(email); // someone made one with this email a moment ago
    return existing ? { id: existing.id, created: false } : null;
  }
  try {
    await auth.api.requestPasswordReset({ body: { email, redirectTo: "/reset-password" } });
    return { id: made.user.id, created: true };
  } catch (error) {
    console.error("[Team] the set-password email did not go out", error);
    return { id: made.user.id, created: true, emailed: false };
  }
};
```

- **Last seen** is a rough guide: Better Auth deletes a session at sign-out,
  and the Team page signs people out when they join. An app that records
  sign-ins gives that instead.
- **Sessions kept anywhere else** (Better Auth's secondary storage, say) end
  there too, and Better Auth's cookie cache keeps a deleted session working
  until the cache runs out.
- **`createUser`** is Better Auth's admin plugin, called from the server.
  Better Auth (1.4 and later) logs a failed reset email instead of throwing,
  so `emailed: false` here only means the reset couldn't start. An app that
  sends its own welcome email knows for sure, and can make its link last
  longer than Better Auth's default hour.

**3. One route file.**

```ts
// app/api/team/[[...route]]/route.ts
import { team } from "@/lib/team.server";
export const GET = (request: Request) => team().routeHandlers.GET(request);
export const POST = (request: Request) => team().routeHandlers.POST(request);
export const PATCH = (request: Request) => team().routeHandlers.PATCH(request);
export const DELETE = (request: Request) => team().routeHandlers.DELETE(request);
```

Mounted somewhere else? Give the same path as `basePath` in the config and to
the page (`<TeamPage basePath>`, or `<TeamProvider basePath>` around the
browser parts).

**4. The page, called Team, in the Admin section,** with the app's usual top,
inside the app's `QueryClientProvider`. A server page can't hand a function
to a browser component, so `renderHeader` goes in a small client file:

```tsx
// app/dashboard/admin/team/team-screen.tsx
"use client";
import { TeamPage } from "@arvo/team/client";
import { PageHeader } from "@/components/page-header";

export function TeamScreen() {
  return <TeamPage renderHeader={({ title, description, actions }) => <PageHeader title={title} description={description} actions={actions} />} />;
}
```

```tsx
// app/dashboard/admin/team/page.tsx
import { currentUser, team } from "@/lib/team.server";
import { TeamScreen } from "./team-screen";

export default async function Page() {
  await team().requirePage(await currentUser(), "/dashboard/admin/team");
  return <TeamScreen />;
}
```

The title is the Team page's nav label, the line under it "Add the people who
work here, and choose which pages each role opens.", and `actions` the open
tab's main button. Without `renderHeader` the page draws a plain top of its
own. `TeamPageSkeleton` (same `renderHeader`) is its loading look, for a
`loading.tsx` or a gate of the app's own.

**5. The check, in three places.**

*The nav.* The server layout reads the view once per request and hands it,
plain JSON, to the nav:

```tsx
// app/dashboard/layout.tsx
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <AppShell view={await myTeamView()}>{children}</AppShell>;
}

// components/app-shell.tsx: "use client", with filterNav and TeamView from "@arvo/team/nav"
export function AppShell({ view, children }: { view: TeamView; children: React.ReactNode }) {
  const sections = filterNav(NAV, view); // what they can't open is left out, and so is a section left empty
  // ...
}
```

A nav drawn only in the browser gets the same view from `GET /api/team/me`:
`const { data: view } = useTeamView()` (from `@arvo/team/client`), then
`filterNav(NAV, view ?? NOBODY)`.

*The page.* Every page file starts with `requirePage`, which calls Next's
`notFound()` unless the person may open the page. An admin folder's layout
calls `requireArea` in place of a Mass-Access-only gate: it lets in Mass
Access and employees, and every page under it still checks itself, because a
layout doesn't run again when someone moves between its pages.

```tsx
export default async function EmailPage() {
  await team().requirePage(await currentUser(), "email"); // the page's grant, or its own address
  // ...
}

// app/dashboard/admin/layout.tsx
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await team().requireArea(await currentUser());
  return children;
}
```

- Pages only Mass Access opens keep the app's own Mass Access check.
- **Never wrap `requirePage` or `requireArea` in try/catch.** `notFound()`
  works by throwing, so a catch would show the page.
- A page the app must draw in the browser can sit inside
  `<TeamPageGate page="email" nav={NAV}>`, in a client component (a nav list
  with icons can't be sent from a server component). Anyone else sees "This
  page does not exist.", or your own `fallback`. It only hides the page: the
  data stays checked on the server.

*The data.* Every route handler or procedure behind a page checks again, and
refuses with the same not found:

```ts
const user = await signedInUser(request, { fresh: false });
if (!(await team().can(user, "email"))) return new Response(null, { status: 404 });
if (!(await team().canDo(user, "email.settings"))) return new Response(null, { status: 404 });
```

`can(user, ref)` takes a grant or an address, `canDo(user, key)` an action
(its page included), and `canOpen(user, pathname)` any address. Each reads
the team once. A grant the nav doesn't list answers no for everyone, Mass
Access included, and the log says so once, so a typo fails closed. Data that
several pages show checks whether the person can open any of them: read
`team().view(user)` once and ask `canOpenRef(view, NAV, grant)` for each.

**6. Deleted accounts.** The app's delete-account code calls
`await team().forgetAccount(user.id)`. It takes the account off the team,
roles and all, with one History line, and answers how many rows went (0 or
1), or `null` when it could not (try again later). It never throws. History
keeps its rows: they hold ids, never a name or an email.

**7. The app's own ways in.** A flow of the app's own that already proves who
someone is (an invite link it checked against the signed-in email) runs the
Team page's own code:

```ts
await team().join({ userId, roleIds, by: inviterId }); // by: who is acting; null is the app itself
await team().leave({ userId, by: null });
```

With `by` set, the Team page's rules apply to that account: it must manage
the team now, and it gives only roles it holds. `null` is the app itself,
with no such checks, and History says "The app". Both answer `{ ok: true }`
or `{ ok: false, reason }` and never throw. Neither checks the email or signs
anyone out: the app's own flow has done what it needs.

## Traffic, Sign-up funnel and Email

**These imports keep their own routes and pages; only their gate changes,**
from Mass Access only to the Team check, so a role can open them. With the
grants and the action from the nav example:

```ts
// lib/traffic.server.ts
canView: (user) => team().can(user, "traffic"),

// lib/signup-funnel.server.ts
canView: (user) => team().can(user, "signup-funnel"),

// lib/support-inbox.server.ts: the Email page
authorize: async (request) => {
  const user = await signedInUser(request, { fresh: true });
  if (!user?.email || user.viewedAs || !(await team().can(user, "email"))) return null; // null: the same 404 as an unknown route
  const settings = new URL(request.url).pathname === "/api/admin/support/connection"; // its settings route
  if (request.method === "POST" && settings && !(await team().canDo(user, "email.settings"))) return null;
  return { id: user.id, email: user.email, name: user.name ?? undefined }; // recorded as who sent each reply
},
```

Their pages call `requirePage` like any other page, with the same grants.
Traffic's `canView` can't tell looking from changing, so a role that opens
Traffic makes and deletes tracking links too (its nav line says so). Email's
reading and answering need only Email; saving a new key also needs "Change
the email settings".

## Migrations

`migrations/0001_team.sql` makes four tables: `team_roles`, `team_employees`,
`team_employee_roles` and `team_history`. Copy it in unchanged, the way the
app's tool wants:

| The app's migrations | What to do |
|---|---|
| SQL files with a drizzle journal | Copy it in as the next `NNNN_team.sql` with a journal entry like the one above it: the next `idx`, the file's name without `.sql` as `tag`, `"breakpoints": true`, and as `when` the time now in milliseconds, later than every entry above (drizzle skips a migration dated before the newest one it ran). |
| `drizzle-kit generate` | Run `drizzle-kit generate --custom --name team`, which makes an empty file with its journal entry, and paste the file into it. |
| SQL kept as strings in the app's code | Paste it as the next entry. The file has no backslash, backtick or `${`, so a plain template string keeps it exactly as it is. |
| Anything else | Run the file as it is: the `--> statement-breakpoint` lines are comments. |

- **Never declare these tables in the app's drizzle schema:** a later
  `drizzle-kit generate` would write a plain CREATE for them that fails.
- **Never edit it once applied** (a later version adds `0002`), and never
  rename its tables, columns, constraints, functions or triggers: the package
  tells errors apart by constraint name.
- **Company-level tables: no `organization_id` and no row-level security,**
  like Better Auth's own. Under row-level security with no policy for them,
  the app's login reads no rows and nobody gets their pages.
- **Postgres 14 or later** (`create or replace trigger`). Every statement can
  run twice, and it stops with an error if a table already has one of these
  names and isn't the package's.
- **Names are unqualified:** the tables land in the schema the migration runs
  in, and the package finds them through its connection's `search_path`. One
  team per schema: two apps that share a schema share a team.

## Grants

The app's database login needs SELECT, INSERT, UPDATE and DELETE on
`team_roles`, `team_employees` and `team_employee_roles`, and only SELECT and
INSERT on `team_history`.

- **A login named `app_user` gets them from the migration itself.** Grant the
  same to a login with another name; one that owns the tables needs nothing.
  The history id is an identity column: no sequence to grant.
- **A script that grants the login every table** (`GRANT ALL ON ALL TABLES`)
  hands history's UPDATE and DELETE back each time it runs. Narrow it right
  after the blanket grant:

  ```sql
  DO $$ BEGIN
    IF to_regclass('team_history') IS NOT NULL THEN
      REVOKE ALL ON TABLE team_history FROM app_user;
      GRANT SELECT, INSERT ON TABLE team_history TO app_user;
    END IF;
  END $$;
  ```

- **History can't be changed** whatever the grants: a trigger refuses every
  UPDATE, DELETE and TRUNCATE on `team_history`, and only the table's owner
  could switch it off.

## The rules

What the routes hold to, in plain words, whatever the page sends them.

- **Who manages the team:** anyone whose role opens the Team page, and Mass
  Access. Everyone else, anyone signed out and anyone looking through someone
  else's account gets the same "not found" as an address that doesn't exist.
  Only Mass Access sees History.
- **You can only give what you have.** A manager ticks only pages they can
  open and actions they can do, gives only roles they hold, and is put in
  every role they make, so they can manage it. Mass Access gives any role
  page and any action, and a role it makes goes to nobody until it is given.
- **Taking away needs all of someone's roles.** Taking a role off someone,
  removing them, unticking a role's pages or deleting a role is only for
  someone who holds every role each person affected holds. A manager edits
  only roles they are in.
- **Never Mass Access, never yourself.** Mass Access accounts can't be added,
  changed or removed here: they already open every page. Nobody adds,
  changes or removes themselves. The page asks first before you take the
  Team page off a role you're in.
- **What you can't see stays as it is.** A manager doesn't see the Mass
  Access accounts, last seen, History, or the names of roles they don't hold
  ("+2 more"), and their saves keep those roles and pages as they were.
- **Adding someone.** An existing account with a confirmed email joins at
  once and is signed out everywhere, so it signs in again to its new pages.
  An account whose email isn't confirmed is refused until it is. With no
  account, `createAccount` makes one, or the page says to sign up first.
  Someone already on the team, a Mass Access account, or yourself is refused
  with one plain line.
- **Removing someone** takes every page their roles opened, from their next
  click, and signs them out everywhere. Their account stays, and they can be
  added again.
- **A stale change is refused.** If someone else changed the role or the
  person while you had it open, nothing is saved and the page says so.
- **History** gets one line per change, written in the same transaction as
  the change. It keeps role names, and the pages they opened with their
  names at the time; people by id only (their names are read now, "Deleted
  account" once gone); never an email. Nothing can edit or delete it.

## Routes

| Route | Who | What |
|---|---|---|
| `GET /api/team` | Anyone the Team page opens for | Everything the page shows them: `TeamState` |
| `GET /api/team/me` | Anyone signed in | Their own `TeamView`, for a nav drawn in the browser (the empty one while looking through someone else's account) |
| `GET /api/team/history?before=` | Mass Access | 50 changes, newest first: `HistoryPage` |
| `POST /api/team/employees` | The Team page | Add someone: `{ email, name?, roleIds }` → `AddResult` |
| `PATCH /api/team/employees/<id>` | The Team page | Change their roles: `{ roleIds, token }` → `EmployeeView` |
| `DELETE /api/team/employees/<id>?token=` | The Team page | Remove them → `{ removed: true }` |
| `POST /api/team/roles` | The Team page | Make a role: `{ id, name, pages, actions }` → `RoleView`. The page makes the id, so a double click makes one role. |
| `PATCH /api/team/roles/<id>` | The Team page | Change a role: `{ name, pages, actions, version }` → `RoleView` |
| `DELETE /api/team/roles/<id>?version=` | The Team page | Delete a role → `{ deleted: true }` |

"The Team page" is anyone the Team page opens for, sending from the site's
own pages (`siteHosts`) as JSON. The shapes are in `src/shared/api.ts`, the
contract between the routes and the page.

Errors come as `{ error: { type, code, message, hint?, param? }, requestId }`,
and every answer is `no-store`. `message` is already in plain words for the
screen, and `param` names the field a refusal is about (`email`, `name`,
`pages`). Signed out, looking through someone else's account, or without the
Team page: the same 404 as an address that doesn't exist. A change from
another site is a 403, and one not sent as JSON a 400, before anything is
read. Any other refusal is a 400, 403 or 409 with its `code`
(`TeamErrorCode`), 409 meaning the team changed first: a stale token or
version, a name just taken, a role just deleted, someone already added. No
database is a 503.

## Test it

In the app, two tests: one catches a nav list the Team page can't use, the
other a page that left without being retired.

```ts
import { expect, test } from "bun:test"; // or vitest
import { grantsOf, navProblem } from "@arvo/team/nav";
import { NAV, RETIRED_GRANTS } from "@/lib/nav";

test("the Team page can use the nav list", () => {
  expect(navProblem(NAV, { teamPage: "/dashboard/admin/team", retiredGrants: RETIRED_GRANTS })).toBeNull();
});

test("no grant leaves the nav without being retired", () => {
  expect(grantsOf(NAV)).toMatchSnapshot();
});
```

When the snapshot fails because a grant is gone, add it to `RETIRED_GRANTS`,
then update the snapshot. A new grant only needs the snapshot updated.

Then try it in the real app with made-up accounts only: as Mass Access, make
a role with one page and add a made-up account to it. Signed in as that
account in a private window, the nav shows only its pages, and any other
admin address and the data behind it answer "page not found".

## Privacy

- The package keeps account ids, role names, which pages and actions each
  role opens, who is on the team, who added them and when, and History.
  Names, emails and pictures are read live through `accounts`, never kept.
- History can never be edited or deleted, so it holds ids, role names and
  page names, never an email. Keep anything personal out of role names.
- Last seen, the Mass Access accounts and History are shown to Mass Access
  only.
- The nav list ships to the browser with its page lines and action labels.
  Write nothing there you wouldn't show a customer.

## Not in 0.1

Pending invites or invite links of the package's own (an app's own invite
flow calls `join`); extra pages for one person (give them a role); teams as
an org chart, a role on/off switch, role descriptions and Select all; the
tabs as separate pages; searching History; one grant shared by several pages
(data several pages show checks whether the person can open any of them).

## Development

```sh
bun install
bun run typecheck
bun test
```

The database tests run when `TEAM_TEST_PG_URL` points at a Postgres they may
create databases on, and skip otherwise. CI runs them on every pull request
and every push to main.
