"use client";

/**
 * Form building blocks shared by the campaign editor and the offer editor:
 * a titled section, a radio row, an on/off switch and a text input with a
 * live length counter.
 */

import { useId } from "react";
import { BUTTON_LABEL_MAX } from "@/lib/validation/text";

export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </div>
  );
}

export function Radio({
  checked,
  onSelect,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
        checked ? "border-accent bg-accent/5" : "border-border hover:border-border-hover"
      }`}
    >
      <span
        className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
          checked ? "border-accent" : "border-zinc-500"
        }`}
      >
        {checked && <span className="h-2 w-2 rounded-full bg-accent" />}
      </span>
      <span className="flex-1 text-foreground">{children}</span>
    </button>
  );
}

/**
 * An on/off switch. `label` names it for screen readers (the visible text
 * next to it is a separate element), so pass the same translated text.
 */
export function Toggle({
  on,
  onToggle,
  label,
  disabled = false,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      disabled={disabled}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-accent" : "bg-zinc-300"
      }`}
    >
      <span
        className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${
          on ? "left-6" : "left-1"
        }`}
      />
    </button>
  );
}

// Instagram cuts button titles after 20 UTF-16 units, card titles after 80,
// so an emoji takes two. maxLength and String.length count the same units,
// and so does the API. A value saved before a limit dropped can be longer:
// the counter turns red, since the API now refuses it.
export function CountedInput({
  value,
  onChange,
  placeholder,
  max = BUTTON_LABEL_MAX,
  id,
  invalid = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  max?: number;
  id?: string;
  invalid?: boolean;
}) {
  const counterId = useId();
  return (
    <div className="relative">
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={max}
        aria-describedby={counterId}
        aria-invalid={invalid || undefined}
        className={`w-full rounded-lg border bg-surface py-2 pl-3 pr-14 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none ${
          invalid ? "border-error/60" : "border-border"
        }`}
      />
      <span
        id={counterId}
        className={`pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs tabular-nums ${
          value.length > max ? "text-error" : "text-muted"
        }`}
      >
        {value.length}/{max}
      </span>
    </div>
  );
}
