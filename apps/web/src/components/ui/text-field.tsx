/**
 * TextField: label, input, optional description and error, wired by React Aria (label/for,
 * aria-describedby, aria-invalid). Controlled with `value` + `onChange(value)`.
 */
import {
  Input,
  type InputProps,
  TextField as TextFieldPrimitive,
  type TextFieldProps as TextFieldPrimitiveProps,
} from 'react-aria-components';
import { cn } from '@/lib/utils';
import { Description, type FieldChrome, FieldError, inputClass, Label } from './field';

export type TextFieldProps = Omit<TextFieldPrimitiveProps, 'children'> &
  FieldChrome & {
    placeholder?: string;
    inputProps?: Omit<InputProps, 'className'>;
  };

export function TextField({
  label,
  description,
  errorMessage,
  placeholder,
  inputProps,
  className,
  ...props
}: TextFieldProps) {
  return (
    <TextFieldPrimitive
      data-slot="text-field"
      className={cn('grid gap-1', className as string)}
      {...props}
    >
      {label ? <Label>{label}</Label> : null}
      <Input className={inputClass} placeholder={placeholder} {...inputProps} />
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
    </TextFieldPrimitive>
  );
}
