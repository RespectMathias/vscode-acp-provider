/// <reference path="../vscode.proposed.chatSessionsProvider.d.ts" />
import * as vscode from "vscode";
import {
  ACP_SESSION_SCHEME,
  AcpAgentConfigurationService,
  AcpClientManager,
  AcpSessionStore,
} from "./acpServices";
import {
  ACP_SESSION_TYPE,
  AcpChatSessionParticipant,
} from "./acpChatSessionParticipant";
import { AcpChatSessionContentProvider } from "./acpChatSessionContentProvider";
import { AcpChatSessionItemProvider } from "./acpChatSessionItemProvider";

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("ACP Client");
  context.subscriptions.push(outputChannel);

  const agentConfiguration = new AcpAgentConfigurationService((removedIds) => {
    void sessionStore.cleanupRemovedAgents(removedIds);
  });
  const clientManager = new AcpClientManager(agentConfiguration, outputChannel);
  const sessionStore = new AcpSessionStore(
    context,
    agentConfiguration,
    clientManager,
    outputChannel,
  );
  const itemProvider = new AcpChatSessionItemProvider(sessionStore);
  const contentProvider = new AcpChatSessionContentProvider(
    sessionStore,
    agentConfiguration,
  );
  const participant = new AcpChatSessionParticipant(
    sessionStore,
    itemProvider,
    contentProvider,
    agentConfiguration,
    outputChannel,
  );

  context.subscriptions.push(
    agentConfiguration,
    clientManager,
    sessionStore,
    itemProvider,
    contentProvider,
    participant,
  );

  // Restore persisted sessions from workspace storage
  await sessionStore.restoreSessions();

  const participantHandler = participant.createHandler();
  contentProvider.setRequestHandler(participantHandler);
  const chatParticipant = vscode.chat.createChatParticipant(
    ACP_SESSION_TYPE,
    participantHandler,
  );

  context.subscriptions.push(
    vscode.chat.registerChatSessionItemProvider(ACP_SESSION_TYPE, itemProvider),
  );
  context.subscriptions.push(
    vscode.chat.registerChatSessionContentProvider(
      ACP_SESSION_SCHEME,
      contentProvider,
      chatParticipant,
    ),
  );

  const restartCommand = vscode.commands.registerCommand(
    "vscodeAcpClient.restart",
    async () => {
      await clientManager.reset();
      sessionStore.clear();
      vscode.window.showInformationMessage("ACP chat clients restarted");
    },
  );
  context.subscriptions.push(restartCommand);
}

export function deactivate(): void {
  // Resources are disposed via the extension context subscriptions.
}
