"use client";

import { AlertTriangle, FilePlus2, Pencil, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import {
  Dialog,
  DialogDescription,
  DialogPanel,
  DialogTitle,
} from "~/components/ui/dialog";
import { KIND_ICON, KIND_LABEL } from "~/lib/node-kinds";
import type { RouterOutputs } from "~/trpc/react";

type SpecPreview = RouterOutputs["architecture"]["previewSpec"];

type ChangedAction = "skip" | "overwrite";
type DroppedAction = "keep" | "delete";

interface ChangedDecision {
  action: ChangedAction;
  wipeDocumentation: boolean;
}

export interface SpecApplyDecisions {
  changed: {
    specKey: string;
    action: ChangedAction;
    wipeDocumentation: boolean;
  }[];
  dropped: { nodeId: string; action: DroppedAction }[];
}

interface SpecConflictModalProps {
  open: boolean;
  preview: SpecPreview;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (decisions: SpecApplyDecisions) => void;
}

/**
 * The user-resolved merge surface a re-paste opens (#64 / ADR-0029). It walks
 * the previewed diff three sections at a time: NEW (always created — shown for
 * confirmation), CHANGED (skip / overwrite per row, with a "skip all" /
 * "overwrite all" bulk control and a per-row keep|wipe-docs toggle), and
 * DROPPED (keep [detach, the default] / delete per row, with bulk controls).
 *
 * Position and incident Connections are NEVER in this prompt — they are always
 * preserved (ADR-0029). The only keep/wipe axis is documentation, because docs
 * are user-owned after first create. Dropped rows whose subtree has incident
 * Connections are flagged prominently before apply so the loss is explicit.
 * Cancel commits zero writes; the parent handles invalidation on confirm.
 */
export function SpecConflictModal({
  open,
  preview,
  pending,
  onCancel,
  onConfirm,
}: SpecConflictModalProps) {
  const [changedDecisions, setChangedDecisions] = useState<
    Record<string, ChangedDecision>
  >(() => seedChanged(preview));
  const [droppedDecisions, setDroppedDecisions] = useState<
    Record<string, DroppedAction>
  >(() => seedDropped(preview));

  const droppedDeleteWithConnections = useMemo(
    () =>
      preview.dropped.filter(
        (d) =>
          d.hasIncidentConnections &&
          (droppedDecisions[d.nodeId] ?? "keep") === "delete",
      ).length,
    [preview.dropped, droppedDecisions],
  );

  const handleConfirm = () => {
    onConfirm({
      changed: preview.changed.map((c) => {
        const d = changedDecisions[c.specKey] ?? {
          action: "skip",
          wipeDocumentation: false,
        };
        return {
          specKey: c.specKey,
          action: d.action,
          wipeDocumentation: d.wipeDocumentation,
        };
      }),
      dropped: preview.dropped.map((d) => ({
        nodeId: d.nodeId,
        action: droppedDecisions[d.nodeId] ?? "keep",
      })),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <DialogPanel>
        <header className="flex flex-col gap-1 border-b border-border px-5 py-4">
          <DialogTitle>Re-attach spec</DialogTitle>
          <DialogDescription>
            Re-parsing produced changes from the previous attach. Decide what to
            do with each component; positions and connections are always
            preserved.
          </DialogDescription>
        </header>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
          {preview.new.length > 0 && <NewSection rows={preview.new} />}

          {preview.changed.length > 0 && (
            <ChangedSection
              rows={preview.changed}
              decisions={changedDecisions}
              setDecisions={setChangedDecisions}
            />
          )}

          {preview.dropped.length > 0 && (
            <DroppedSection
              rows={preview.dropped}
              decisions={droppedDecisions}
              setDecisions={setDroppedDecisions}
            />
          )}

          {(preview.connectionsToCreate > 0 ||
            preview.connectionsToRemove > 0) && (
            <p className="text-xs text-muted-foreground">
              Foreign keys:{" "}
              {preview.connectionsToCreate > 0 &&
                `${preview.connectionsToCreate} connection${
                  preview.connectionsToCreate === 1 ? "" : "s"
                } will be drawn`}
              {preview.connectionsToCreate > 0 &&
                preview.connectionsToRemove > 0 &&
                ", "}
              {preview.connectionsToRemove > 0 &&
                `${preview.connectionsToRemove} connection${
                  preview.connectionsToRemove === 1 ? "" : "s"
                } will be removed`}
              . Connections are reconciled automatically.
            </p>
          )}

          {preview.new.length === 0 &&
            preview.changed.length === 0 &&
            preview.dropped.length === 0 &&
            preview.connectionsToCreate === 0 &&
            preview.connectionsToRemove === 0 && (
              <p className="text-sm text-muted-foreground">
                Spec parses cleanly with no changes. Confirming will refresh the
                stored source without altering any components.
              </p>
            )}

          {droppedDeleteWithConnections > 0 && (
            <div className="flex items-start gap-2 rounded border border-edit/30 bg-edit/10 px-3 py-2 text-xs text-edit">
              <AlertTriangle
                size={14}
                aria-hidden
                className="mt-0.5 shrink-0"
              />
              <span>
                Deleting {droppedDeleteWithConnections} component
                {droppedDeleteWithConnections === 1 ? "" : "s"} will also remove
                their incident Connections. Switch to “Keep (detach)” to retain
                the component and its connections.
              </span>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-foreground/5 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={pending}
            className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-primary disabled:opacity-50"
          >
            {pending ? "Applying…" : "Apply changes"}
          </button>
        </footer>
      </DialogPanel>
    </Dialog>
  );
}

function seedChanged(preview: SpecPreview): Record<string, ChangedDecision> {
  const seed: Record<string, ChangedDecision> = {};
  for (const c of preview.changed) {
    seed[c.specKey] = { action: "skip", wipeDocumentation: false };
  }
  return seed;
}

function seedDropped(preview: SpecPreview): Record<string, DroppedAction> {
  const seed: Record<string, DroppedAction> = {};
  for (const d of preview.dropped) seed[d.nodeId] = "keep";
  return seed;
}

function SectionHeader({
  title,
  count,
  bulkControls,
}: {
  title: string;
  count: number;
  bulkControls?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title} · {count}
      </h3>
      {bulkControls && (
        <div className="flex items-center gap-1 text-xs">{bulkControls}</div>
      )}
    </div>
  );
}

function NewSection({ rows }: { rows: SpecPreview["new"] }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeader title="New" count={rows.length} />
      <ul className="flex flex-col gap-1">
        {rows.map((row) => {
          const Icon = KIND_ICON[row.kind];
          return (
            <li
              key={row.specKey}
              className="flex items-center gap-2 rounded bg-muted px-2 py-1.5 text-sm"
            >
              <FilePlus2
                size={14}
                aria-hidden
                className="shrink-0 text-secondary"
              />
              <Icon
                size={14}
                aria-hidden
                className="shrink-0 text-primary"
              />
              <span className="truncate">{row.title}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground/70">
                {KIND_LABEL[row.kind]}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ChangedSection({
  rows,
  decisions,
  setDecisions,
}: {
  rows: SpecPreview["changed"];
  decisions: Record<string, ChangedDecision>;
  setDecisions: React.Dispatch<
    React.SetStateAction<Record<string, ChangedDecision>>
  >;
}) {
  const setAll = (action: ChangedAction) =>
    setDecisions((prev) => {
      const next: Record<string, ChangedDecision> = { ...prev };
      for (const row of rows) {
        next[row.specKey] = {
          action,
          wipeDocumentation: prev[row.specKey]?.wipeDocumentation ?? false,
        };
      }
      return next;
    });
  return (
    <section className="flex flex-col gap-2">
      <SectionHeader
        title="Changed"
        count={rows.length}
        bulkControls={
          <>
            <BulkButton onClick={() => setAll("skip")}>Skip all</BulkButton>
            <BulkButton onClick={() => setAll("overwrite")}>
              Overwrite all
            </BulkButton>
          </>
        }
      />
      <ul className="flex flex-col gap-1">
        {rows.map((row) => {
          const decision = decisions[row.specKey] ?? {
            action: "skip" as const,
            wipeDocumentation: false,
          };
          return (
            <li
              key={row.specKey}
              className="flex flex-col gap-1 rounded bg-muted px-2 py-1.5 text-sm"
            >
              <div className="flex items-center gap-2">
                <Pencil
                  size={14}
                  aria-hidden
                  className="shrink-0 text-portal"
                />
                <span className="truncate">{row.title}</span>
                {row.changedFields.includes("title") && (
                  <span className="shrink-0 text-xs text-muted-foreground/70">
                    was “{row.previousTitle}”
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <SegmentedButton
                    active={decision.action === "skip"}
                    onClick={() =>
                      setDecisions((prev) => ({
                        ...prev,
                        [row.specKey]: {
                          ...decision,
                          action: "skip",
                        },
                      }))
                    }
                  >
                    Skip
                  </SegmentedButton>
                  <SegmentedButton
                    active={decision.action === "overwrite"}
                    onClick={() =>
                      setDecisions((prev) => ({
                        ...prev,
                        [row.specKey]: {
                          ...decision,
                          action: "overwrite",
                        },
                      }))
                    }
                  >
                    Overwrite
                  </SegmentedButton>
                </div>
              </div>
              <ChangedDelta row={row} />
              {decision.action === "overwrite" && (
                <label className="flex items-center gap-2 pl-6 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={decision.wipeDocumentation}
                    onChange={(event) =>
                      setDecisions((prev) => ({
                        ...prev,
                        [row.specKey]: {
                          ...decision,
                          wipeDocumentation: event.target.checked,
                        },
                      }))
                    }
                  />
                  Wipe documentation (keep by default — docs are user-owned)
                </label>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// The non-title deltas for a changed row. Without this, a kind- or metadata-only
// change shows an unchanged title and no visible reason it is "changed", leaving
// the user to choose overwrite vs. skip blind (#64).
function ChangedDelta({ row }: { row: SpecPreview["changed"][number] }) {
  const kindChanged = row.changedFields.includes("kind");
  const metadataChanged = row.changedFields.includes("metadata");
  if (!kindChanged && !metadataChanged) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-xs text-muted-foreground/70">
      {kindChanged && (
        <span>
          kind {KIND_LABEL[row.previousKind]} → {KIND_LABEL[row.kind]}
        </span>
      )}
      {metadataChanged && <span>metadata changed</span>}
    </div>
  );
}

function DroppedSection({
  rows,
  decisions,
  setDecisions,
}: {
  rows: SpecPreview["dropped"];
  decisions: Record<string, DroppedAction>;
  setDecisions: React.Dispatch<
    React.SetStateAction<Record<string, DroppedAction>>
  >;
}) {
  const setAll = (action: DroppedAction) =>
    setDecisions((prev) => {
      const next: Record<string, DroppedAction> = { ...prev };
      for (const row of rows) next[row.nodeId] = action;
      return next;
    });
  return (
    <section className="flex flex-col gap-2">
      <SectionHeader
        title="Dropped"
        count={rows.length}
        bulkControls={
          <>
            <BulkButton onClick={() => setAll("keep")}>Keep all</BulkButton>
            <BulkButton onClick={() => setAll("delete")}>Delete all</BulkButton>
          </>
        }
      />
      <ul className="flex flex-col gap-1">
        {rows.map((row) => {
          const action = decisions[row.nodeId] ?? "keep";
          return (
            <li
              key={row.nodeId}
              className="flex items-center gap-2 rounded bg-muted px-2 py-1.5 text-sm"
            >
              <Trash2
                size={14}
                aria-hidden
                className={`shrink-0 ${
                  action === "delete" ? "text-destructive" : "text-muted-foreground/70"
                }`}
              />
              <span className="truncate">{row.title}</span>
              {row.hasIncidentConnections && (
                <span
                  title="This component has incident Connections that would be removed if deleted."
                  className="flex shrink-0 items-center gap-1 rounded bg-edit/10 px-1.5 py-0.5 text-[10px] tracking-wide text-edit uppercase"
                >
                  <AlertTriangle size={10} aria-hidden /> has connections
                </span>
              )}
              <div className="ml-auto flex items-center gap-1">
                <SegmentedButton
                  active={action === "keep"}
                  onClick={() =>
                    setDecisions((prev) => ({
                      ...prev,
                      [row.nodeId]: "keep",
                    }))
                  }
                >
                  Keep (detach)
                </SegmentedButton>
                <SegmentedButton
                  active={action === "delete"}
                  onClick={() =>
                    setDecisions((prev) => ({
                      ...prev,
                      [row.nodeId]: "delete",
                    }))
                  }
                >
                  Delete
                </SegmentedButton>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function BulkButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded px-2 py-0.5 text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"
    >
      {children}
    </button>
  );
}

function SegmentedButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-xs transition ${
        active
          ? "bg-primary text-foreground"
          : "bg-muted text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
