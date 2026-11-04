import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cx } from './cx';

interface SuggestionProps {
  /**
   * An AI suggestion shown inline after the typed text, in --ai at 70% (VISUAL.md §5).
   * Accepting it (tab) is the caller's job: set the value and clear the suggestion.
   */
  suggestion?: string | null | undefined;
  /** Error state (the border); use Field to show the message. */
  invalid?: boolean;
  /** Numbers, ids and formulas use the mono face with tabular numerals. */
  mono?: boolean;
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & SuggestionProps;

/** Completion text to show: the part of the suggestion after what's typed, or the whole suggestion after a space. */
export function ghostText(value: string, suggestion: string | null | undefined): string {
  if (!suggestion) return '';
  if (value === '') return suggestion;
  if (suggestion.toLowerCase().startsWith(value.toLowerCase()))
    return suggestion.slice(value.length);
  return ` → ${suggestion}`;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { suggestion, invalid, mono, className, value, placeholder, ...rest },
  ref,
) {
  const text = typeof value === 'string' ? value : value === undefined ? '' : String(value);
  const ghost = ghostText(text, suggestion);
  const input = (
    <input
      ref={ref}
      value={value}
      placeholder={ghost ? undefined : placeholder}
      aria-invalid={invalid || rest['aria-invalid'] || undefined}
      className={cx('ui-input', mono && 'mono', !ghost && className)}
      {...rest}
    />
  );
  if (!ghost) return input;
  return (
    <div className={cx('ui-suggest', mono && 'mono', className)} data-suggesting="">
      {input}
      <div className="ui-suggest-mirror" aria-hidden="true">
        <span className="ui-suggest-typed">{text}</span>
        <span className="ui-suggest-ghost">{ghost}</span>
      </div>
    </div>
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & SuggestionProps;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { suggestion, invalid, mono, className, value, placeholder, ...rest },
  ref,
) {
  const text = typeof value === 'string' ? value : '';
  const ghost = ghostText(text, suggestion);
  const area = (
    <textarea
      ref={ref}
      value={value}
      placeholder={ghost ? undefined : placeholder}
      aria-invalid={invalid || rest['aria-invalid'] || undefined}
      className={cx('ui-input', 'ui-textarea', mono && 'mono', !ghost && className)}
      {...rest}
    />
  );
  if (!ghost) return area;
  return (
    <div
      className={cx('ui-suggest', 'ui-suggest-area', mono && 'mono', className)}
      data-suggesting=""
    >
      {area}
      <div className="ui-suggest-mirror" aria-hidden="true">
        <span className="ui-suggest-typed">{text}</span>
        <span className="ui-suggest-ghost">{ghost}</span>
      </div>
    </div>
  );
});
