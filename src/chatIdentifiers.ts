import * as vscode from "vscode";

export const ACP_CHAT_SCHEME = "acp";

export function getAgentIdFromResource(
  resource: vscode.Uri,
): string | undefined {
  if (!resource.scheme || !resource.scheme.startsWith(ACP_CHAT_SCHEME)) {
    return undefined;
  }
  return resource.scheme.substring(ACP_CHAT_SCHEME.length + 1);
}

export function createSessionType(agentId: string): string {
  return `${ACP_CHAT_SCHEME}-${agentId}`;
}

export function getSessionId(resource: vscode.Uri): string {
  return resource.authority;
}

export function createSessionUri(agentId: string, sessionId: string) {
  return vscode.Uri.parse(`${createSessionType(agentId)}://${sessionId}`);
}
