/**
 * PasswordField: a TextField whose input can be revealed. The reveal button is a real button in
 * the tab order, labelled "Show password" / "Hide password", and sits at the inline end, so it
 * moves to the left in Arabic.
 */
import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import {
  Button as ButtonPrimitive,
  Group,
  Input,
  TextField as TextFieldPrimitive,
  type TextFieldProps as TextFieldPrimitiveProps,
} from 'react-aria-components';
import { EyeIcon, EyeOffIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { Description, type FieldChrome, FieldError, inputClass, Label } from './field';

export type PasswordFieldProps = Omit<TextFieldPrimitiveProps, 'children' | 'type'> &
  FieldChrome & {
    /** `current-password` on sign-in, `new-password` when setting one. */
    autoComplete?: 'current-password' | 'new-password';
  };

export function PasswordField({
  label,
  description,
  errorMessage,
  autoComplete = 'current-password',
  className,
  ...props
}: PasswordFieldProps) {
  const { t } = useLingui();
  const [visible, setVisible] = useState(false);
  return (
    <TextFieldPrimitive
      data-slot="password-field"
      type={visible ? 'text' : 'password'}
      autoComplete={autoComplete}
      className={cn('grid gap-1', className as string)}
      {...props}
    >
      {label ? <Label>{label}</Label> : null}
      <Group className="relative flex">
        <Input spellCheck={false} autoCapitalize="none" className={cn(inputClass, 'pe-12')} />
        <ButtonPrimitive
          data-slot="password-toggle"
          aria-label={visible ? t`Hide password` : t`Show password`}
          aria-pressed={visible}
          onPress={() => setVisible((v) => !v)}
          className="absolute inset-y-0 end-0 grid w-11 cursor-pointer place-items-center rounded-e-lg text-ink-2 outline-none data-focus-visible:outline-2 data-focus-visible:outline-info data-hovered:text-ink"
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </ButtonPrimitive>
      </Group>
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
    </TextFieldPrimitive>
  );
}
