"use client";

import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { type ComponentProps } from "react";

/**
 * A thin Tailwind-styled wrapper over `cmdk` — the headless command-palette
 * primitive shadcn/ui's `Command` is built on. We vendor a minimal subset (no
 * shadcn CLI, no `Dialog` wrapper) because the kind palette renders inline in a
 * popover, not as a modal: search, list, grouped items, separator, empty state.
 * Built on cmdk so search, keyboard navigation (arrows + Enter), and the active
 * item are handled for us (ADR-0020). Class names are concatenated inline rather
 * than via a `cn` helper — the repo styles with template strings, not clsx.
 */

export function Command({ className = "", ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={`flex h-full w-full flex-col overflow-hidden rounded-lg bg-[#1f2138] text-white ${className}`}
      {...props}
    />
  );
}

export function CommandInput({
  className = "",
  ...props
}: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2 border-b border-white/10 px-3">
      <Search size={14} aria-hidden className="shrink-0 text-white/40" />
      <CommandPrimitive.Input
        className={`h-9 w-full bg-transparent text-sm text-white outline-none placeholder:text-white/40 ${className}`}
        {...props}
      />
    </div>
  );
}

export function CommandList({
  className = "",
  ...props
}: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={`max-h-72 overflow-y-auto overflow-x-hidden p-1 ${className}`}
      {...props}
    />
  );
}

export function CommandEmpty(
  props: ComponentProps<typeof CommandPrimitive.Empty>,
) {
  return (
    <CommandPrimitive.Empty
      className="py-6 text-center text-sm text-white/40"
      {...props}
    />
  );
}

export function CommandGroup({
  className = "",
  ...props
}: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={`overflow-hidden p-1 text-white [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-white/40 ${className}`}
      {...props}
    />
  );
}

export function CommandSeparator({
  className = "",
  ...props
}: ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      className={`-mx-1 my-1 h-px bg-white/10 ${className}`}
      {...props}
    />
  );
}

export function CommandItem({
  className = "",
  ...props
}: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-white outline-none select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-[hsl(280,100%,70%)]/20 data-[selected=true]:text-white ${className}`}
      {...props}
    />
  );
}
