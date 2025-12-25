import * as vscode from "vscode";
import { AcpClient } from "./acpClient";
import { DisposableStore } from "./disposables";
import { AgentRegistryEntry } from "./agentRegistry";

export interface SessionState extends vscode.Disposable {
  readonly agent: AgentRegistryEntry;
  readonly vscodeResource: vscode.Uri;
  readonly client: AcpClient;
  acpSessionId?: string;
  status: "idle" | "running" | "error";
  pendingRequest?: {
    cancellation: vscode.CancellationTokenSource;
    permissionContext?: vscode.Disposable;
  };
}

export class SessionStateImpl extends DisposableStore implements SessionState {
  public acpSessionId: string | undefined;
  public status: SessionState["status"] = "idle";
  public pendingRequest: SessionState["pendingRequest"] | undefined;

  constructor(
    public readonly agent: AgentRegistryEntry,
    public readonly vscodeResource: vscode.Uri,
    public readonly client: AcpClient,
  ) {
    super();
    this.add(client);
  }
}
