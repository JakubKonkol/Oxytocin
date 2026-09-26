import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '../lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-fg-inverse hover:brightness-110 border-transparent',
  secondary: 'bg-elevated text-fg border-line hover:bg-card-hover',
  ghost: 'bg-transparent text-fg-secondary border-transparent hover:bg-card-hover hover:text-fg',
  danger: 'bg-danger text-fg border-transparent hover:brightness-110',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-control border font-medium transition-colors',
        'disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' ? 'h-6 px-2 text-small' : 'h-8 px-3 text-ui',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  );
});
