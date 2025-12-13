import * as vscode from "vscode";
import {
  AcpSessionStore,
  AcpSessionRecord,
  toSessionResource,
} from "./acpServices";
import { DisposableBase } from "./disposables";

export class AcpChatSessionItemProvider
  extends DisposableBase
  implements vscode.ChatSessionItemProvider
{
  private readonly onDidChangeEmitter = this._register(
    new vscode.EventEmitter<void>(),
  );
  public readonly onDidChangeChatSessionItems: vscode.Event<void> =
    this.onDidChangeEmitter.event;
  private readonly onDidCommitEmitter = this._register(
    new vscode.EventEmitter<{
      original: vscode.ChatSessionItem;
      modified: vscode.ChatSessionItem;
    }>(),
  );
  public readonly onDidCommitChatSessionItem = this.onDidCommitEmitter.event;

  constructor(private readonly sessionStore: AcpSessionStore) {
    super();
    this._register(
      this.sessionStore.onDidChangeSessions(() => this.notifySessionsChange()),
    );
  }

  notifySessionsChange(): void {
    this.onDidChangeEmitter.fire();
  }

  swap(
    original: vscode.ChatSessionItem,
    modified: vscode.ChatSessionItem,
  ): void {
    this.onDidCommitEmitter.fire({ original, modified });
  }

  async provideChatSessionItems(
    _token: vscode.CancellationToken,
  ): Promise<vscode.ChatSessionItem[]> {
    const sessions = await this.sessionStore.listSessions();
    return sessions.map((session) => this.toItem(session));
  }

  private toItem(session: AcpSessionRecord): vscode.ChatSessionItem {
    const item: vscode.ChatSessionItem = {
      resource: toSessionResource(session.id),
      label: session.label,
      timing: {
        startTime: session.createdAt,
        endTime: session.status === "completed" ? session.updatedAt : undefined,
      },
    };
    if (session.status === "completed") {
      item.status = vscode.ChatSessionStatus.Completed;
    } else if (session.status === "running") {
      item.status = vscode.ChatSessionStatus.InProgress;
    }
    return item;
  }
}
