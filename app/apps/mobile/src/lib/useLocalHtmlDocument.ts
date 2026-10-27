import { useEffect, useState } from "react";

import { managedAttachmentOwner } from "./attachmentDownload";
import { localHtmlDocument } from "./localHtmlDocument";

export function useLocalHtmlDocument(uri: string | null) {
  const [loaded, setLoaded] = useState<{ uri: string; document: string | null } | null>(null);
  useEffect(() => {
    if (uri === null) return;
    const controller = new AbortController();
    const ownerSignal = managedAttachmentOwner(uri)?.signal;
    const signal = ownerSignal
      ? AbortSignal.any([controller.signal, ownerSignal])
      : controller.signal;
    const invalidate = () => setLoaded({ uri, document: null });
    ownerSignal?.addEventListener("abort", invalidate, { once: true });
    if (ownerSignal?.aborted) invalidate();
    void localHtmlDocument(uri, signal)
      .then((document) => {
        if (!signal.aborted) setLoaded({ uri, document });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ uri, document: null });
      });
    return () => {
      ownerSignal?.removeEventListener("abort", invalidate);
      controller.abort();
    };
  }, [uri]);
  return {
    document: loaded?.uri === uri ? loaded.document : null,
    failed: loaded?.uri === uri && loaded.document === null,
  };
}
