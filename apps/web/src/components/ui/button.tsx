/**
 * Button (shadcn aria base, restyled to the screens kit's .btn). Built on React Aria's Button, so
 * it takes `onPress`, `isDisabled` and `isPending`, not `onClick`/`disabled`.
 */
import type { Ref } from 'react';
import {
  Button as ButtonPrimitive,
  type ButtonProps as ButtonPrimitiveProps,
  composeRenderProps,
} from 'react-aria-components';
import { cn } from '@/lib/utils';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'default' | 'small' | 'icon';

const base =
  'inline-flex items-center justify-center gap-2 rounded-[7px] border border-transparent font-sans font-semibold text-center cursor-pointer select-none transition-colors outline-none data-focus-visible:outline-2 data-focus-visible:outline-offset-2 data-focus-visible:outline-info data-disabled:cursor-not-allowed data-disabled:opacity-50 data-pending:cursor-wait';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-amber text-amber-ink data-hovered:brightness-95 data-pressed:brightness-90',
  secondary: 'bg-transparent text-ink border-line data-hovered:bg-sunken data-pressed:bg-sunken',
  ghost: 'bg-transparent text-ink-2 data-hovered:bg-sunken data-hovered:text-ink',
  danger: 'bg-danger text-surface data-hovered:brightness-95 data-pressed:brightness-90',
};

const sizes: Record<ButtonSize, string> = {
  default: 'min-h-10 px-3.5 py-2.5 text-[13.5px] leading-tight',
  small: 'min-h-8 px-2.5 py-1.5 text-[12.5px] leading-tight',
  icon: 'size-11 rounded-[10px] p-0 [&_svg]:size-[22px]',
};

export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'default') {
  return cn(base, variants[variant], sizes[size]);
}

export type ButtonProps = ButtonPrimitiveProps & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** React 19 passes `ref` as a prop; it reaches the <button>. */
  ref?: Ref<HTMLButtonElement>;
};

export function Button({
  variant = 'primary',
  size = 'default',
  className,
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      className={composeRenderProps(className, (cls) => cn(buttonClass(variant, size), cls))}
      {...props}
    />
  );
}
