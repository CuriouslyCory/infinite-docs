"use client";

import { Popover as PopoverPrimitive } from "@base-ui-components/react/popover";
import { type ComponentProps } from "react";

/**
 * A thin Tailwind-styled wrapper over Base UI's headless `Popover` — the same
 * vendor-a-minimal-subset approach as `dialog.tsx` and `command.tsx`. Base UI
 * (not Radix) gives us the portal, collision-aware positioning, focus, and
 * `Escape`/outside-press dismissal for free while staying unstyled, so it
 * composes with Tailwind v4. The portal is load-bearing: the Component-detail
 * panel is an `overflow-y-auto` container, which clips horizontal overflow, so
 * an in-flow popover gets cut off at the sidebar edge (#89) — rendering into a
 * portal with anchored, collision-aware positioning is what lets the panel
 * escape that clip and stay on-screen. Controlled via `open` / `onOpenChange`;
 * non-modal by default so the canvas stays pannable behind it. Class names are
 * inline template strings — the repo's convention, no `cn` helper.
 */

// Base UI surface components accept `className` as a string OR a state-aware
// function; we compose with template strings, so narrow to `string` at the
// wrapper boundary (mirrors `dialog.tsx`).
type StringClassName<P> = Omit<P, "className"> & { className?: string };

export function Popover(props: ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root {...props} />;
}

export function PopoverTrigger(
  props: ComponentProps<typeof PopoverPrimitive.Trigger>,
) {
  return <PopoverPrimitive.Trigger {...props} />;
}

export function PopoverPanel({
  className = "",
  children,
  side,
  align = "start",
  sideOffset = 8,
  ...props
}: StringClassName<ComponentProps<typeof PopoverPrimitive.Popup>> & {
  side?: ComponentProps<typeof PopoverPrimitive.Positioner>["side"];
  align?: ComponentProps<typeof PopoverPrimitive.Positioner>["align"];
  sideOffset?: ComponentProps<typeof PopoverPrimitive.Positioner>["sideOffset"];
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="z-50"
      >
        <PopoverPrimitive.Popup
          className={`origin-[var(--transform-origin)] transition-opacity outline-none data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 ${className}`}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}
