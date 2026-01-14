// SPDX-License-Identifier: Apache-2.0
import {
  ContentBlock,
  SessionNotification,
  ToolCall,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import { buildDiffMarkdown, getToolInfo } from "./chatRenderingUtils";

/**
 * Builds VS Code chat turns from ACP session notification events.
 */
export class TurnBuilder {
  private currentUserMessage = "";
  private currentUserReferences: vscode.ChatPromptReference[] = [];
  private currentAgentParts: (vscode.ChatResponsePart | vscode.ChatToolInvocationPart)[] = [];
  private currentAgentMetadata: Record<string, unknown> = {};
  private agentMessageChunks: string[] = [];
  private turns: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> = [];
  private readonly participantId: string;
  private readonly toolTitles = new Map<string, string>();


  constructor(participantId: string) {
    this.participantId = participantId;
  }

  processNotification(notification: SessionNotification): void {
    const update = notification.update;

    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        this.flushPendingAgentMessage();
        this.captureUserMessageChunk(update.content);
        break;
      }

      case "agent_message_chunk": {
        this.flushPendingUserMessage();
        this.captureAgentMessageChunk(update.content);
        break;
      }

      case "agent_thought_chunk": {
        this.flushPendingUserMessage();
        this.flushAgentMessageChunksToMarkdown();

        const thought = this.getContentText(update.content);
        if (thought?.trim()) {
          this.currentAgentParts.push(
            new vscode.ChatResponseProgressPart(thought.trim()),
          );
        }
        break;
      }

      case "tool_call": {
        this.flushPendingUserMessage();
        this.flushAgentMessageChunksToMarkdown();
        this.appendToolCall(update as ToolCall);
        break;
      }

      case "tool_call_update": {
        this.flushPendingUserMessage();
        this.flushAgentMessageChunksToMarkdown();
        this.appendToolUpdate(update as ToolCallUpdate);
        break;
      }

      case "plan": {
        this.flushPendingUserMessage();
        this.flushAgentMessageChunksToMarkdown();
        this.appendPlanEntries(update.entries);
        break;
      }

      // Ignore other session update types for history
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
        break;
    }
  }

  getTurns(): Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> {
    this.flushPendingUserMessage();
    this.flushPendingAgentMessage();

    return [...this.turns];
  }

  reset(): void {
    this.currentUserMessage = "";
    this.currentUserReferences = [];
    this.currentAgentParts = [];
    this.currentAgentMetadata = {};
    this.agentMessageChunks = [];
    this.turns = [];
  }

  private captureUserMessageChunk(content?: ContentBlock): void {
    const text = this.getContentText(content);
    if (!text) {
      return;
    }

    const normalized = text.startsWith("User:")
      ? text.replace(/^User:\s*/, "")
      : text;
    this.currentUserMessage += normalized;
  }

  private captureAgentMessageChunk(content?: ContentBlock): void {
    const text = this.getContentText(content);
    if (text) {
      this.agentMessageChunks.push(text);
    }
  }

  private appendToolCall(update: ToolCall): void {
    const info = getToolInfo(update);
    this.toolTitles.set(update.toolCallId, info.name);
  }

  private appendToolUpdate(update: ToolCallUpdate): void {
    if (update.status !== "completed" && update.status !== "failed") {
      return;
    }

    const toolName = this.toolTitles.get(update.toolCallId) ?? "unknown tool call";
    this.currentAgentParts.push(new vscode.ChatToolInvocationPart(toolName, update.toolCallId, update.status === "failed")); 

    if (!update.content?.length) {
      return;
    }

    for (const content of update.content) {
      if (content.type !== "diff") {
        continue;
      }

      const diffMarkdown = buildDiffMarkdown(
        content.path,
        content.oldText ?? undefined,
        content.newText ?? undefined,
      );
      if (!diffMarkdown) {
        continue;
      }
      this.currentAgentParts.push(
        new vscode.ChatResponseMarkdownPart(diffMarkdown),
      );
    }
  }

  private appendPlanEntries(
    entries: Array<{ content: string; status?: string }>,
  ): void {
    if (!entries.length) {
      return;
    }

    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown("## Plan\n");
    for (const entry of entries) {
      const checkbox = entry.status === "completed" ? "x" : " ";
      markdown.appendMarkdown(`-  [${checkbox}] ${entry.content}\n`);
    }
    this.currentAgentParts.push(new vscode.ChatResponseMarkdownPart(markdown));
  }

  private flushPendingUserMessage(): void {
    if (!this.currentUserMessage.trim()) {
      return;
    }

    this.turns.push(
      new vscode.ChatRequestTurn2(
        this.currentUserMessage,
        undefined,
        this.currentUserReferences,
        this.participantId,
        [],
        undefined,
      ),
    );
    this.currentUserMessage = "";
    this.currentUserReferences = [];
  }

  private flushPendingAgentMessage(): void {
    this.flushAgentMessageChunksToMarkdown();

    if (!this.currentAgentParts.length) {
      return;
    }

    this.turns.push(
      new vscode.ChatResponseTurn2(
        this.currentAgentParts,
        { metadata: this.currentAgentMetadata },
        this.participantId,
      ),
    );
    this.currentAgentParts = [];
    this.currentAgentMetadata = {};
  }

  private flushAgentMessageChunksToMarkdown(): void {
    if (!this.agentMessageChunks.length) {
      return;
    }

    const content = this.agentMessageChunks.join("").trim();
    this.agentMessageChunks = [];
    if (!content) {
      return;
    }

    const markdown = new vscode.MarkdownString(content);
    this.currentAgentParts.push(new vscode.ChatResponseMarkdownPart(markdown));
  }

  private getContentText(content?: ContentBlock): string | undefined {
    if (!content) {
      return undefined;
    }
    if (content.type === "text") {
      return content.text;
    }
    return undefined;
  }
}
