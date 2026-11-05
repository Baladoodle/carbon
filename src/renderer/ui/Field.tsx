import { useId, type ReactElement, type ReactNode } from 'react';
import { cloneElement } from 'react';

export interface FieldProps {
  /** Only when the control's meaning isn't obvious from its content or position (VISUAL.md §1). */
  label?: ReactNode;
  /** Shown under the control, in --danger; also sets the control's error state. */
  error?: string | null | undefined;
  /** A single control (Input, Textarea, Select, Combobox). */
  children: ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>;
  className?: string;
}

/** A control with an optional label and its error message underneath. */
export function Field({ label, error, children, className }: FieldProps): ReactNode {
  const id = useId();
  const errId = `${id}-err`;
  const control = cloneElement(children, {
    id: children.props.id ?? id,
    ...(error ? { 'aria-invalid': true, 'aria-describedby': errId } : {}),
  });
  return (
    // The field grows into the large editor as a whole: its label and error come along.
    <div className={className ? `ui-field ${className}` : 'ui-field'} data-expand-host="">
      {label !== undefined && (
        <label className="ui-field-label" htmlFor={children.props.id ?? id}>
          {label}
        </label>
      )}
      {control}
      {error && (
        <div id={errId} className="ui-field-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
