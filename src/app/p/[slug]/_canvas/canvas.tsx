"use client";

import "@xyflow/react/dist/style.css";

import {
  addEdge,
  Background,
  type Connection,
  ConnectionMode,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";

import { canConnect } from "~/lib/connection-rules";
import { type Interaction, type NodeKind, type SpecKind } from "~/lib/schemas";
import { type CanvasData, type CanvasEdge, type CanvasNode } from "~/lib/types";
import { api, type RouterOutputs } from "~/trpc/react";

import { AddComponent } from "./add-component";
import { CopyMarkdownToolbar } from "./copy-markdown";
import {
  ComponentDetailPanel,
  prefetchDocsEditor,
} from "./component-detail-panel";
import {
  SpecConflictModal,
  type SpecApplyDecisions,
} from "./spec-conflict-modal";
import {
  CanEditContext,
  ComponentNodeView,
  DeleteComponentContext,
  DescendComponentContext,
  RenameComponentContext,
  type ComponentNode,
} from "./component-node";
import {
  ConnectionEdgeView,
  EditEdgeContext,
  type ConnectionEdge,
} from "./connection-edge";

/**
 * The Canvas island — the ONLY module that statically imports `@xyflow/react`.
 * Loaded via `next/dynamic({ ssr: false })` from `./index`, so the diagramming
 * library never runs on the server and never lands in the page's first-load
 * bundle; the stylesheet is imported locally here so it ships only with this
 * lazy chunk (ADR-0004).
 *
 * Source-of-truth model (PRD perf model): the query cache is the persistence
 * mirror — seeded server-side via prefetch → HydrateClient → `useSuspenseQuery`
 * — and React Flow's internal store is the source of truth during interaction.
 * New Components and Connections render optimistically with a `temp_…` id
 * reconciled to the real id on success; failures roll back and toast. Drag-stop,
 * inline rename, drawing/labeling/removing a Connection all persist through the
 * same model — one mutation per gesture — writing the store and the cache mirror
 * together (via `patchCanvas`, which preserves sibling keys) and rolling both
 * back with a toast on failure.
 *
 * The cross-scope read shape (`boundaryProxies`, per-edge `sourceRepr` /
 * `targetRepr`) is derived by `getCanvas` as of #63 (ADR-0031); this island does
 * not yet consume those fields, so every Connection still renders as a plain line
 * between its same-Canvas endpoints. Typed arrowheads and the client rendering of
 * cross-scope Connections / boundary proxies arrive in #65.
 */

// Module-level: React Flow re-mounts every node/edge (and warns) if `nodeTypes`
// / `edgeTypes` is a fresh object each render. Defining them once is the key
// React Flow perf guard.
const nodeTypes = { component: ComponentNodeView };
const edgeTypes = { connection: ConnectionEdgeView };

function toRFNode(n: CanvasNode): ComponentNode {
  return {
    id: n.id,
    type: "component",
    position: { x: n.posX, y: n.posY },
    // Keyboard Delete is reserved for Connections; a Component is removed only
    // through its explicit (undoable) trash control, never a stray Backspace.
    deletable: false,
    data: {
      title: n.title,
      kind: n.kind,
      optimistic: n.id.startsWith("temp_"),
    },
  };
}

function toRFEdge(e: CanvasEdge): ConnectionEdge {
  return {
    id: e.id,
    type: "connection",
    source: e.sourceId,
    target: e.targetId,
    // No marker — every Connection renders as a plain line in this slice; the
    // interaction-derived arrowheads are wired in #65 (ADR-0027).
    data: {
      label: e.label,
      optimistic: e.id.startsWith("temp_"),
    },
  };
}

function optimisticCanvasNode(
  id: string,
  projectId: string,
  parentId: string | null,
  kind: NodeKind,
  position: { x: number; y: number },
): CanvasNode {
  const now = new Date();
  return {
    id,
    projectId,
    parentId,
    title: "Untitled",
    kind,
    posX: position.x,
    posY: position.y,
    documentation: "",
    metadata: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletionId: null,
    // Generated-component provenance is null for a hand-added Component (#64).
    sourceSpecId: null,
    specKey: null,
  };
}

// A freshly drawn Connection is same-Canvas — both endpoints render here, so each
// endpoint IS its own on-scope representative (`sourceRepr`/`targetRepr` === the
// endpoint ids). getCanvas derives the reprs server-side for every cross-scope
// case (ADR-0031); the optimistic + reconcile paths only ever build same-Canvas
// rows, so they set the reprs to the endpoint ids directly.
function optimisticCanvasEdge(
  id: string,
  sourceId: string,
  targetId: string,
): CanvasEdge {
  return {
    id,
    sourceId,
    targetId,
    sourceRepr: sourceId,
    targetRepr: targetId,
    // A freshly-drawn Connection is an ASSOCIATION (a plain line) until the user
    // types it (#65). The optimistic shape must match the getCanvas edge row so
    // remount reconciliation never flickers (ADR-0027).
    interaction: "ASSOCIATION",
    label: null,
  };
}

// Map the `connectNodes` result (a raw server Edge) onto the Canvas edge shape
// getCanvas returns, for the optimistic temp → real reconcile. Same-Canvas, so
// the reprs are the endpoint ids (see {@link optimisticCanvasEdge}).
function reconciledCanvasEdge(real: {
  id: string;
  sourceId: string;
  targetId: string;
  interaction: Interaction;
  label: string | null;
}): CanvasEdge {
  return {
    id: real.id,
    sourceId: real.sourceId,
    targetId: real.targetId,
    sourceRepr: real.sourceId,
    targetRepr: real.targetId,
    interaction: real.interaction,
    label: real.label,
  };
}

/**
 * Picks the toast message for a failed `updateNodeDocumentation` autosave.
 * The only Zod issue the input schema raises is the byte cap (id is a bare
 * non-empty string), so a `BAD_REQUEST` with a `zodError` payload means the
 * doc exceeded `MAX_NODE_DOCUMENTATION_BYTES` — surface that distinctly so a
 * user pasting a too-large doc sees WHY each keystroke fails, instead of a
 * generic "try again" loop.
 */
function messageForDocsSaveFailure(error: unknown): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { code?: string; zodError?: unknown } })
      .data;
    if (data?.code === "BAD_REQUEST" && data.zodError) {
      return "Doc is too long to save (cap is ~100 KB). Trim the text to keep autosaving.";
    }
  }
  return "Couldn't save documentation. Please try again.";
}

function CanvasInner({
  scope,
  slug,
  projectId,
  canEdit,
}: {
  scope: string;
  slug: string;
  projectId: string;
  canEdit: boolean;
}) {
  const utils = api.useUtils();
  const router = useRouter();
  // The root scope is the sentinel string "root" at the island boundary
  // (ADR-0004); every other scope IS a Node id — the parentId of this Canvas's
  // Components. (An Edge no longer stores a scope; ADR-0028.)
  const canvasNodeId = scope === "root" ? null : scope;
  // Stable across renders so it stays a single query key and a stable callback dep.
  const canvasInput = useMemo(
    () => ({ slug, canvasNodeId }),
    [slug, canvasNodeId],
  );
  const [{ interiorNodes, interiorEdges, breadcrumbs }] =
    api.architecture.getCanvas.useSuspenseQuery(canvasInput);

  // The kind palette ranks its suggestions by the scope's own Component kind —
  // the parent of any Component added here (CONTEXT.md "Kind affinity"). The
  // current scope is the last breadcrumb; the root scope has none, so `null`
  // keys the root affinity.
  const parentKind = breadcrumbs.at(-1)?.kind ?? null;

  // Seed React Flow's store ONCE from the hydrated query; thereafter the store
  // owns interaction state. The island is keyed by scope (./index), so a Descent
  // (a scope change) remounts and re-seeds rather than inheriting these.
  // Persistence flows through one batched/single mutation per gesture (below),
  // with the query cache kept in lockstep so a remount re-seeds it.
  const [nodes, setNodes, onNodesChange] = useNodesState<ComponentNode>(
    interiorNodes.map(toRFNode),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<ConnectionEdge>(
    interiorEdges.map(toRFEdge),
  );

  const { screenToFlowPosition } = useReactFlow();
  const createNode = api.architecture.createNode.useMutation();
  // Destructured so the stable `mutateAsync` can be a dep of the context values
  // below without dragging the whole (per-render) mutation object into them.
  const { mutateAsync: renameNode } = api.architecture.updateNode.useMutation();
  const { mutateAsync: changeNodeKind } =
    api.architecture.updateNodeKind.useMutation();
  const { mutateAsync: editDocumentation } =
    api.architecture.updateNodeDocumentation.useMutation();
  const updatePositions = api.architecture.updatePositions.useMutation();
  const connectNodes = api.architecture.connectNodes.useMutation();
  const { mutateAsync: editEdge } = api.architecture.updateEdge.useMutation();
  const { mutateAsync: removeEdge } = api.architecture.deleteEdge.useMutation();
  const { mutateAsync: deleteComponent } =
    api.architecture.deleteNode.useMutation();
  const { mutateAsync: restoreComponent } =
    api.architecture.restoreNode.useMutation();
  const previewSpec = api.architecture.previewSpec.useMutation();
  const applySpec = api.architecture.applySpec.useMutation();

  // The query cache is the re-seed mirror. EVERY write goes through this merge
  // helper so a partial update can never drop a sibling key (e.g. node edits
  // silently erasing `interiorEdges`) — the regression `getCanvas` growing a
  // second key would otherwise invite. It spreads the prior value, so callers
  // return only the slice they changed.
  const patchCanvas = useCallback(
    (patch: (prev: CanvasData) => Partial<CanvasData>) => {
      utils.architecture.getCanvas.setData(canvasInput, (old) => {
        // The zero-value defaults are load-bearing — a partial update on a cold
        // cache would otherwise patch against a base that lacks a key and drop
        // it. Keep EVERY getCanvas key here.
        const base: CanvasData = old ?? {
          interiorNodes: [],
          interiorEdges: [],
          boundaryProxies: [],
          breadcrumbs: [],
        };
        return { ...base, ...patch(base) };
      });
    },
    [utils, canvasInput],
  );

  const addComponent = useCallback(
    async (kind: NodeKind) => {
      // A client-minted temporary id, reconciled to the server id on success.
      // The `temp_` prefix is also the convention `onConnect` uses to refuse a
      // Connection to a still-optimistic endpoint.
      const tempId = `temp_${crypto.randomUUID()}`;
      const position = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });

      // Optimistic: show the Component this frame — in the RF store (pixels) and
      // the query cache (the re-seed mirror), so both stay consistent.
      setNodes((ns) => [
        ...ns,
        {
          id: tempId,
          type: "component",
          position,
          deletable: false,
          data: { title: "Untitled", kind, optimistic: true },
        },
      ]);
      patchCanvas((c) => ({
        interiorNodes: [
          ...c.interiorNodes,
          optimisticCanvasNode(tempId, projectId, canvasNodeId, kind, position),
        ],
      }));

      try {
        const real = await createNode.mutateAsync({
          projectId,
          parentId: canvasNodeId,
          kind,
          posX: position.x,
          posY: position.y,
        });
        // Reconcile temp → real id in both stores, atomically by id.
        setNodes((ns) => ns.map((n) => (n.id === tempId ? toRFNode(real) : n)));
        patchCanvas((c) => ({
          interiorNodes: c.interiorNodes.map((n) =>
            n.id === tempId ? real : n,
          ),
        }));
      } catch {
        // Roll back both stores and tell the user (PRD: "rolls back with a toast").
        setNodes((ns) => ns.filter((n) => n.id !== tempId));
        patchCanvas((c) => ({
          interiorNodes: c.interiorNodes.filter((n) => n.id !== tempId),
        }));
        toast.error("Couldn’t add the component. Please try again.");
      }
    },
    [
      screenToFlowPosition,
      projectId,
      canvasNodeId,
      setNodes,
      patchCanvas,
      createNode,
    ],
  );

  // Persist a renamed Component: optimistic title in the store + cache mirror,
  // one updateNode mutation, both rolled back with a toast on failure. Provided
  // to the nodes through context (below) so it stays one stable reference — the
  // nodes never re-render just because the island re-rendered mid-drag.
  //
  // Rollback is CONDITIONAL on the cache still showing what this rename wrote:
  // a fast-typing rename A→B can overlap a failing A→B′, and an unconditional
  // rollback to the pre-A snapshot would clobber B's successful optimistic
  // patch. Same fix lives in `commitDocumentation` for the autosave path.
  const commitRename = useCallback(
    (id: string, title: string): void => {
      const prevTitle = utils.architecture.getCanvas
        .getData(canvasInput)
        ?.interiorNodes.find((n) => n.id === id)?.title;

      setNodes((ns) =>
        ns.map((n) =>
          n.id === id && n.type === "component"
            ? { ...n, data: { ...n.data, title } }
            : n,
        ),
      );
      patchCanvas((c) => ({
        interiorNodes: c.interiorNodes.map((n) =>
          n.id === id ? { ...n, title } : n,
        ),
      }));

      void renameNode({ id, title }).catch(() => {
        const currentTitle = utils.architecture.getCanvas
          .getData(canvasInput)
          ?.interiorNodes.find((n) => n.id === id)?.title;
        // Only restore if the cache still shows what THIS rename optimistically
        // wrote — a newer rename's optimistic patch must not be undone.
        if (currentTitle === title && prevTitle !== undefined) {
          setNodes((ns) =>
            ns.map((n) =>
              n.id === id && n.type === "component"
                ? { ...n, data: { ...n.data, title: prevTitle } }
                : n,
            ),
          );
          patchCanvas((c) => ({
            interiorNodes: c.interiorNodes.map((n) =>
              n.id === id ? { ...n, title: prevTitle } : n,
            ),
          }));
        }
        toast.error("Couldn’t rename the component. Please try again.");
      });
    },
    [setNodes, utils, canvasInput, patchCanvas, renameNode],
  );

  // Change a Component's kind: optimistic icon swap in the store + cache mirror,
  // one updateNodeKind mutation, both rolled back with a toast on failure. Same
  // conditional-rollback shape as `commitRename` (a newer change's optimistic
  // patch must not be clobbered by an older failing change's rollback). Kind is
  // cosmetic, so no edge state is touched (ADR-0018).
  const commitNodeKind = useCallback(
    (id: string, kind: NodeKind): void => {
      const prevKind = utils.architecture.getCanvas
        .getData(canvasInput)
        ?.interiorNodes.find((n) => n.id === id)?.kind;

      setNodes((ns) =>
        ns.map((n) =>
          n.id === id && n.type === "component"
            ? { ...n, data: { ...n.data, kind } }
            : n,
        ),
      );
      patchCanvas((c) => ({
        interiorNodes: c.interiorNodes.map((n) =>
          n.id === id ? { ...n, kind } : n,
        ),
      }));

      void changeNodeKind({ id, kind }).catch(() => {
        const currentKind = utils.architecture.getCanvas
          .getData(canvasInput)
          ?.interiorNodes.find((n) => n.id === id)?.kind;
        if (currentKind === kind && prevKind !== undefined) {
          setNodes((ns) =>
            ns.map((n) =>
              n.id === id && n.type === "component"
                ? { ...n, data: { ...n.data, kind: prevKind } }
                : n,
            ),
          );
          patchCanvas((c) => ({
            interiorNodes: c.interiorNodes.map((n) =>
              n.id === id ? { ...n, kind: prevKind } : n,
            ),
          }));
        }
        toast.error("Couldn’t change the kind. Please try again.");
      });
    },
    [setNodes, utils, canvasInput, patchCanvas, changeNodeKind],
  );

  // Per-ownerNodeId chain of in-flight docs saves. Two debounced saves crossing
  // a network hop must land on the server in the order the user typed them —
  // an older payload landing after a newer one would persist stale text while
  // the cache shows the latest, surfacing as data loss on next page refresh.
  // The map's slot is cleared in the chain's `finally` only when this save is
  // still the head, so concurrent writers don't race on the delete.
  const inflightDocSavesRef = useRef(new Map<string, Promise<void>>());

  // Persist a Component's documentation on the debounced autosave from the
  // detail panel. Optimistic on the query-cache mirror only — `documentation`
  // is not drawn on the node body, so the React Flow store needs no patch; the
  // mirror keeps a deselect-then-reselect showing the latest text without a
  // refetch. Fire-and-forget with a CONDITIONAL snapshot rollback + toast on
  // failure: a newer successful save's optimistic patch must not be undone by
  // an older failing save's rollback (the same fix `commitRename` carries).
  // Saves are SERIALIZED per id so the server's row never lands on a stale
  // payload (see `inflightDocSavesRef`).
  const commitDocumentation = useCallback(
    (id: string, documentation: string): void => {
      const prevDoc = utils.architecture.getCanvas
        .getData(canvasInput)
        ?.interiorNodes.find((n) => n.id === id)?.documentation;

      patchCanvas((c) => ({
        interiorNodes: c.interiorNodes.map((n) =>
          n.id === id ? { ...n, documentation } : n,
        ),
      }));

      const prior = inflightDocSavesRef.current.get(id) ?? Promise.resolve();
      // `prior.catch(() => undefined)` so a prior failure doesn't poison the
      // chain — each save's failure handling is local to its own .catch below.
      const next: Promise<void> = prior
        .catch(() => undefined)
        .then(() => editDocumentation({ id, documentation }))
        .then(() => undefined)
        .catch((error: unknown) => {
          const currentDoc = utils.architecture.getCanvas
            .getData(canvasInput)
            ?.interiorNodes.find((n) => n.id === id)?.documentation;
          if (currentDoc === documentation && prevDoc !== undefined) {
            patchCanvas((c) => ({
              interiorNodes: c.interiorNodes.map((n) =>
                n.id === id ? { ...n, documentation: prevDoc } : n,
              ),
            }));
          }
          toast.error(messageForDocsSaveFailure(error));
        })
        .finally(() => {
          // Only release the slot if this save is still the chain head; a
          // newer save will have replaced it and is responsible for clearing.
          if (inflightDocSavesRef.current.get(id) === next) {
            inflightDocSavesRef.current.delete(id);
          }
        });
      inflightDocSavesRef.current.set(id, next);
    },
    [utils, canvasInput, patchCanvas, editDocumentation],
  );

  // Persist Component positions on drag-stop in ONE batched mutation, so a
  // multi-select drag (onSelectionDragStop also routes here) commits together.
  // Rolls back store + cache and toasts on failure.
  const persistPositions = useCallback(
    async (moved: ComponentNode[]) => {
      const cached = utils.architecture.getCanvas.getData(canvasInput);
      const byId = new Map(
        cached?.interiorNodes.map((n) => [n.id, n] as const) ?? [],
      );

      const changed: {
        id: string;
        prev: CanvasNode;
        posX: number;
        posY: number;
      }[] = [];
      for (const n of moved) {
        if (n.id.startsWith("temp_")) continue;
        const prev = byId.get(n.id);
        if (!prev) continue;
        if (prev.posX === n.position.x && prev.posY === n.position.y) continue;
        changed.push({
          id: n.id,
          prev,
          posX: n.position.x,
          posY: n.position.y,
        });
      }
      if (changed.length === 0) return;

      const positions = changed.map(({ id, posX, posY }) => ({
        id,
        posX,
        posY,
      }));

      // The RF store already shows the final position; mirror it into the cache.
      patchCanvas((c) => ({
        interiorNodes: c.interiorNodes.map((n) => {
          const x = changed.find((ch) => ch.id === n.id);
          return x ? { ...n, posX: x.posX, posY: x.posY } : n;
        }),
      }));

      try {
        await updatePositions.mutateAsync({ projectId, positions });
      } catch {
        setNodes((ns) =>
          ns.map((n) => {
            const x = changed.find((ch) => ch.id === n.id);
            return x
              ? { ...n, position: { x: x.prev.posX, y: x.prev.posY } }
              : n;
          }),
        );
        patchCanvas((c) => ({
          interiorNodes: c.interiorNodes.map((n) => {
            const x = changed.find((ch) => ch.id === n.id);
            return x ? { ...n, posX: x.prev.posX, posY: x.prev.posY } : n;
          }),
        }));
        toast.error("Couldn’t save the new position. Please try again.");
      }
    },
    [utils, canvasInput, projectId, updatePositions, setNodes, patchCanvas],
  );

  // Draw a Connection. Refuses a still-optimistic (temp_) endpoint (no real id
  // to persist yet), then pre-flights the pure topology rules — no self-link, no
  // duplicate — via `canConnect`, so the user gets instant feedback rather than a
  // doomed round trip (the service stays authoritative). Optimistic edge in store
  // + cache mirror, one connectNodes mutation, reconcile temp → real id, roll
  // back + toast on failure. A freshly drawn Connection is an ASSOCIATION (#65
  // adds the interaction picker).
  const handleConnect = useCallback(
    async (connection: Connection) => {
      const { source, target } = connection;
      if (!source || !target) return;

      if (source.startsWith("temp_") || target.startsWith("temp_")) {
        toast.error("Finish adding that component before connecting it.");
        return;
      }
      const existing =
        utils.architecture.getCanvas.getData(canvasInput)?.interiorEdges ?? [];
      const check = canConnect(
        { source, target },
        existing.map((e) => ({ source: e.sourceId, target: e.targetId })),
      );
      if (!check.ok) {
        toast.error(
          check.reason === "self-link"
            ? "A component can’t connect to itself."
            : "That connection already exists.",
        );
        return;
      }

      const tempId = `temp_${crypto.randomUUID()}`;
      setEdges((es) =>
        addEdge(
          {
            id: tempId,
            type: "connection",
            source,
            target,
            data: { label: null, optimistic: true },
          },
          es,
        ),
      );
      patchCanvas((c) => ({
        interiorEdges: [
          ...c.interiorEdges,
          optimisticCanvasEdge(tempId, source, target),
        ],
      }));

      try {
        const real = reconciledCanvasEdge(
          await connectNodes.mutateAsync({
            projectId,
            sourceId: source,
            targetId: target,
          }),
        );
        setEdges((es) => es.map((e) => (e.id === tempId ? toRFEdge(real) : e)));
        patchCanvas((c) => ({
          interiorEdges: c.interiorEdges.map((e) =>
            e.id === tempId ? real : e,
          ),
        }));
      } catch {
        setEdges((es) => es.filter((e) => e.id !== tempId));
        patchCanvas((c) => ({
          interiorEdges: c.interiorEdges.filter((e) => e.id !== tempId),
        }));
        toast.error("Couldn’t add the connection. Please try again.");
      }
    },
    [utils, canvasInput, setEdges, patchCanvas, projectId, connectNodes],
  );

  // Remove a Connection (React Flow's Delete/Backspace). `onEdgesChange`
  // already dropped it from the store; here we mirror the removal into the
  // cache and soft-delete it server-side (a plain lone soft-delete — ADR-0030).
  // A still-optimistic edge was never persisted, so it just disappears. Failure
  // re-adds the edge to both stores and toasts.
  const handleEdgesDelete = useCallback(
    (deleted: ConnectionEdge[]) => {
      const cached = utils.architecture.getCanvas.getData(canvasInput);
      for (const edge of deleted) {
        if (edge.id.startsWith("temp_")) continue;
        const prev = cached?.interiorEdges.find((e) => e.id === edge.id);
        patchCanvas((c) => ({
          interiorEdges: c.interiorEdges.filter((e) => e.id !== edge.id),
        }));
        void removeEdge({ id: edge.id }).catch(() => {
          setEdges((es) =>
            es.some((e) => e.id === edge.id) ? es : [...es, edge],
          );
          if (prev) {
            patchCanvas((c) => ({
              interiorEdges: [...c.interiorEdges, prev],
            }));
          }
          toast.error("Couldn’t remove the connection. Please try again.");
        });
      }
    },
    [utils, canvasInput, patchCanvas, setEdges, removeEdge],
  );

  // Undo a Component delete: optimistically re-add the on-canvas rows the delete
  // removed (the off-canvas subtree + interior Connections are restored
  // server-side and reappear on descent), then restore the whole batch by its
  // deletionId. A failed restore re-removes the rows and toasts. Defined before
  // `removeComponent` because that callback references it.
  const undoRemoveComponent = useCallback(
    (
      deletionId: string,
      node: CanvasNode | undefined,
      incidentEdges: CanvasEdge[],
    ): void => {
      if (node) {
        setNodes((ns) =>
          ns.some((n) => n.id === node.id) ? ns : [...ns, toRFNode(node)],
        );
        patchCanvas((c) => ({
          interiorNodes: c.interiorNodes.some((n) => n.id === node.id)
            ? c.interiorNodes
            : [...c.interiorNodes, node],
        }));
      }
      setEdges((es) => {
        const present = new Set(es.map((e) => e.id));
        const add = incidentEdges.filter((e) => !present.has(e.id));
        return add.length ? [...es, ...add.map(toRFEdge)] : es;
      });
      patchCanvas((c) => {
        const present = new Set(c.interiorEdges.map((e) => e.id));
        const add = incidentEdges.filter((e) => !present.has(e.id));
        return add.length
          ? { interiorEdges: [...c.interiorEdges, ...add] }
          : {};
      });

      void restoreComponent({ deletionId })
        .then(() => void utils.architecture.getCanvas.invalidate())
        .catch(() => {
          if (node) {
            setNodes((ns) => ns.filter((n) => n.id !== node.id));
            patchCanvas((c) => ({
              interiorNodes: c.interiorNodes.filter((n) => n.id !== node.id),
            }));
          }
          const ids = new Set(incidentEdges.map((e) => e.id));
          setEdges((es) => es.filter((e) => !ids.has(e.id)));
          patchCanvas((c) => ({
            interiorEdges: c.interiorEdges.filter((e) => !ids.has(e.id)),
          }));
          toast.error("Couldn’t undo. Please try again.");
        });
    },
    [setNodes, setEdges, patchCanvas, restoreComponent, utils],
  );

  // Component-detail panel: opens when the owner single-selects a real (non-
  // temp_) Component. Sourced from React Flow's selection events rather than
  // from React Flow's internal selection state so a node added optimistically
  // never auto-opens the panel before its server id arrives. Cleared on pane
  // click, scope change, or when the selected node is removed.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const closeDetailPanel = useCallback(() => setSelectedNodeId(null), []);

  // Spec attach / merge state (#64 / ADR-0029). `parseError` lives on the panel
  // (a failed preview returns no diff), `pendingPreview` carries the source the
  // user pasted so the modal's confirm can re-apply it without re-pasting, and
  // `preview` is the diff classification the modal renders.
  const [specPreviewError, setSpecPreviewError] = useState<string | null>(null);
  const [pendingPreview, setPendingPreview] = useState<{
    ownerNodeId: string;
    kind: SpecKind;
    source: string;
  } | null>(null);
  const [specPreview, setSpecPreview] = useState<
    RouterOutputs["architecture"]["previewSpec"] | null
  >(null);

  const handlePreviewSpec = useCallback(
    (ownerNodeId: string, input: { kind: SpecKind; source: string }) => {
      setSpecPreviewError(null);
      previewSpec.mutate(
        { ownerNodeId, kind: input.kind, source: input.source },
        {
          onSuccess: (result) => {
            if (result.parseError !== null) {
              setSpecPreviewError(result.parseError);
              return;
            }
            // First-attach with only NEW (no existing spec) skips the modal —
            // convenience philosophy. Anything else opens the modal.
            const firstAttach =
              !result.hasExistingSpec &&
              result.changed.length === 0 &&
              result.dropped.length === 0;
            if (firstAttach) {
              applySpec.mutate(
                {
                  ownerNodeId,
                  kind: input.kind,
                  source: input.source,
                  changed: [],
                  dropped: [],
                },
                {
                  onSuccess: () => {
                    void utils.architecture.getCanvas.invalidate();
                    toast.success(
                      `Attached spec — created ${result.new.length} component${
                        result.new.length === 1 ? "" : "s"
                      }.`,
                    );
                  },
                  onError: (error) => {
                    toast.error(
                      error.message || "Couldn’t attach the spec. Please try again.",
                    );
                  },
                },
              );
              return;
            }
            setSpecPreview(result);
            setPendingPreview({ ownerNodeId, kind: input.kind, source: input.source });
          },
          onError: (error) => {
            setSpecPreviewError(
              error.message || "Couldn’t preview this spec. Please try again.",
            );
          },
        },
      );
    },
    [previewSpec, applySpec, utils],
  );

  const closeSpecModal = useCallback(() => {
    setSpecPreview(null);
    setPendingPreview(null);
  }, []);

  const handleApplySpec = useCallback(
    (decisions: SpecApplyDecisions) => {
      if (!pendingPreview) return;
      applySpec.mutate(
        {
          ownerNodeId: pendingPreview.ownerNodeId,
          kind: pendingPreview.kind,
          source: pendingPreview.source,
          changed: decisions.changed,
          dropped: decisions.dropped,
        },
        {
          onSuccess: (result) => {
            void utils.architecture.getCanvas.invalidate();
            closeSpecModal();
            toast.success(
              `Applied spec — ${result.created} created, ${result.overwritten} overwritten, ${result.detached} detached, ${result.deleted} deleted.`,
            );
          },
          onError: (error) => {
            toast.error(
              error.message || "Couldn’t apply the spec. Please try again.",
            );
          },
        },
      );
    },
    [pendingPreview, applySpec, utils, closeSpecModal],
  );

  // Delete a Component: a cascading soft-delete. Optimistically remove it and its
  // ON-CANVAS incident Connections from the store + cache mirror (descendants and
  // interior Connections live off-canvas — the server cascade handles them), then
  // one deleteNode mutation. On success raise an Undo toast keyed by the returned
  // deletionId; on failure roll the removal back and toast. Provided to the nodes
  // through DeleteComponentContext so it stays one stable reference.
  const removeComponent = useCallback(
    (id: string): void => {
      if (id.startsWith("temp_")) return; // no real id to soft-delete yet
      const cached = utils.architecture.getCanvas.getData(canvasInput);
      const node = cached?.interiorNodes.find((n) => n.id === id);
      const incidentEdges =
        cached?.interiorEdges.filter(
          (e) => e.sourceId === id || e.targetId === id,
        ) ?? [];

      if (selectedNodeId === id) closeDetailPanel();

      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
      patchCanvas((c) => ({
        interiorNodes: c.interiorNodes.filter((n) => n.id !== id),
        interiorEdges: c.interiorEdges.filter(
          (e) => e.sourceId !== id && e.targetId !== id,
        ),
      }));

      void deleteComponent({ id })
        .then(({ deletionId }) => {
          void utils.architecture.getCanvas.invalidate();
          toast("Component deleted", {
            action: {
              label: "Undo",
              onClick: () =>
                undoRemoveComponent(deletionId, node, incidentEdges),
            },
          });
        })
        .catch(() => {
          if (node) {
            setNodes((ns) =>
              ns.some((n) => n.id === id) ? ns : [...ns, toRFNode(node)],
            );
            patchCanvas((c) => ({
              interiorNodes: c.interiorNodes.some((n) => n.id === id)
                ? c.interiorNodes
                : [...c.interiorNodes, node],
            }));
          }
          setEdges((es) => {
            const present = new Set(es.map((e) => e.id));
            const add = incidentEdges.filter((e) => !present.has(e.id));
            return add.length ? [...es, ...add.map(toRFEdge)] : es;
          });
          patchCanvas((c) => {
            const present = new Set(c.interiorEdges.map((e) => e.id));
            const add = incidentEdges.filter((e) => !present.has(e.id));
            return add.length
              ? { interiorEdges: [...c.interiorEdges, ...add] }
              : {};
          });
          toast.error("Couldn’t delete the component. Please try again.");
        });
    },
    [
      utils,
      canvasInput,
      setNodes,
      setEdges,
      patchCanvas,
      deleteComponent,
      undoRemoveComponent,
      selectedNodeId,
      closeDetailPanel,
    ],
  );

  // Edit a Connection's label: optimistic in store + cache mirror, one updateEdge
  // mutation, both rolled back with a toast on failure. Provided to the edges
  // through context (below) so it stays one stable reference. (A Connection's
  // interaction is set at creation; the picker is #65.)
  const commitEdgeEdit = useCallback(
    (id: string, label: string | null): void => {
      const prev = utils.architecture.getCanvas
        .getData(canvasInput)
        ?.interiorEdges.find((e) => e.id === id);

      setEdges((es) =>
        es.map((e) => (e.id === id ? { ...e, data: { ...e.data, label } } : e)),
      );
      patchCanvas((c) => ({
        interiorEdges: c.interiorEdges.map((e) =>
          e.id === id ? { ...e, label } : e,
        ),
      }));

      void editEdge({ id, label }).catch(() => {
        if (prev) {
          setEdges((es) => es.map((e) => (e.id === id ? toRFEdge(prev) : e)));
          patchCanvas((c) => ({
            interiorEdges: c.interiorEdges.map((e) => (e.id === id ? prev : e)),
          }));
        }
        toast.error("Couldn’t save the connection. Please try again.");
      });
    },
    [utils, canvasInput, setEdges, patchCanvas, editEdge],
  );

  // Descent: open a Component's interior Canvas. One callback shared by the
  // node's "Open" button (via DescendComponentContext) and the flow's
  // double-click handler, so the route + prefetch logic lives in one place.
  const descend = useCallback(
    (nodeId: string) => {
      if (nodeId.startsWith("temp_")) return; // no real interior yet
      // Pre-warm in case this wasn't preceded by a hover (keyboard activation).
      void utils.architecture.getCanvas.prefetch({
        slug,
        canvasNodeId: nodeId,
      });
      router.prefetch(`/p/${slug}/n/${nodeId}`);
      router.push(`/p/${slug}/n/${nodeId}`);
    },
    [utils, router, slug],
  );

  // Resolve the selected Component once for the detail panel (owner-edit or
  // viewer-read), de-duping the kind/documentation lookups.
  const selectedNode =
    selectedNodeId === null
      ? undefined
      : interiorNodes.find((n) => n.id === selectedNodeId);

  return (
    <RenameComponentContext.Provider value={commitRename}>
      <EditEdgeContext.Provider value={commitEdgeEdit}>
        <DescendComponentContext.Provider value={descend}>
          <DeleteComponentContext.Provider value={removeComponent}>
            <CanEditContext.Provider value={canEdit}>
              <ReactFlow<ComponentNode, ConnectionEdge>
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={(c) => void handleConnect(c)}
                // Loose connection mode: a Connection can be drawn between any
                // two handles in either direction — Components are not
                // directional, so a Port has no input/output role and the drag
                // direction carries no meaning here (a Connection's interaction
                // is set separately; #65). The draw order is preserved on the
                // Edge for the eventual arrowhead derivation (ADR-0027).
                connectionMode={ConnectionMode.Loose}
                // Instant drag feedback: reject a self-link and a still-optimistic
                // (temp_) endpoint by snapping back. Duplicates are deliberately
                // allowed through (passing [] skips the duplicate rule) so
                // onConnect can surface a toast — blocking them here would snap a
                // duplicate back silently, with no explanation.
                isValidConnection={(c) => {
                  const { source, target } = c;
                  if (!source || !target) return false;
                  if (
                    source.startsWith("temp_") ||
                    target.startsWith("temp_")
                  ) {
                    return false;
                  }
                  return canConnect({ source, target }, []).ok;
                }}
                onEdgesDelete={handleEdgesDelete}
                onNodeClick={(_event, node) => {
                  // A `temp_…` Component has no server id yet; opening the
                  // detail panel would query for a node the server cannot
                  // find. Single-click selection only for real Components —
                  // double-click still descends.
                  if (node.id.startsWith("temp_")) return;
                  setSelectedNodeId(node.id);
                }}
                onPaneClick={() => setSelectedNodeId(null)}
                onNodeDoubleClick={(_event, node) => descend(node.id)}
                onNodeMouseEnter={(_event, node) => {
                  // Make Descent feel instant: warm the interior Canvas payload (tRPC
                  // cache, the same key the descended island reads) and the route shell.
                  // Also warm the Plate docs-editor chunk so first selection of a
                  // Component doesn't pay a "Loading editor…" flash (ADR-0015 §6).
                  if (node.id.startsWith("temp_")) return;
                  void utils.architecture.getCanvas.prefetch({
                    slug,
                    canvasNodeId: node.id,
                  });
                  router.prefetch(`/p/${slug}/n/${node.id}`);
                  // Viewers open the read-only docs panel too, so warm the
                  // Plate chunk for everyone — no first-open flash (perf #1).
                  prefetchDocsEditor();
                }}
                onNodeDragStop={(_event, _node, dragged) =>
                  void persistPositions(dragged)
                }
                onSelectionDragStop={(_event, dragged) =>
                  void persistPositions(dragged)
                }
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                nodesDraggable={canEdit}
                nodesConnectable={canEdit}
                deleteKeyCode={canEdit ? undefined : null}
                fitView
              >
                <Background />
                <Controls />
                <Panel position="top-left" className="flex gap-2">
                  {canEdit && (
                    <AddComponent
                      onAdd={addComponent}
                      parentKind={parentKind}
                      pending={createNode.isPending}
                    />
                  )}
                  {/* Slug-readable: visible to any viewer, not gated on
                      edit. Always exports the whole project (ADR-0017 /
                      #15) — the scope-specific export lives on the
                      breadcrumb bar. */}
                  <CopyMarkdownToolbar slug={slug} />
                </Panel>
                {selectedNodeId !== null &&
                  (canEdit ? (
                    <Panel
                      key={selectedNodeId}
                      position="top-right"
                      className="top-0! right-0! bottom-0! m-0! flex"
                    >
                      {/* Owner mode: full edit affordances wired to the
                          canvas's mutations. Discriminated `readOnly: false`
                          keeps write callbacks visible at compile time (#16). */}
                      <ComponentDetailPanel
                        readOnly={false}
                        ownerNodeId={selectedNodeId}
                        currentKind={selectedNode?.kind ?? "GENERIC"}
                        parentKind={parentKind}
                        initialDocumentation={selectedNode?.documentation ?? ""}
                        onClose={closeDetailPanel}
                        onChangeKind={commitNodeKind}
                        onCommitDocumentation={commitDocumentation}
                        onPreviewSpec={handlePreviewSpec}
                        specPreviewPending={
                          previewSpec.isPending || applySpec.isPending
                        }
                        specPreviewError={specPreviewError}
                      />
                    </Panel>
                  ) : (
                    <Panel
                      key={selectedNodeId}
                      position="top-right"
                      className="top-0! right-0! bottom-0! m-0! flex"
                    >
                      {/* Viewer mode: read-only docs, zero write affordances.
                          Discriminated `readOnly: true` omits mutations at
                          compile time (#16). */}
                      <ComponentDetailPanel
                        readOnly={true}
                        ownerNodeId={selectedNodeId}
                        currentKind={selectedNode?.kind ?? "GENERIC"}
                        parentKind={parentKind}
                        initialDocumentation={selectedNode?.documentation ?? ""}
                        onClose={closeDetailPanel}
                      />
                    </Panel>
                  ))}
                {nodes.length === 0 && (
                  <Panel position="top-center">
                    <p className="mt-2 text-sm text-white/50">
                      Empty canvas. Add a Component to start modeling.
                    </p>
                  </Panel>
                )}
              </ReactFlow>
            </CanEditContext.Provider>
          </DeleteComponentContext.Provider>
        </DescendComponentContext.Provider>
      </EditEdgeContext.Provider>
      {/* Spec attach/merge modal (#64 / ADR-0029). Portaled by Base UI, so it
          sits outside React Flow's coordinate space. Mounted only while a
          preview is staged so its initial state seeds from the current diff. */}
      {specPreview !== null && (
        <SpecConflictModal
          open
          preview={specPreview}
          pending={applySpec.isPending}
          onCancel={closeSpecModal}
          onConfirm={handleApplySpec}
        />
      )}
    </RenameComponentContext.Provider>
  );
}

export default function Canvas({
  scope,
  slug,
  projectId,
  canEdit,
}: {
  scope: string;
  slug: string;
  projectId: string;
  canEdit: boolean;
}) {
  return (
    <ReactFlowProvider>
      <div data-canvas-scope={scope} className="h-full w-full">
        <Suspense
          fallback={<div className="h-full w-full bg-[#1b1c33]" aria-hidden />}
        >
          <CanvasInner
            scope={scope}
            slug={slug}
            projectId={projectId}
            canEdit={canEdit}
          />
        </Suspense>
      </div>
      <Toaster theme="dark" position="bottom-right" richColors />
    </ReactFlowProvider>
  );
}
