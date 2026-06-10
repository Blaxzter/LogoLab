import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  icon?: ReactNode
  block?: boolean
  /** Toggle/selected state — applies an accent "pressed" look and aria-pressed. */
  active?: boolean
}

const variantClass: Record<Variant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
}

export function Button({
  variant = 'secondary',
  icon,
  block,
  active,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`btn ${variantClass[variant]} ${active ? 'is-active' : ''} ${block ? 'w-full' : ''} ${className}`}
      aria-pressed={active}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}
