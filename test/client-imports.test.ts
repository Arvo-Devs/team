/**
 * What ships to a browser stays out of the server's files. The Team page,
 * the gate and the nav list are bundled for the browser, so nothing they
 * import, however far down, may be a server file, the database client or a
 * Node built-in: one such import would break the app's build, or worse,
 * ship server code to a browser. The nav list is imported by an app's own
 * nav component too, so it imports nothing at all. Copied from
 * @arvo/signup-funnel's test of the same name.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

/** Every module a file asks for at run time: static imports and re-exports, import(), require(). `import type` is erased, so it is left out. */
function specifiers(code: string): string[] {
  const found = new Set<string>();
  for (const match of code.matchAll(/^\s*(?:import|export)\s(?!type\s)[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm)) found.add(match[1]!);
  for (const match of code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) found.add(match[1]!);
  for (const match of code.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g)) found.add(match[1]!);
  return [...found];
}

function fileOf(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      try {
        readFileSync(candidate, 'utf8');
        return candidate;
      } catch {
        // A folder: try the next spelling.
      }
    }
  }
  throw new Error(`${relative(SRC, from)} imports ${specifier}, which is not a file`);
}

/** Everything reachable from one entry: the package's own files, and the outside modules they ask for. */
function reach(entry: string): { files: string[]; outside: string[] } {
  const files = new Set<string>();
  const outside = new Set<string>();
  const queue = [join(SRC, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) queue.push(fileOf(file, specifier));
      else outside.add(specifier);
    }
  }
  return { files: [...files].map((file) => relative(SRC, file)).sort(), outside: [...outside].sort() };
}

const SERVER_ONLY = (file: string) => file.startsWith('server/') || file === 'index.ts' || file === 'config.ts';
const NODE_OR_DATABASE = (name: string) => name.startsWith('node:') || name === 'postgres' || name === 'crypto' || name === 'fs' || name === 'path';

describe('what ships to a browser', () => {
  test('the page: no server file, no database client, no Node built-in', () => {
    const { files, outside } = reach('client.ts');
    expect(files).toContain('client/team-page.tsx');
    expect(files).toContain('client/gate.tsx');
    expect(files).toContain('shared/api.ts');
    expect(files).toContain('nav.ts');
    expect(files.filter(SERVER_ONLY)).toEqual([]);
    expect(outside.filter(NODE_OR_DATABASE)).toEqual([]);
    // Exactly the outside modules the page needs around it (the README lists them).
    expect(outside).toEqual([
      '@base-ui/react/avatar',
      '@base-ui/react/checkbox',
      '@base-ui/react/dialog',
      '@base-ui/react/switch',
      '@base-ui/react/tabs',
      '@base-ui/react/tooltip',
      '@tanstack/react-query',
      'class-variance-authority',
      'clsx',
      'lucide-react',
      'next/navigation',
      'react',
      'tailwind-merge',
    ]);
  });

  test('the nav list: one file, nothing else, so any nav component can import it', () => {
    expect(reach('nav.ts')).toEqual({ files: ['nav.ts'], outside: [] });
  });

  test('the contract between the routes and the page: no server file, nothing outside', () => {
    const { files, outside } = reach('shared/api.ts');
    expect(files.filter(SERVER_ONLY)).toEqual([]);
    expect(outside).toEqual([]);
  });

  test('every file a browser gets that uses state, an effect or the address says it is a client file', () => {
    const { files } = reach('client.ts');
    for (const file of files) {
      const code = readFileSync(join(SRC, file), 'utf8');
      const needs = /\buse(State|Effect|Ref|Memo|Id|Query|InfiniteQuery|Mutation|QueryClient|SearchParams|Router|Pathname|Callback|Copy)\s*\(|\bcreateContext\s*[<(]/.test(code);
      if (needs) expect(`${file}: ${/^'use client';/m.test(code)}`).toBe(`${file}: true`);
    }
  });
});

describe('the server entry', () => {
  // The server is a separate entry; once it is there, it never pulls in React or the page.
  // (next/navigation is allowed: requirePage and requireArea answer with Next's notFound().)
  test.skipIf(!existsSync(join(SRC, 'index.ts')))('no React, and none of the page', () => {
    const { files, outside } = reach('index.ts');
    expect(files.filter((file) => file.startsWith('client') || file.startsWith('ui/'))).toEqual([]);
    expect(outside.filter((name) => name === 'react' || name.startsWith('react-') || name.startsWith('@base-ui') || name === 'lucide-react')).toEqual([]);
  });
});
