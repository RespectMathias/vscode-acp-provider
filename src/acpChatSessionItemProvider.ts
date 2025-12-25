import * as vscode from "vscode";
import { DisposableBase } from "./disposables";
import { AgentRegistry, AgentRegistryEntry } from "./agentRegistry";
import { createChatSessionUri } from "./chatIdentifiers";

export interface AcpChatSessionItemProviderOptions {
  readonly agentRegistry: AgentRegistry;
  readonly onDidRequestOpenSession?: (agent: AgentRegistryEntry) => void;
}

export class AcpChatSessionItemProvider
  extends DisposableBase
  implements vscode.ChatSessionItemProvider
{
  private readonly onDidChangeChatSessionItemsEmitter = this._register(
    new vscode.EventEmitter<void>(),
  );
  readonly onDidChangeChatSessionItems =
    this.onDidChangeChatSessionItemsEmitter.event;

  private readonly onDidCommitChatSessionItemEmitter = this._register(
    new vscode.EventEmitter<{
      original: vscode.ChatSessionItem;
      modified: vscode.ChatSessionItem;
    }>(),
  );
  readonly onDidCommitChatSessionItem =
    this.onDidCommitChatSessionItemEmitter.event;

  constructor(private readonly options: AcpChatSessionItemProviderOptions) {
    super();
    this._register(
      this.options.agentRegistry.onDidChange(() => {
        this.onDidChangeChatSessionItemsEmitter.fire();
      }),
    );
  }

  provideChatSessionItems(): vscode.ChatSessionItem[] {
    return this.options.agentRegistry
      .list()
      .map((agent) => this.createSessionItem(agent));
  }

  // Support delegated session creation. This optional hook is used by VS Code when a
  // delegated provider (contributed with "canDelegate": true) is asked to create
  // a new session. We present a quick pick of available agents and return the selected item.
  async provideNewChatSessionItem(
    options: { readonly request: vscode.ChatRequest; metadata?: any },
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatSessionItem | undefined> {
    const agents = this.options.agentRegistry
      .list()
      .filter((a) => a.enabled !== false);
    if (!agents.length) {
      return undefined;
    }

    const picks = agents.map((a) => ({
      label: a.label,
      description: a.description,
      agent: a,
    }));

    const selection = await vscode.window.showQuickPick(picks, {
      placeHolder: "Select an ACP agent to start a new session",
      ignoreFocusOut: true,
    });

    if (!selection || token.isCancellationRequested) {
      return undefined;
    }

    return this.createSessionItem(selection.agent);
  }

  createSessionItem(agent: AgentRegistryEntry): vscode.ChatSessionItem {
    // public helper so external code (extension) can create a compatible item
    // with the same shape as provideChatSessionItems returned items.

    // public helper so external code (extension) can create a compatible item
    // with the same shape as provideChatSessionItems returned items.

    const resource = createChatSessionUri(agent.id);
    const iconPath = agent.icon ? new vscode.ThemeIcon(agent.icon) : undefined;
    return {
      resource,
      label: agent.label,
      description: agent.description,
      iconPath,
      status: vscode.ChatSessionStatus.Completed,
    } satisfies vscode.ChatSessionItem;
  }

  /**
   * Request that the UI replace an original (untitled) chat session item with a modified one.
   * The extension can call this after creating any necessary session state so the UI will
   * re-resolve content against the final resource.
   */
  commitReplacement(
    original: vscode.ChatSessionItem,
    modified: vscode.ChatSessionItem,
  ): void {
    this.onDidCommitChatSessionItemEmitter.fire({ original, modified });
  }
}
