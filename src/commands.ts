import * as vscode from "vscode";
import { SessionStore } from "./acpSessionStore";
import { getWorkspaceCwd } from "./permittedPaths";

export function registerCommands(
  context: vscode.ExtensionContext,
  dependencies: {
    sessionStore: SessionStore;
  },
  outputChannel: vscode.LogOutputChannel,
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("acp.clearSessions", async () => {
      try {
        const cwd = getWorkspaceCwd();
        if (!cwd) {
          vscode.window.showWarningMessage(
            "Open a workspace to clear ACP sessions.",
          );
          return;
        }
        await dependencies.sessionStore.deleteAllSessions(cwd);
        vscode.window.showInformationMessage(
          "All ACP sessions have been cleared.",
        );
      } catch (error) {
        outputChannel.error(`Error clearing sessions: ${error}`);
        vscode.window.showErrorMessage(
          "Failed to clear ACP sessions. Check output for details.",
        );
      }
    }),
  );
}
