/// <reference path="../vscode.proposed.chatSessionsProvider.d.ts" />
import * as vscode from "vscode";
import { AcpPermissionHandler } from "./acpClient";
import { AgentRegistry } from "./agentRegistry";
import { SessionManager } from "./sessionManager";
import { AcpChatSessionItemProvider } from "./acpChatSessionItemProvider";
import { ACP_CHAT_SCHEME, ACP_CHAT_SESSION_TYPE } from "./chatIdentifiers";
import { AcpChatSessionContentProvider } from "./acpChatSessionContentProvider";
import { AcpChatParticipant } from "./acpChatParticipant";
import {
  PermissionPromptManager,
  RESOLVE_PERMISSION_COMMAND,
} from "./permissionPrompts";

let agentRegistry: AgentRegistry | undefined;
let sessionManager: SessionManager | undefined;
let permissionHandler: AcpPermissionHandler;
let permissionPrompts: PermissionPromptManager | undefined;
let resolvePermissionCommand: vscode.Disposable | undefined;
let contentProvider: AcpChatSessionContentProvider | undefined;
let chatParticipant: AcpChatParticipant | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("ACP Client");
  context.subscriptions.push(outputChannel);

  permissionPrompts = new PermissionPromptManager();
  context.subscriptions.push(permissionPrompts);

  permissionHandler = permissionPrompts;

  const registry = (agentRegistry = new AgentRegistry());
  const manager = (sessionManager = new SessionManager(
    outputChannel,
    permissionHandler,
    permissionPrompts,
  ));
  context.subscriptions.push(registry, manager);

  const itemProvider = new AcpChatSessionItemProvider({
    agentRegistry: registry,
  });
  context.subscriptions.push(itemProvider);
  context.subscriptions.push(
    vscode.chat.registerChatSessionItemProvider(
      ACP_CHAT_SESSION_TYPE,
      itemProvider,
    ),
  );

  const participant = (chatParticipant = new AcpChatParticipant(
    manager,
    permissionPrompts,
  ));
  const sessionContentProvider = (contentProvider =
    new AcpChatSessionContentProvider({
      sessionManager: manager,
      agentRegistry: registry,
    }));
  context.subscriptions.push(participant, sessionContentProvider);
  context.subscriptions.push(
    vscode.chat.registerChatSessionContentProvider(
      ACP_CHAT_SCHEME,
      sessionContentProvider,
      participant.participant,
    ),
  );

  resolvePermissionCommand = vscode.commands.registerCommand(
    RESOLVE_PERMISSION_COMMAND,
    (payload) => {
      permissionPrompts?.resolveFromCommand(payload);
    },
  );
  context.subscriptions.push(resolvePermissionCommand);

  const restartCommand = vscode.commands.registerCommand(
    "vscodeAcpClient.restart",
    async () => {
      disposeAllSessions();
      vscode.window.showInformationMessage(
        "ACP chat sessions restarted. Open a session to reconnect.",
      );
    },
  );
  context.subscriptions.push(restartCommand);

  context.subscriptions.push(
    registry.onDidChange(() => {
      disposeAllSessions();
    }),
  );

  context.subscriptions.push(
    new vscode.Disposable(() => {
      disposeAllSessions();
    }),
  );
}

export function deactivate(): void {
  disposeAllSessions();
}

function disposeAllSessions(): void {
  resolvePermissionCommand?.dispose();
  resolvePermissionCommand = undefined;
  contentProvider?.reset();
  sessionManager?.disposeAll();
}
