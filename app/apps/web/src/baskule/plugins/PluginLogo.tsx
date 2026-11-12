import { faviconUrlForOrigin } from "@t3tools/shared/favicon";
import { useState } from "react";

import { cn } from "../../lib/utils";

/** The plugin's logo, else its site's icon, else its initial, on a light plate. */
export function PluginLogo({
  name,
  logo,
  site,
  size = "md",
}: {
  readonly name: string;
  readonly logo: string | null;
  readonly site?: string | null;
  readonly size?: "md" | "lg";
}) {
  const [failed, setFailed] = useState<ReadonlyArray<string>>([]);
  const src = [logo, faviconUrlForOrigin(site, 64)].find(
    (candidate): candidate is string => Boolean(candidate) && !failed.includes(candidate ?? ""),
  );
  const box =
    size === "lg" ? "size-14 rounded-2xl p-2 text-xl" : "size-10 rounded-xl p-1.5 text-base";
  return src ? (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed((previous) => [...previous, src])}
      className={cn(box, "shrink-0 border border-border/60 bg-white object-contain")}
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        box,
        "grid shrink-0 place-items-center border border-border/60 bg-muted font-semibold text-foreground",
      )}
    >
      {name.trim()[0]?.toUpperCase() ?? "?"}
    </span>
  );
}
