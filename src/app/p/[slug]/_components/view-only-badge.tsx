import { Eye } from "lucide-react";

/**
 * Read-only indicator for the project header, shown to a capability **viewer**
 * (a non-owner holding the share link). It makes the absent edit affordances
 * legible — this is presentation, NOT the authorization boundary: every
 * mutation is denied at the service layer regardless of what the client renders
 * (ADR-0002). Server-rendered so it is present before the canvas island loads.
 */
export function ViewOnlyBadge() {
  return (
    <span
      className="ml-auto flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground"
      title="You're viewing a shared project. Only the owner can make changes."
    >
      <Eye size={12} aria-hidden />
      View only
    </span>
  );
}
