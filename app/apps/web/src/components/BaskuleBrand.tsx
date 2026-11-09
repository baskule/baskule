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

export function BaskuleMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 100 100" fill="none" {...props}>
      <path
        fill="var(--brand-muted)"
        d="M69.05949 51.43248L85.36247 75.60265L72.72816 84.12460L68.80120 52.14213ZM14.63753 24.39735L27.27184 15.87540L31.19880 47.85787L30.94051 48.56752Z"
      />
      <path
        fill="currentColor"
        d="M66.23976 59.17962L69.88484 88.86635L54.75869 90.72361ZM30.11516 11.13365L45.24131 9.27639L33.76024 40.82038Z"
      />
      <path
        fill="var(--brand-accent)"
        d="M49.92744 6.34230L78.11822 16.60290L50.07256 93.65770L21.88178 83.39710Z"
      />
    </svg>
  );
}
