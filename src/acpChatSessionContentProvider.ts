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
  private itemProvider?:
    | import("./acpChatSessionItemProvider").AcpChatSessionItemProvider
    | undefined;

  attachItemProvider(
    itemProvider: import("./acpChatSessionItemProvider").AcpChatSessionItemProvider,
  ): void {
    this.itemProvider = itemProvider;
  }

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
      // Resource doesn't contain an agent id (likely 'untitled').
      // Lookup available agents. If none exist, surface an error and fail the session.
      const agents = this.options.agentRegistry
        .list()
        .filter((a) => a.enabled !== false);
      if (!agents.length) {
        // Inform the user synchronously and fail the resolution so the UI shows an error.
        void vscode.window.showErrorMessage(
          "No ACP agents are available. Install or enable an agent to start a session.",
        );
        throw new Error("No ACP agents available for chat session");
      }

      // Use the first agent as the default.
      const selected = agents[0];

      // Return a placeholder session immediately so the UI can open.
      const placeholder: vscode.ChatSession = {
        history: [],
        requestHandler: undefined,
      };
      this.sessions.set(key, {
        session: placeholder,
        state: null as unknown as SessionState,
      });

      // Create the final session state and request the item replacement asynchronously.
      setTimeout(() => {
        try {
          if (!this.itemProvider) {
            return;
          }

          const modified = this.itemProvider.createSessionItem(selected);

          // Create the session state before telling the UI to replace the item.
          this.options.sessionManager.createSessionState(
            selected,
            modified.resource,
          );

          // Create a minimal original item representing the untitled session so VS Code can map it.
          const original: vscode.ChatSessionItem = {
            resource,
            label: "ACP",
            status: vscode.ChatSessionStatus.Completed,
          };

          this.itemProvider.commitReplacement(original, modified);
        } catch {
          // swallow errors - don't crash provide.
        }
      }, 0);

      return placeholder;
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
