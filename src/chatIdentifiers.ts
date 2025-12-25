import * as vscode from "vscode";

export const ACP_CHAT_SCHEME = "acp";
export const ACP_CHAT_SESSION_TYPE = "acp";

export function createChatSessionUri(agentId: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: ACP_CHAT_SCHEME,
    authority: agentId,
    path: "/session",
  });
}

export function getAgentIdFromResource(
  resource: vscode.Uri,
): string | undefined {
  if (resource.scheme !== ACP_CHAT_SCHEME) {
    return undefined;
  }
  if (resource.authority) {
    return resource.authority;
  }
  const normalizedPath = resource.path.replace(/^\/+/, "");
  return normalizedPath || undefined;
}
