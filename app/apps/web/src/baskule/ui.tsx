// baskule: small building blocks shared by the Baskule views, composed from T3's UI kit.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { requestConfirmDialog } from "../confirmDialog";
import { toastManager } from "../components/ui/toast";

import { Input, type InputProps } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { cn } from "../lib/utils";
import { BaskuleWordmark as BaskuleBrandWordmark } from "../components/BaskuleBrand";

export function FormField({
  label,
  hint,
  error,
  className,
  ...inputProps
}: Omit<InputProps, "id"> & {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | null;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        nativeInput
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...inputProps}
      />
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** The product name, as on the sidebar brand. */
export function BaskuleWordmark({ className = "" }: { readonly className?: string }) {
  return <BaskuleBrandWordmark className={className} />;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

export function Avatar({
  name,
  className,
}: {
  readonly name: string;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground/8 text-2xs font-medium text-foreground/80",
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}

export function formatRelativeDate(iso: string | null, now = Date.now()): string {
  if (!iso) return "Never";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "Unknown";
  const minutes = Math.round((now - time) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(time).toLocaleDateString();
}

export function formatBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** A random temporary password that is easy to read aloud (no ambiguous characters). */
export function generateTemporaryPassword(length = 14): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

/**
 * A promise-backed resource with reload; keeps the last data while reloading. `load` must keep
 * its identity (a module-level function), or it reloads on every render.
 */
export function useApiResource<T>(load: () => Promise<T>, options?: { readonly pollMs?: number }) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{
    readonly data: T | null;
    readonly error: string | null;
    readonly loading: boolean;
    /** Which reload produced `data`. */
    readonly loadedVersion?: number;
  }>({ data: null, error: null, loading: true });
  const waiters = useRef<Array<() => void>>([]);

  useEffect(() => {
    let cancelled = false;
    const settle = () => {
      const pending = waiters.current;
      waiters.current = [];
      for (const resolve of pending) resolve();
    };
    load().then(
      (data) => {
        if (cancelled) return;
        setState({ data, error: null, loading: false, loadedVersion: version });
        settle();
      },
      (cause: unknown) => {
        if (cancelled) return;
        setState((previous) => ({
          data: previous.data,
          error: cause instanceof Error ? cause.message : "Something went wrong.",
          loading: false,
        }));
        settle();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load, version]);

  const pollMs = options?.pollMs;
  useEffect(() => {
    if (!pollMs) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setVersion((value) => value + 1);
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [pollMs]);

  const reload = () =>
    new Promise<void>((resolve) => {
      waiters.current.push(resolve);
      setState((previous) => ({ ...previous, loading: true }));
      setVersion((value) => value + 1);
    });

  return { ...state, reload };
}

/** The app's themed confirmation dialog, falling back to the browser's. */
export async function confirmAction(
  message: string,
  variant: "default" | "destructive" = "default",
): Promise<boolean> {
  return (await requestConfirmDialog(message, { variant })) ?? window.confirm(message);
}

export function errorText(cause: unknown, fallback = "Something went wrong."): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export function notifyError(title: string, cause: unknown) {
  toastManager.add({ type: "error", title, description: errorText(cause) });
}

export function notifySuccess(title: string, description?: string) {
  toastManager.add({ type: "success", title, ...(description ? { description } : {}) });
}

/** A round icon in the avatar slot, so rows without a person still share the text column. */
export function RowIcon({ children }: { readonly children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground/8 text-foreground/70 [&_svg]:size-3.5"
    >
      {children}
    </span>
  );
}
