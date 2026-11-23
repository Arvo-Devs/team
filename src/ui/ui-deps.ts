// THE design-system seam: the only place this package's client files get
// their UI primitives and UI helpers. They are self-contained copies of
// @arvo/traffic's and BetterFans Link's components (./vendor, each file
// names its source and commit and what Team changed), drawn with the shadcn
// color names that ../styles/tokens.css defines. Adapting the Team page to
// another design system means editing exactly this file: point these
// exports at your own components with the same names and props.

export { Avatar } from './vendor/avatar';
export { Button, Spinner } from './vendor/button';
export { Card } from './vendor/card';
export { cn } from './vendor/cn';
export { COPY_FAILED, CopyButton, useCopy } from './vendor/copy';
export { ConfirmDialog, Dialog, DialogContent } from './vendor/dialog';
export { errorFromBody, TeamError } from './vendor/errors';
export type { TeamErrorBody } from './vendor/errors';
export { Field } from './vendor/field';
export { formatDate } from './vendor/format';
export { Input } from './vendor/input';
export { Skeleton } from './vendor/skeleton';
export { EmptyState, ERROR_WORDS, errorKind, ErrorState, errorWords, InlineError } from './vendor/states';
export type { ErrorKind } from './vendor/states';
export { Checkbox } from './vendor/switch';
export { Table, TBody, Td, Th, THead, Tr } from './vendor/table';
export { Tab, TabList, Tabs } from './vendor/tabs';
export { RelativeTime } from './vendor/time';
export { Tip } from './vendor/tooltip';
