import type { IncomingHttpHeaders } from "node:http";

export type Descriptor = {
  body?: string | Uint8Array;
  contentType?: string;
  status?: number;
  headers?: Record<string, string>;
  delayMs?: number;
  hold?: string;
  partial?: boolean;
};
type Observation = {
  readonly method: string | undefined;
  readonly path: string;
  readonly target: string;
  readonly headers: Readonly<IncomingHttpHeaders>;
};
type ServiceBinding = { fetch(request: Request): Promise<Response> };
export function startWorkerFixture(options?: {
  assets?: Map<string, Descriptor | { sequence: Descriptor[] }>;
  routes?: Map<string, Descriptor | { sequence: Descriptor[] }>;
  env?: {
    CARR?: ServiceBinding;
    APP_ENV?: string;
    GIT_SHA?: string;
    ENGINE?: ServiceBinding;
    ENGINE_ROUTING?: {
      get(key: string, options: { cacheTtl: number }): string | null | undefined | Promise<string | null | undefined>;
    };
    PARTNER_APP?: ServiceBinding;
    PARTNER_SIGN_IN?: "carr" | "engine";
    WORKSPACE_COMMAND_CENTER_READ_ENABLED?: "true" | "false";
  };
  limits?: Partial<
    Record<"bytes" | "entries" | "body" | "requests" | "observations" | "connections" | "delayMs", number>
  >;
  signal?: AbortSignal;
  port?: number;
  qaSeed?: unknown;
  demo?: boolean;
}): Promise<{
  readonly origin: string;
  readonly requests: Observation[];
  readonly rejectedRequests: Observation[];
  close(): Promise<void>;
  release(token: string): void;
}>;

export function startFixture(options?: Parameters<typeof startWorkerFixture>[0]): ReturnType<typeof startWorkerFixture>;
