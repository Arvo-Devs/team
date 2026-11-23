/**
 * createTeam never throws, whatever the nav list holds: a list the check
 * refuses is read with its unreadable parts left out, the problem is kept
 * for the Team page to show, and every unclear page stays closed.
 */
import { describe, expect, test } from 'bun:test';
import { createTeam } from '../src/index';
import type { TeamNav } from '../src/nav';
import { fakeConfig, NAV, world, type Person } from './fake-app';

const olive: Person = { id: 'olive', email: 'olive@example.com', name: 'Olive Owner' };
const cara: Person = { id: 'cara', email: 'cara@example.com', name: 'Cara Customer' };

describe('a nav list that is not a nav list', () => {
  const broken: Array<[string, unknown]> = [
    ['not a list', 'nav'],
    ['a section that is null', [null, ...NAV]],
    ['a section with no items', [{ label: 'Admin' }, ...NAV]],
    ['items that are not a list', [{ label: 'Admin', items: 'email' }]],
    ['an item that is null', [{ label: 'Admin', items: [null, { label: 'Email', href: '/dashboard/admin/email', access: 'role', grant: 'email' }] }]],
    ['an item with no address', [{ label: 'Admin', items: [{ label: 'Email', access: 'role', grant: 'email' }] }]],
    ['actions that are not a list', [{ label: 'Admin', items: [{ label: 'Email', href: '/dashboard/admin/email', access: 'role', grant: 'email', actions: 'settings' }] }]],
    ['an action that is null', [{ label: 'Admin', items: [{ label: 'Email', href: '/dashboard/admin/email', access: 'role', grant: 'email', actions: [null, { key: 7 }] }] }]],
  ];

  for (const [what, nav] of broken) {
    test(`${what}: createTeam still starts, logs what is wrong, and opens nothing for a customer`, async () => {
      const w = world();
      const team = createTeam(fakeConfig(w, { nav: nav as TeamNav }));
      expect(w.logs.some((line) => line.includes('not set up right'))).toBe(true);
      expect(await team.can(cara, 'email')).toBe(false);
      expect(await team.canOpen(cara, '/dashboard/admin/email')).toBe(false);
      expect(await team.canDo(cara, 'email.settings')).toBe(false);
      // Mass Access still opens every page, so the person who can fix it is not locked out.
      expect(await team.canOpen(olive, '/dashboard/admin/email')).toBe(true);
      const view = await team.view(cara);
      expect([view.massAccess, view.employee]).toEqual([false, false]);
    });
  }
});
