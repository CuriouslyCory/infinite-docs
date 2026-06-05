"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  className = "inline-flex items-center gap-2 rounded-lg bg-muted px-4 py-2 text-sm font-semibold transition hover:bg-muted",
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("Copied to clipboard.");
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => {
        setCopied(false);
        resetTimer.current = null;
      }, 2000);
    } catch {
      toast.error(
        "Couldn’t copy automatically — select the text and copy it manually.",
      );
    }
  }

  return (
    <button type="button" onClick={handleCopy} className={className}>
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {copied ? copiedLabel : label}
    </button>
  );
}
