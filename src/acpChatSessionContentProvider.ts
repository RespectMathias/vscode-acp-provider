import * as vscode from "vscode";
import { DisposableBase } from "./disposables";
import { SessionManager } from "./sessionManager";
import { AgentRegistry } from "./agentRegistry";
import { getAgentIdFromResource } from "./chatIdentifiers";
import { SessionState } from "./sessionState";

export interface AcpChatSessionContentProviderOptions {
  readonly sessionManager: SessionManager;
  readonly agentRegistry: AgentRegistry;
}

interface ActiveSessionContext {
  readonly session: vscode.ChatSession;
  readonly state: SessionState;
}

export class AcpChatSessionContentProvider
  extends DisposableBase
  implements vscode.ChatSessionContentProvider
{
  private readonly sessions = new Map<string, ActiveSessionContext>();

  constructor(private readonly options: AcpChatSessionContentProviderOptions) {
    super();
  }

  provideChatSessionContent(
    resource: vscode.Uri,
    _token: vscode.CancellationToken,
  ): vscode.ChatSession {
    const key = resource.toString();
    const existing = this.sessions.get(key);
    if (existing) {
      return existing.session;
    }

    const agentId = getAgentIdFromResource(resource);
    if (!agentId) {
      throw new Error("Unknown ACP agent for chat session");
    }
    const agent = this.options.agentRegistry.get(agentId);
    if (!agent) {
      throw new Error(`ACP agent '${agentId}' is not available`);
    }

    const state = this.options.sessionManager.createSessionState(
      agent,
      resource,
    );

    const session: vscode.ChatSession = {
      history: [],
      requestHandler: undefined,
    };

    this.sessions.set(key, { session, state });
    return session;
  }

  release(resource: vscode.Uri): void {
    const key = resource.toString();
    const runtime = this.sessions.get(key);
    if (!runtime) {
      return;
    }
    this.sessions.delete(key);
    this.options.sessionManager.release(resource);
  }

  reset(): void {
    for (const context of this.sessions.values()) {
      this.options.sessionManager.release(context.state.vscodeResource);
    }
    this.sessions.clear();
  }

  override dispose(): void {
    this.reset();
    super.dispose();
  }
}
