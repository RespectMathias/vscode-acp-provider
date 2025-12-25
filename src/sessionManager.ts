import * as vscode from "vscode";
import { AcpClient, AcpPermissionHandler } from "./acpClient";
import { SessionState, SessionStateImpl } from "./sessionState";
import { AgentRegistryEntry } from "./agentRegistry";
import { DisposableBase } from "./disposables";
import { PermissionPromptManager } from "./permissionPrompts";

export class SessionManager extends DisposableBase {
  private readonly sessions = new Map<string, SessionState>();

  constructor(
    private readonly logChannel: vscode.OutputChannel,
    private readonly permissionHandler: AcpPermissionHandler,
    private readonly permissionPrompts?: PermissionPromptManager,
  ) {
    super();
  }

  createSessionState(
    agent: AgentRegistryEntry,
    vscodeResource: vscode.Uri,
  ): SessionState {
    const key = vscodeResource.toString();
    let existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }

    const client = new AcpClient(
      agent,
      this.permissionHandler,
      this.logChannel,
    );
    const state = new SessionStateImpl(agent, vscodeResource, client);
    state.add(
      this._register(
        new vscode.Disposable(() => {
          if (this.sessions.get(key) === state) {
            this.sessions.delete(key);
          }
          this.clearPermissionContext(state);
        }),
      ),
    );
    this.sessions.set(key, state);
    return state;
  }

  get(resource: vscode.Uri): SessionState | undefined {
    return this.sessions.get(resource.toString());
  }

  /**
   * Lookup by a value that may be a Uri, a string key, or a partial resource object.
   * Used defensively when callers may provide non-Uri objects from VS Code.
   */
  getByKey(resourceLike: unknown): SessionState | undefined {
    const key = this.toKey(resourceLike);
    if (!key) {
      return undefined;
    }
    return this.sessions.get(key);
  }

  release(resource: vscode.Uri): void {
    const key = resource.toString();
    const state = this.sessions.get(key);
    if (!state) {
      return;
    }
    this.clearPermissionContext(state);
    state.dispose();
    this.sessions.delete(key);
  }

  private toKey(resourceLike: unknown): string | undefined {
    try {
      if (!resourceLike) return undefined;
      if (
        (resourceLike as any).toString &&
        typeof (resourceLike as any).toString === "function"
      ) {
        // Prefer Uri-like objects
        const asStr = String((resourceLike as any).toString());
        if (asStr) return asStr;
      }
      // Try Uri.from shape
      if (typeof resourceLike === "object") {
        const r = resourceLike as any;
        const scheme = String(r.scheme ?? "");
        const authority = String(r.authority ?? "");
        const path = String(r.path ?? "");
        if (scheme || authority || path) {
          return vscode.Uri.from({ scheme, authority, path }).toString();
        }
      }
      if (typeof resourceLike === "string") {
        return resourceLike;
      }
    } catch {
      /* noop */
    }
    return undefined;
  }

  disposeAll(): void {
    for (const state of this.sessions.values()) {
      this.clearPermissionContext(state);
      state.dispose();
    }
    this.sessions.clear();
  }

  override dispose(): void {
    this.disposeAll();
    super.dispose();
  }

  private clearPermissionContext(state: SessionState): void {
    if (!state.acpSessionId) {
      return;
    }
    this.permissionPrompts?.clearSession(state.acpSessionId);
  }
}
