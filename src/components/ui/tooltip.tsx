"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { type ComponentProps } from "react";

/**
 * A thin Tailwind-styled wrapper over Base UI's headless `Tooltip` — the same
 * vendor-a-minimal-subset approach as `popover.tsx` / `dialog.tsx`. Two facts
 * are load-bearing and easy to break: the panel is `pointer-events: none` so a
 * tooltip floating over the Canvas can never intercept a pan/zoom drag meant for
 * React Flow (the popover is non-modal for the same reason); and this module
 * imports only Base UI + React, because it renders inside the Canvas island and
 * pulling in a module that reaches the server graph would leak it (ADR-0004).
 * `TooltipProvider` is optional (it only groups a shared open-delay across
 * adjacent tooltips); `delay` otherwise lives on the trigger, never on the root.
 */

// Base UI surface components accept `className` as a string OR a state-aware
// function; we compose with template strings, so narrow to `string` at the
// wrapper boundary (mirrors `popover.tsx`).
type StringClassName<P> = Omit<P, "className"> & { className?: string };

export function TooltipProvider(
  props: ComponentProps<typeof TooltipPrimitive.Provider>,
) {
  return <TooltipPrimitive.Provider {...props} />;
}

export function Tooltip(props: ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root {...props} />;
}

export function TooltipTrigger(
  props: ComponentProps<typeof TooltipPrimitive.Trigger>,
) {
  return <TooltipPrimitive.Trigger {...props} />;
}

export function TooltipPanel({
  className = "",
  children,
  side = "top",
  align = "center",
  sideOffset = 6,
  ...props
}: StringClassName<ComponentProps<typeof TooltipPrimitive.Popup>> & {
  side?: ComponentProps<typeof TooltipPrimitive.Positioner>["side"];
  align?: ComponentProps<typeof TooltipPrimitive.Positioner>["align"];
  sideOffset?: ComponentProps<typeof TooltipPrimitive.Positioner>["sideOffset"];
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="z-50"
      >
        <TooltipPrimitive.Popup
          className={`border-border bg-popover/95 text-popover-foreground pointer-events-none max-w-[20rem] rounded-md border px-2.5 py-1.5 text-xs leading-snug shadow-2xl backdrop-blur-md transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 ${className}`}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}
