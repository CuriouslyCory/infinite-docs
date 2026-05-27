import {
  defaultShouldDehydrateQuery,
  QueryClient,
} from "@tanstack/react-query";
import SuperJSON from "superjson";

export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        // With SSR, we usually want to set some default staleTime
        // above 0 to avoid refetching immediately on the client
        staleTime: 30 * 1000,
        // Never retry a deterministic application error. A NOT_FOUND scope
        // (e.g. a stale Descent link) or an UNAUTHORIZED read won't become valid
        // on a second try — retrying only strands the error boundary on the full
        // backoff before the not-found UI shows. tRPC surfaces these two ways:
        // client-side as a TRPCClientError (`data.httpStatus` / `data.code`) and
        // server-side (the RSC prefetch caller) as a raw TRPCError with a
        // top-level `code` and no `httpStatus` — cover BOTH, or the server-side
        // prefetch keeps retrying and holds the SSR stream open. Transient
        // failures (network, 5xx) keep TanStack's default three attempts.
        retry: (failureCount, error) => {
          const e = error as {
            code?: unknown;
            data?: { code?: unknown; httpStatus?: unknown };
          };
          const httpStatus = e.data?.httpStatus;
          if (
            typeof httpStatus === "number" &&
            httpStatus >= 400 &&
            httpStatus < 500
          ) {
            return false;
          }
          const code = e.data?.code ?? e.code;
          if (
            code === "NOT_FOUND" ||
            code === "UNAUTHORIZED" ||
            code === "FORBIDDEN" ||
            code === "BAD_REQUEST" ||
            code === "CONFLICT"
          ) {
            return false;
          }
          return failureCount < 3;
        },
      },
      dehydrate: {
        serializeData: SuperJSON.serialize,
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) ||
          query.state.status === "pending",
      },
      hydrate: {
        deserializeData: SuperJSON.deserialize,
      },
    },
  });
