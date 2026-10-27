import type { PushNotification } from "../../../../app/packages/contracts/src/baskulePush";
// Types of the T3 workerd bundle (`space-cell.js`, built from the fork's
// apps/server/src/baskule/workerd/ by ../sync-bundle.sh). Keep in sync with spaceServer.ts there.
export interface DoSqlStorage {
  readonly sql: {
    exec(query: string, ...bindings: ReadonlyArray<unknown>): {
      readonly columnNames: ReadonlyArray<string>;
      raw(): IterableIterator<ReadonlyArray<unknown>>;
    };
    readonly databaseSize?: number;
  };
  transaction<T>(closure: () => Promise<T>): Promise<T>;
}

export interface SpaceDatabase { readonly client: unknown; readonly stats: SpaceServer["sqlStats"]; }
export function createSpaceSqlClient(storage: DoSqlStorage, onStorageLost?: () => void): Promise<SpaceDatabase>;

export interface SpaceServerConfig {
  readonly push?: { deliver: (notification: PushNotification, environmentId: string) => Promise<void>; changed: () => Promise<void> };
  readonly spaceId: string;
  readonly storage: DoSqlStorage;
  readonly database?: SpaceDatabase;
  readonly agentFetch: (request: Request) => Promise<Response>;
  readonly computerdUrl?: string | undefined;
  readonly computerdToken?: string | undefined;
  readonly otlpTracesUrl?: string | undefined;
  readonly llmModel: string;
  readonly llmProviderId: string;
  readonly logLevel?: "Debug" | "Info" | "Warn" | "Error" | undefined;
  readonly onSocketOpen?: (() => () => void) | undefined;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly onStorageLost?: (() => void) | undefined;
  readonly publicOrigin?: string | undefined;
}

export interface SpaceSocket {
  readonly userId: string;
  readonly sessionId: string;
  close(code: number, reason: string): void;
}

export interface SpaceServer {
  readonly bootMs: number;
  readonly sqlStats: Record<string, number>;
  fetch(request: Request): Promise<Response>;
  sockets(): ReadonlyArray<SpaceSocket>;
  revoke(target: { readonly userId?: string; readonly sessionId?: string }): Promise<{ readonly revoked: number; readonly closed: number }>;
  activeRuns(): number;
  isPushCurrent(eventId: string, threadId: string): Promise<boolean>;
  drainPushEffects(): Promise<void>;
  nextWakeAt(): number | null;
  stopActiveRuns(reason: string): Promise<number>;
  /** WP-F: unsnoozes (and marks unread) the chats whose snooze is due; returns how many. */
  wakeDueSnoozes(): Promise<number>;
  dispose(): Promise<void>;
}

export declare const AGENT_ORIGIN: string;
export declare const CHATS_ROOT: string;
export declare const SANDBOX_ROOT: string;
export declare const SPACES_HOME: string;
export declare function createSpaceServer(config: SpaceServerConfig): Promise<SpaceServer>;
export declare function classifyRoute(
  method: string,
  pathname: string,
  isUpgrade: boolean,
): { readonly allow: true } | { readonly allow: false; readonly status: number; readonly reason: string };
export declare const BASKULE_ALLOWED_METHODS: ReadonlySet<string>;
export declare const BASKULE_ALLOWED_COMMANDS: ReadonlySet<string>;
