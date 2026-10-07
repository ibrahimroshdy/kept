/** Shared field parts: label, description, error and the input box (screens kit .field / .input). */
import type { ReactNode } from 'react';
import {
  FieldError as FieldErrorPrimitive,
  type FieldErrorProps,
  Label as LabelPrimitive,
  type LabelProps,
  Text,
  type TextProps,
} from 'react-aria-components';
import { cn } from '@/lib/utils';

export const inputClass =
  'min-h-11 w-full min-w-0 rounded-lg border border-line bg-surface px-3 py-2.5 font-[inherit] text-[16px] leading-[1.3] text-ink outline-none placeholder:text-ink-3 data-focused:border-info data-focus-visible:outline-2 data-focus-visible:outline-offset-1 data-focus-visible:outline-info data-invalid:border-danger data-disabled:opacity-50';

export function Label({ className, ...props }: LabelProps) {
  return (
    <LabelPrimitive
      data-slot="label"
      className={cn(
        'font-semibold text-[12px] leading-none tracking-[.02em] text-ink-3',
        className,
      )}
      {...props}
    />
  );
}

export function Description({ className, ...props }: TextProps) {
  return (
    <Text
      slot="description"
      data-slot="description"
      className={cn('text-small text-ink-3', className)}
      {...props}
    />
  );
}

export function FieldError({ className, ...props }: FieldErrorProps) {
  return (
    <FieldErrorPrimitive
      data-slot="field-error"
      className={cn('text-small font-medium text-danger', className as string)}
      {...props}
    />
  );
}

export type FieldChrome = {
  label?: ReactNode;
  description?: ReactNode;
  errorMessage?: string;
};
