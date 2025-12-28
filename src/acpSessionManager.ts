import vscode from "vscode";
import { AcpClient, AcpPermissionHandler } from "./acpClient";
import { AgentRegistryEntry } from "./agentRegistry";
import { createSessionType } from "./chatIdentifiers";
import { DisposableBase } from "./disposables";
import { getWorkspaceCwd } from "./permittedPaths";

export class Session {
  status: "idle" | "running" | "error";
  pendingRequest?: {
    cancellation: vscode.CancellationTokenSource;
    permissionContext?: vscode.Disposable;
  };

  constructor(
    readonly agent: AgentRegistryEntry,
    readonly vscodeResource: vscode.Uri,
    readonly client: AcpClient,
    readonly acpSessionId: string,
    readonly defaultChatOptions: { modeId: string; modelId: string },
  ) {
    this.status = "idle";
    this.pendingRequest = undefined;
  }
}

export interface AcpSessionManager extends vscode.Disposable {
  getDefault(): Promise<Session>;
  create(vscodeResource: vscode.Uri): Promise<Session>;
  get(vscodeResource: vscode.Uri): Session | undefined;
}

export function createAcpSessionManager(
  agent: AgentRegistryEntry,
  permissionHandler: AcpPermissionHandler,
  logger: vscode.LogOutputChannel,
): AcpSessionManager {
  return new SessionManager(agent, permissionHandler, logger);
}

const DEFAULT_SESSION_ID = "default";

class SessionManager extends DisposableBase implements AcpSessionManager {
  private readonly client: AcpClient;
  constructor(
    private readonly agent: AgentRegistryEntry,
    readonly permissionHandler: AcpPermissionHandler,
    private readonly logger: vscode.LogOutputChannel,
  ) {
    super();
    this.client = new AcpClient(agent, permissionHandler, logger);
  }

  private activeSessions: Map<string, Session> = new Map();

  async getDefault(cwd: string = getWorkspaceCwd()): Promise<Session> {
    let session = this.activeSessions.get(DEFAULT_SESSION_ID);
    if (session) {
      return session;
    }

    // create new default session
    this.logger.info(`Creating default session for agent ${this.agent.id}`);
    const acpSession = await this.client.createSession(cwd);

    session = {
      agent: this.agent,
      vscodeResource: vscode.Uri.parse(
        `${createSessionType(this.agent.id)}://default`,
      ),
      acpSessionId: acpSession.sessionId,
      client: this.client,
      defaultChatOptions: {
        modeId: acpSession.modes?.currentModeId || "",
        modelId: acpSession.models?.currentModelId || "",
      },
      status: "idle",
      pendingRequest: undefined,
    };

    this.activeSessions.set(DEFAULT_SESSION_ID, session);
    return session;
  }

  async create(vscodeResource: vscode.Uri): Promise<Session> {
    // check if a session exist for the given resource
    const key = vscodeResource.toString();
    let session = this.activeSessions.get(key);
    if (session) {
      this.logger.debug(
        `Reusing existing session for resource ${vscodeResource.toString()}`,
      );
      return session;
    }

    // check if the default session exists, if so use it and update the map
    session = this.activeSessions.get(DEFAULT_SESSION_ID);
    if (session) {
      this.logger.debug(
        `Reusing default session for resource ${vscodeResource.toString()}`,
      );
      this.activeSessions.delete(DEFAULT_SESSION_ID);
      this.activeSessions.set(key, session);
      return session;
    }

    // create new session
    this.logger.info(
      `Creating new session for resource ${vscodeResource.toString()}`,
    );
    const acpSession = await this.client.createSession(getWorkspaceCwd());

    session = {
      agent: this.agent,
      vscodeResource: vscodeResource,
      acpSessionId: acpSession.sessionId,
      client: this.client,
      defaultChatOptions: {
        modeId: acpSession.modes?.currentModeId || "",
        modelId: acpSession.models?.currentModelId || "",
      },
      status: "idle",
      pendingRequest: undefined,
    };

    this.activeSessions.set(key, session);
    return session;
  }

  get(vscodeResource: vscode.Uri): Session | undefined {
    const key = vscodeResource.toString();
    return this.activeSessions.get(key);
  }
}
