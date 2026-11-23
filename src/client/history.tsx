'use client';

// The History tab (Mass Access only): every change to employees and roles,
// newest first, as sentences the server writes with the names as they are
// now. 50 at a time, then "Show older".
import { History as HistoryIcon } from 'lucide-react';
import { Button, EmptyState, ErrorState, InlineError, RelativeTime, Spinner, Table, TBody, Td, Th, THead, Tr } from '../ui/ui-deps';
import { useTeamHistory } from './api';
import { SkeletonRows } from './parts';

export function HistoryTab() {
  const history = useTeamHistory();
  if (history.isPending) return <SkeletonRows />;
  if (!history.data) return <ErrorState error={history.error} onRetry={() => void history.refetch()} retrying={history.isFetching} />;
  const rows = history.data.pages.flatMap((page) => page.rows);
  if (rows.length === 0) {
    return (
      <EmptyState icon={HistoryIcon} title="No changes yet">
        Every change to employees and roles shows up here.
      </EmptyState>
    );
  }
  return (
    <>
      <Table label="History" className="hidden @min-[640px]:block">
        <THead>
          <Th className="w-36">When</Th>
          <Th>What changed</Th>
        </THead>
        <TBody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td className="py-2.5 align-top text-[13px] whitespace-nowrap text-muted-foreground">
                <RelativeTime iso={row.at} />
              </Td>
              <Td className="py-2.5 leading-relaxed [overflow-wrap:anywhere] text-foreground">{row.text}</Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      <ul aria-label="History" className="divide-y divide-border @min-[640px]:hidden">
        {rows.map((row) => (
          <li key={row.id} className="px-4 py-3 text-sm">
            <p className="leading-relaxed [overflow-wrap:anywhere] text-foreground">{row.text}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <RelativeTime iso={row.at} />
            </p>
          </li>
        ))}
      </ul>
      {history.isFetchNextPageError ? <InlineError className="mx-4 mb-3 sm:mx-5" error={history.error} when="load" /> : null}
      {history.hasNextPage ? (
        <div className="border-t border-border px-4 py-3 sm:px-5">
          <Button size="sm" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>
            {history.isFetchingNextPage ? <Spinner /> : null}
            Show older
          </Button>
        </div>
      ) : null}
    </>
  );
}
