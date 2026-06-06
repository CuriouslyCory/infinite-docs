/**
 * Brutalist section marker (e.g. `// SECTION: HERO  001`). The zero-pad-to-3 on the
 * index keeps the numeric column aligned across stacked sections. Reused by #135/#136.
 */
export function SectionLabel({
  name,
  index,
  className,
}: {
  name: string;
  index: number;
  className?: string;
}) {
  const num = String(index).padStart(3, "0");
  return (
    <div
      className={`text-muted-foreground font-mono text-xs tracking-widest uppercase ${className ?? ""}`}
    >
      {`// SECTION: ${name.toUpperCase()}  ${num}`}
    </div>
  );
}
