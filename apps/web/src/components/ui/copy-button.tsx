/**
 * Copies text and says so. The clipboard API needs a secure context; over HTTP it can fail.
 * `iconOnly`: just the icon, `label` as its accessible name and tooltip (D198).
 */
import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { CheckIcon, CopyIcon } from '@/components/icons';
import { Button, type ButtonSize, type ButtonVariant } from './button';
import { toast } from './toast';
import { Tip } from './tooltip';

export function CopyButton({
  text,
  label,
  variant = 'secondary',
  size = 'default',
  className,
  iconOnly = false,
}: {
  text: string;
  label: string;
  iconOnly?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  const button = (
    <Button
      variant={variant}
      size={size}
      className={className}
      aria-label={iconOnly ? label : undefined}
      onPress={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          toast({ title: t`Copied`, tone: 'ok' });
          setTimeout(() => setCopied(false), 2000);
        } catch {
          toast({
            title: t`Couldn't copy`,
            description: t`Select the text and copy it by hand.`,
            tone: 'danger',
          });
        }
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {iconOnly ? null : label}
    </Button>
  );
  return iconOnly ? <Tip content={label}>{button}</Tip> : button;
}
