import wordmark from "../../../../assets/baskule/wordmark.svg";
import inverse from "../../../../assets/baskule/wordmark-inverse.svg";
import { cn } from "../lib/utils";
import type { SVGProps } from "react";

export function BaskuleWordmark({ className }: { readonly className?: string | undefined }) {
  return (
    <span className={cn("inline-flex h-6 shrink-0", className)}>
      <img src={wordmark} alt="Baskule" className="h-full w-auto dark:hidden" />
      <img src={inverse} alt="Baskule" className="hidden h-full w-auto dark:block" />
    </span>
  );
}

// The same K geometry as the wordmark; currentColor keeps it legible in tool rows.
export function BaskuleMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 100 100" fill="none" {...props}>
      <g transform="translate(11.065 0)">
        <path fill="currentColor" d="M23.87 0H0V64.51L23.87 26Z" />
        <path fill="currentColor" d="M0 100H23.87V58.22L0 80.9Z" />
        <path fill="var(--baskule-red)" d="M0 74L45.87 0H77.87Z" />
        <path fill="var(--baskule-red)" d="M41.55 41.41L28.87 53.47V72.57L45.87 100H77.87Z" />
      </g>
    </svg>
  );
}
