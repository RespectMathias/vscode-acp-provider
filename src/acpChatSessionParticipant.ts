/// <reference path="../vscode.proposed.chatSessionsProvider.d.ts" />
import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import {
  AcpAgentConfigurationService,
  AcpSessionStore,
  toSessionResource,
  tryGetSessionId,
} from "./acpServices";
import { DisposableBase, DisposableStore } from "./disposables";
import { AcpChatSessionItemProvider } from "./acpChatSessionItemProvider";
import { AcpChatSessionContentProvider } from "./acpChatSessionContentProvider";

export const AGENT_OPTION_ID = "agent";

export const ACP_SESSION_TYPE = "acp";

export const PENDING_SELECTION_TTL_MS = 5 * 60 * 1000;

export type PendingAgentSelection = {
  agentId: string;
  timestamp: number;
};

export class AcpChatSessionParticipant extends DisposableBase {
  constructor(
    private readonly sessionStore: AcpSessionStore,
    private readonly itemProvider: AcpChatSessionItemProvider,
    private readonly contentProvider: AcpChatSessionContentProvider,
    private readonly agentConfiguration: AcpAgentConfigurationService,
    private readonly logChannel: vscode.OutputChannel,
  ) {
    super();
  }

  createHandler(): vscode.ChatRequestHandler {
    return this.handleRequest.bind(this);
  }

  private async handleRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult | void> {
    const chatContext = context.chatSessionContext;
    if (!chatContext) {
      this.emitError(
        stream,
        vscode.l10n.t(
          "ACP sessions can only be invoked from the ACP chat view.",
        ),
      );
      return {};
    }
    const resource = chatContext.chatSessionItem.resource;
    let sessionId = tryGetSessionId(resource);
    let session = sessionId
      ? await this.sessionStore.getSession(sessionId)
      : undefined;

    let agentId = session?.agentId;
    if (!agentId) {
      agentId =
        this.contentProvider.getPendingAgent(resource) ??
        this.agentConfiguration.getDefaultAgent()?.id;
    }
    if (!agentId) {
      this.emitError(
        stream,
        vscode.l10n.t(
          "No ACP agents are configured. Configure acpClient.agents and try again.",
        ),
      );
      return {};
    }

    if (!session) {
      session = await this.sessionStore.createSession(
        agentId,
        request.prompt,
        undefined,
      );
      const newResource = toSessionResource(session.id);
      this.itemProvider.swap(chatContext.chatSessionItem, {
        resource: newResource,
        label: session.label,
        timing: { startTime: session.createdAt },
      });
      this.itemProvider.notifySessionsChange();
      this.contentProvider.clearPendingSelection(resource);
      sessionId = session.id;
    }

    const blocks = this.buildPromptBlocks(request);
    if (!blocks.length) {
      this.emitError(stream, vscode.l10n.t("Prompt content is required."));
      return {};
    }

    const requestTurn: vscode.ChatRequestTurn = {
      prompt: request.prompt ?? "",
      participant: `${ACP_SESSION_TYPE}/${session.agentId}`,
      references: [],
      toolReferences: [],
    };
    this.sessionStore.appendToHistory(session.id, requestTurn);

    const responseContent: string[] = [];
    const disposables = new DisposableStore();
    this.sessionStore.updateSessionStatus(session.id, "running");
    const updateListener = session.client.onSessionUpdate((notification) => {
      if (notification.sessionId === session?.id) {
        this.renderUpdate(notification.update, stream, responseContent);
      }
    });
    disposables.add(updateListener);
    const cancellation = token.onCancellationRequested(() => {
      void session?.client.cancel(session!.id);
    });
    disposables.add(cancellation);

    try {
      await session.client.prompt(session.id, blocks);
      stream.markdown(vscode.l10n.t("Agent completed the request."));

      const responseTurn: vscode.ChatResponseTurn = {
        participant: `${ACP_SESSION_TYPE}/${session.agentId}`,
        response: [
          new vscode.ChatResponseMarkdownPart(responseContent.join("")),
        ],
        result: { metadata: { command: "success" } },
      };
      this.sessionStore.appendToHistory(session.id, responseTurn);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logChannel.appendLine(
        `[acp:${session.id}] request failed: ${message}`,
      );
      this.emitError(stream, message);

      const errorTurn: vscode.ChatResponseTurn = {
        participant: `${ACP_SESSION_TYPE}/${session.agentId}`,
        response: [new vscode.ChatResponseMarkdownPart(`$(error) ${message}`)],
        result: { errorDetails: { message } },
      };
      this.sessionStore.appendToHistory(session.id, errorTurn);
    } finally {
      this.sessionStore.updateSessionStatus(session.id, "idle");
      disposables.dispose();
    }

    return {};
  }

  private buildPromptBlocks(request: vscode.ChatRequest): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    if (request.prompt?.trim()) {
      blocks.push({ type: "text", text: request.prompt });
    }
    return blocks;
  }

  private renderUpdate(
    update: SessionUpdate,
    stream: vscode.ChatResponseStream,
    responseContent: string[],
  ): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          responseContent.push(update.content.text);
          stream.markdown(update.content.text);
        }
        break;
      case "agent_thought_chunk":
        if (update.content.type === "text") {
          const thought = `*${update.content.text}*`;
          responseContent.push(thought);
          stream.markdown(thought);
        }
        break;
      case "tool_call": {
        const statusText = update.status ? ` (${update.status})` : "";
        const toolMsg = vscode.l10n.t(
          "$(tools) {0}{1}",
          update.title,
          statusText,
        );
        responseContent.push(toolMsg);
        stream.markdown(toolMsg);
        break;
      }
      case "tool_call_update":
        stream.progress(
          vscode.l10n.t(
            "{0}: {1}",
            update.toolCallId,
            update.status ?? "updated",
          ),
        );
        break;
      case "plan": {
        const entries =
          update.entries?.map((entry) => {
            const status = entry.status ? ` (${entry.status})` : "";
            return `- ${entry.content}${status}`;
          }) ?? [];
        if (entries.length) {
          const planMsg = [vscode.l10n.t("Plan:"), ...entries].join("\n");
          responseContent.push(planMsg);
          stream.markdown(planMsg);
        }
        break;
      }
      default:
        break;
    }
  }

  private emitError(stream: vscode.ChatResponseStream, message: string): void {
    stream.markdown(`$(error) ${message}`);
  }
}
