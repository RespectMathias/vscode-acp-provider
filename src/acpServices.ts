import * as vscode from "vscode";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { AcpClient, AcpPermissionHandler } from "./acpClient";
import { DisposableBase } from "./disposables";
import { AcpAgentConfigurationEntry } from "./types";

const CONFIG_NAMESPACE = "acpClient";
const CONFIG_KEY = `${CONFIG_NAMESPACE}.agents`;
export const ACP_SESSION_SCHEME = "acp";

export interface AcpSessionRecord {
  readonly id: string;
  readonly agentId: string;
  readonly client: AcpClient;
  label: string;
  status: "idle" | "running" | "completed";
  readonly createdAt: number;
  updatedAt: number;
  history: Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn>;
  needsRestore?: boolean;
  cwd?: string;
}

interface PersistedSessionMetadata {
  id: string;
  agentId: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
}

export class AcpAgentConfigurationService extends DisposableBase {
  private agents: AcpAgentConfigurationEntry[] = [];
  private readonly onDidChangeEmitter = this._register(
    new vscode.EventEmitter<void>(),
  );
  public readonly onDidChangeAgents: vscode.Event<void> =
    this.onDidChangeEmitter.event;

  constructor(
    private readonly onAgentsRemoved?: (removedIds: string[]) => void,
  ) {
    super();
    this.reload();
    this._register(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG_KEY)) {
          const oldAgentIds = new Set(this.agents.map((a) => a.id));
          this.reload();
          const newAgentIds = new Set(this.agents.map((a) => a.id));
          const removed = [...oldAgentIds].filter((id) => !newAgentIds.has(id));
          if (removed.length > 0 && this.onAgentsRemoved) {
            this.onAgentsRemoved(removed);
          }
          this.onDidChangeEmitter.fire();
        }
      }),
    );
  }

  getAgents(): readonly AcpAgentConfigurationEntry[] {
    return this.agents;
  }

  getAgent(agentId: string): AcpAgentConfigurationEntry | undefined {
    return this.agents[0];
  }

  getDefaultAgent(): AcpAgentConfigurationEntry | undefined {
    return this.agents[0];
  }

  private reload(): void {
    const configuration = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    console.trace("Reloading ACP agents configuration");
    const rawAgents = configuration.get<unknown[]>("agents", []);
    console.trace(`Found ${rawAgents.length} ACP agent configurations`);
    const normalized: AcpAgentConfigurationEntry[] = [];
    for (const candidate of rawAgents ?? []) {
      const entry = this.normalizeAgent(candidate);
      if (entry) {
        normalized.push(entry);
      }
    }
    this.agents = normalized;
  }

  private normalizeAgent(
    candidate: unknown,
  ): AcpAgentConfigurationEntry | undefined {
    if (!candidate || typeof candidate !== "object") {
      return undefined;
    }
    const { id, command } = candidate as { id?: unknown; command?: unknown };
    if (
      typeof id !== "string" ||
      !id.trim() ||
      typeof command !== "string" ||
      !command.trim()
    ) {
      return undefined;
    }
    const title =
      typeof (candidate as { title?: unknown }).title === "string"
        ? (candidate as { title?: string }).title!.trim()
        : id.trim();
    const argsValue = (candidate as { args?: unknown }).args;
    const args = Array.isArray(argsValue)
      ? argsValue.filter((val): val is string => typeof val === "string")
      : [];
    const cwdValue = (candidate as { cwd?: unknown }).cwd;
    const cwd =
      typeof cwdValue === "string" && cwdValue.trim() ? cwdValue : undefined;
    const envRaw = (candidate as { env?: unknown }).env;
    const env: Record<string, string> | undefined =
      envRaw && typeof envRaw === "object"
        ? Object.entries(envRaw as Record<string, unknown>)
            .filter(([, value]) => typeof value === "string")
            .reduce<Record<string, string>>((acc, [key, value]) => {
              acc[key] = value as string;
              return acc;
            }, {})
        : undefined;
    const enabled = (candidate as { enabled?: unknown }).enabled;
    if (enabled === false) {
      return undefined;
    }
    return {
      id: id.trim(),
      title: title || id.trim(),
      command: command.trim(),
      args,
      cwd,
      env,
      enabled: true,
    };
  }
}

export class AcpClientManager extends DisposableBase {
  private readonly clients = new Map<string, AcpClient>();
  private readonly permissionHandler: AcpPermissionHandler = {
    requestPermission: (request) => this.requestPermission(request),
  };

  constructor(
    private readonly agentConfiguration: AcpAgentConfigurationService,
    private readonly logChannel: vscode.OutputChannel,
  ) {
    super();
  }

  async getClient(agentId: string): Promise<AcpClient> {
    const agent = this.agentConfiguration.getAgent(agentId);
    if (!agent) {
      throw new Error(`Unknown ACP agent '${agentId}'`);
    }
    let client = this.clients.get(agentId);
    if (!client) {
      client = this._register(
        new AcpClient(agent, this.permissionHandler, this.logChannel),
      );
      client.onDidStop(() => this.clients.delete(agentId));
      this.clients.set(agentId, client);
    }
    await client.ensureReady();
    return client;
  }

  async reset(): Promise<void> {
    for (const client of this.clients.values()) {
      client.dispose();
    }
    this.clients.clear();
  }

  private async requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const picks = request.options.map((option) => ({
      label: option.name,
      description: option.kind,
      option,
    }));
    const selection = await vscode.window.showQuickPick(picks, {
      placeHolder:
        request.toolCall.title ??
        vscode.l10n.t(
          "Select an option for request {0}",
          request.toolCall.toolCallId,
        ),
    });
    if (!selection) {
      return {
        outcome: { outcome: "cancelled" },
      };
    }
    return {
      outcome: { outcome: "selected", optionId: selection.option.optionId },
    };
  }
}

export class AcpSessionStore extends DisposableBase {
  private readonly sessions = new Map<string, AcpSessionRecord>();
  private readonly onDidChangeEmitter = this._register(
    new vscode.EventEmitter<void>(),
  );
  public readonly onDidChangeSessions: vscode.Event<void> =
    this.onDidChangeEmitter.event;
  private static readonly STORAGE_KEY_PREFIX = "acp.sessions";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly agentConfiguration: AcpAgentConfigurationService,
    private readonly clientManager: AcpClientManager,
    private readonly logChannel: vscode.OutputChannel,
  ) {
    super();
  }

  async listSessions(): Promise<AcpSessionRecord[]> {
    return [...this.sessions.values()];
  }

  async getSession(sessionId: string): Promise<AcpSessionRecord | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    if (session.needsRestore) {
      try {
        const cwd = session.cwd ?? this.pickWorkspaceDirectory();
        await session.client.loadSession(session.id, cwd);
        session.needsRestore = false;
      } catch (error) {
        this.logChannel.appendLine(
          `[acp:${session.agentId}] failed to load session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }

    return session;
  }

  async createSession(
    agentId: string,
    label: string | undefined,
    cwd: string | undefined,
  ): Promise<AcpSessionRecord> {
    const agent = this.agentConfiguration.getAgent(agentId);
    if (!agent) {
      throw new Error(`Unknown ACP agent '${agentId}'`);
    }
    const client = await this.clientManager.getClient(agentId);
    const workingDirectory = cwd ?? agent.cwd ?? this.pickWorkspaceDirectory();
    try {
      const response = await client.createSession(workingDirectory);
      const record: AcpSessionRecord = {
        id: response.sessionId,
        agentId,
        client,
        label: label?.trim() || agent.title || agent.id,
        status: "idle",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        history: [],
        cwd: workingDirectory,
      };
      this.sessions.set(record.id, record);

      const capabilities = client.getCapabilities();
      if (capabilities?.loadSession === true) {
        await this.persistSessionMetadata(record);
      } else {
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            'Session will not persist across restarts. Agent "{0}" does not support session persistence.',
            agent.title,
          ),
        );
      }

      this.onDidChangeEmitter.fire();
      return record;
    } catch (error) {
      this.logChannel.appendLine(
        `[acp:${agentId}] failed to create session: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  updateSessionStatus(
    sessionId: string,
    status: "idle" | "running" | "completed",
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.status = status;
    session.updatedAt = Date.now();
    this.onDidChangeEmitter.fire();
  }

  appendToHistory(
    sessionId: string,
    turn: vscode.ChatRequestTurn | vscode.ChatResponseTurn,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.history.push(turn);
    this.onDidChangeEmitter.fire();
  }

  private pickWorkspaceDirectory(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      return workspaceFolder.uri.fsPath;
    }
    return process.cwd();
  }

  async restoreSessions(): Promise<void> {
    const agents = this.agentConfiguration.getAgents();
    for (const agent of agents) {
      const storageKey = `${AcpSessionStore.STORAGE_KEY_PREFIX}.${agent.id}`;
      const persisted = this.context.workspaceState.get<
        PersistedSessionMetadata[]
      >(storageKey, []);

      for (const metadata of persisted) {
        if (this.sessions.has(metadata.id)) {
          continue;
        }

        try {
          const client = await this.clientManager.getClient(agent.id);
          const record: AcpSessionRecord = {
            id: metadata.id,
            agentId: metadata.agentId,
            client,
            label: metadata.label,
            status: "idle",
            createdAt: metadata.createdAt,
            updatedAt: metadata.updatedAt,
            history: [],
            needsRestore: true,
            cwd: metadata.cwd,
          };
          this.sessions.set(record.id, record);
        } catch (error) {
          this.logChannel.appendLine(
            `[acp:${agent.id}] failed to restore session ${metadata.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    if (this.sessions.size > 0) {
      this.onDidChangeEmitter.fire();
    }
  }

  private async persistSessionMetadata(
    session: AcpSessionRecord,
  ): Promise<void> {
    const storageKey = `${AcpSessionStore.STORAGE_KEY_PREFIX}.${session.agentId}`;
    const existing = this.context.workspaceState.get<
      PersistedSessionMetadata[]
    >(storageKey, []);
    const metadata: PersistedSessionMetadata = {
      id: session.id,
      agentId: session.agentId,
      label: session.label,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      cwd: session.cwd ?? this.pickWorkspaceDirectory(),
    };
    const updated = existing.filter((s) => s.id !== session.id);
    updated.push(metadata);
    await this.context.workspaceState.update(storageKey, updated);
  }

  async cleanupRemovedAgents(removedAgentIds: string[]): Promise<void> {
    for (const agentId of removedAgentIds) {
      const storageKey = `${AcpSessionStore.STORAGE_KEY_PREFIX}.${agentId}`;
      await this.context.workspaceState.update(storageKey, undefined);

      for (const [sessionId, session] of this.sessions.entries()) {
        if (session.agentId === agentId) {
          this.sessions.delete(sessionId);
        }
      }
    }
    if (removedAgentIds.length > 0) {
      this.onDidChangeEmitter.fire();
    }
  }

  clear(): void {
    this.sessions.clear();
    this.onDidChangeEmitter.fire();
  }
}

export function toSessionResource(sessionId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: ACP_SESSION_SCHEME, path: `/${sessionId}` });
}

export function tryGetSessionId(resource: vscode.Uri): string | undefined {
  if (resource.scheme === ACP_SESSION_SCHEME) {
    return resource.path.slice(1);
  }
  if (resource.scheme === "untitled" || resource.path.startsWith("/untitled")) {
    return resource.path.slice(1);
  }
  return undefined;
}
