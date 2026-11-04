import { Select as S } from 'radix-ui';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { IconCheck, IconChevronDown } from './icons';

export interface SelectOption {
  value: string;
  label: ReactNode;
}

export interface SelectProps {
  value: string | undefined;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  /** Only when it adds something beyond the field's label (VISUAL.md §1). */
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

/** A single choice from a short list (e.g. an item's subkind). For entities, use Combobox. */
export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  invalid,
  disabled,
  id,
  className,
  ...aria
}: SelectProps): ReactNode {
  return (
    <S.Root
      {...(value !== undefined ? { value } : {})}
      onValueChange={onValueChange}
      {...(disabled ? { disabled } : {})}
    >
      <S.Trigger
        id={id}
        className={cx('ui-input', 'ui-select', className)}
        aria-invalid={invalid || aria['aria-invalid'] || undefined}
        {...aria}
      >
        <S.Value {...(placeholder ? { placeholder } : {})} />
        <S.Icon className="ui-select-icon">
          <IconChevronDown />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content className="ui-overlay ui-menu" position="popper" sideOffset={4}>
          <S.Viewport>
            {options.map((o) => (
              <S.Item key={o.value} value={o.value} className="ui-menu-item">
                <S.ItemText>{o.label}</S.ItemText>
                <S.ItemIndicator className="ui-menu-check">
                  <IconCheck />
                </S.ItemIndicator>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
