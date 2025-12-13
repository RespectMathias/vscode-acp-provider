import * as vscode from "vscode";
import {
  PendingAgentSelection,
  PENDING_SELECTION_TTL_MS,
  AGENT_OPTION_ID,
} from "./acpChatSessionParticipant";
import {
  AcpSessionStore,
  AcpAgentConfigurationService,
  tryGetSessionId,
} from "./acpServices";
import { DisposableBase } from "./disposables";

export class AcpChatSessionContentProvider
  extends DisposableBase
  implements vscode.ChatSessionContentProvider
{
  private readonly onDidChangeOptionsEmitter = this._register(
    new vscode.EventEmitter<vscode.ChatSessionOptionChangeEvent>(),
  );
  public readonly onDidChangeChatSessionOptions: vscode.Event<vscode.ChatSessionOptionChangeEvent> =
    this.onDidChangeOptionsEmitter.event;
  private readonly pendingAgentSelections = new Map<
    string,
    PendingAgentSelection
  >();
  private readonly cleanupTimer: NodeJS.Timeout;
  private requestHandler?: vscode.ChatRequestHandler;

  constructor(
    private readonly sessionStore: AcpSessionStore,
    private readonly agentConfiguration: AcpAgentConfigurationService,
  ) {
    super();
    this.cleanupTimer = setInterval(
      () => this.prunePendingSelections(),
      PENDING_SELECTION_TTL_MS,
    );
    this._register({ dispose: () => clearInterval(this.cleanupTimer) });
  }

  setRequestHandler(handler: vscode.ChatRequestHandler): void {
    this.requestHandler = handler;
  }

  clearPendingSelection(resource: vscode.Uri): void {
    this.pendingAgentSelections.delete(resource.toString());
  }

  getPendingAgent(resource: vscode.Uri): string | undefined {
    this.prunePendingSelections();
    const entry = this.pendingAgentSelections.get(resource.toString());
    return entry?.agentId;
  }

  notifyOptionChange(
    resource: vscode.Uri,
    optionId: string,
    value: string,
  ): void {
    this.onDidChangeOptionsEmitter.fire({
      resource,
      updates: [{ optionId, value }],
    });
  }

  async provideChatSessionContent(
    resource: vscode.Uri,
    _token: vscode.CancellationToken,
  ): Promise<vscode.ChatSession> {
    const sessionId = tryGetSessionId(resource);
    const options: Record<string, string> = {};
    let history: Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn> = [];

    if (sessionId) {
      const session = await this.sessionStore.getSession(sessionId);
      if (session) {
        options[AGENT_OPTION_ID] = session.agentId;
        history = session.history ?? [];
      } else {
        this.addDefaultAgentOption(options);
      }
    } else {
      const pendingAgent = this.getPendingAgent(resource);
      if (pendingAgent) {
        options[AGENT_OPTION_ID] = pendingAgent;
      } else {
        this.addDefaultAgentOption(options);
      }
    }
    return {
      history,
      options,
      requestHandler: this.requestHandler,
      activeResponseCallback: undefined,
    };
  }

  async provideChatSessionProviderOptions(
    _token: vscode.CancellationToken,
  ): Promise<vscode.ChatSessionProviderOptions> {
    const agents = this.agentConfiguration.getAgents();
    const items: vscode.ChatSessionProviderOptionItem[] = agents.map(
      (agent) => ({ id: agent.id, name: agent.title }),
    );
    return {
      optionGroups: [
        {
          id: AGENT_OPTION_ID,
          name: vscode.l10n.t("Agent"),
          description: vscode.l10n.t("Choose which ACP agent to use"),
          items,
        },
      ],
    };
  }

  async provideHandleOptionsChange(
    resource: vscode.Uri,
    updates: readonly vscode.ChatSessionOptionUpdate[],
    _token: vscode.CancellationToken,
  ): Promise<void> {
    for (const update of updates) {
      if (
        update.optionId === AGENT_OPTION_ID &&
        typeof update.value === "string"
      ) {
        this.pendingAgentSelections.set(resource.toString(), {
          agentId: update.value,
          timestamp: Date.now(),
        });
      }
    }
  }

  private addDefaultAgentOption(options: Record<string, string>): void {
    const defaultAgent = this.agentConfiguration.getDefaultAgent();
    if (defaultAgent) {
      options[AGENT_OPTION_ID] = defaultAgent.id;
    }
  }

  private prunePendingSelections(): void {
    const expiration = Date.now() - PENDING_SELECTION_TTL_MS;
    for (const [key, entry] of this.pendingAgentSelections.entries()) {
      if (entry.timestamp < expiration) {
        this.pendingAgentSelections.delete(key);
      }
    }
  }
}
