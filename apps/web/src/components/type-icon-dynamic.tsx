/**
 * Any Lucide icon by name, for custom types (TypeIcon's lazy branch). Imported only through
 * `React.lazy`, so `lucide-react/dynamic` and its per-icon chunks stay out of the entry bundle.
 * An unknown name renders the generic box instead of throwing.
 */
import { Box } from 'lucide-react';
import { DynamicIcon, type IconName, iconNames } from 'lucide-react/dynamic';

const known = new Set<string>(iconNames);

export default function LucideByName({
  name,
  ...props
}: {
  name: string;
  className?: string;
  strokeWidth?: number | string;
}) {
  if (!known.has(name)) return <Box {...props} aria-hidden />;
  return (
    <DynamicIcon
      name={name as IconName}
      {...props}
      aria-hidden
      fallback={() => <Box {...props} aria-hidden />}
    />
  );
}
