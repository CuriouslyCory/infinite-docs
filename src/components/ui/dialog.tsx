"use client";

import { Dialog as DialogPrimitive } from "@base-ui-components/react/dialog";
import { type ComponentProps } from "react";

/**
 * A thin Tailwind-styled wrapper over Base UI's headless `Dialog` — the same
 * vendor-a-minimal-subset approach as `command.tsx`. Base UI (not Radix) gives
 * us the accessibility plumbing (focus trap, `Escape`, scroll lock, ARIA) for
 * free while staying unstyled, so it composes with Tailwind v4 rather than
 * fighting a styling engine. Class names are inline template strings — the
 * repo's convention, no `cn` helper.
 *
 * `Dialog` (Root) is controlled via `open` / `onOpenChange`. `DialogPanel`
 * bundles the portal + backdrop + popup so callers render one element.
 */
export function Dialog(props: ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root {...props} />;
}

// The Base UI surface components accept `className` as either a string or a
// state-aware function. We compose with template strings, so narrow the prop to
// `string | undefined` at our wrapper boundary; callers that need the function
// form can drop down to the primitives.
type StringClassName<P> = Omit<P, "className"> & { className?: string };

export function DialogPanel({
  className = "",
  children,
  ...props
}: StringClassName<ComponentProps<typeof DialogPrimitive.Popup>>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
      <DialogPrimitive.Popup
        className={`bg-card text-card-foreground border-border fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border-2 shadow-2xl transition-all data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 ${className}`}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({
  className = "",
  ...props
}: StringClassName<ComponentProps<typeof DialogPrimitive.Title>>) {
  return (
    <DialogPrimitive.Title
      className={`text-card-foreground font-display text-base font-semibold ${className}`}
      {...props}
    />
  );
}

export function DialogDescription({
  className = "",
  ...props
}: StringClassName<ComponentProps<typeof DialogPrimitive.Description>>) {
  return (
    <DialogPrimitive.Description
      className={`text-muted-foreground text-sm ${className}`}
      {...props}
    />
  );
}

export function DialogClose(
  props: ComponentProps<typeof DialogPrimitive.Close>,
) {
  return <DialogPrimitive.Close {...props} />;
}
