import * as vscode from "vscode";
import { DisposableStore } from "./disposables";
import { AcpAgentConfigurationEntry } from "./types";

export interface AgentRegistryEntry extends AcpAgentConfigurationEntry {
  readonly label: string;
}

export class AgentRegistry extends DisposableStore {
  private readonly agents = new Map<string, AgentRegistryEntry>();
  private readonly onDidChangeEmitter = this.add(
    new vscode.EventEmitter<void>(),
  );
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor() {
    super();
    this.reload();
    this.add(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("acpClient.agents")) {
          this.reload();
        }
      }),
    );
  }

  get(agentId: string): AgentRegistryEntry | undefined {
    return this.agents.get(agentId);
  }

  list(): readonly AgentRegistryEntry[] {
    return Array.from(this.agents.values());
  }

  private reload(): void {
    this.agents.clear();
    const configuration = vscode.workspace.getConfiguration("acpClient");
    const entries = configuration.get<readonly AcpAgentConfigurationEntry[]>(
      "agents",
      [],
    );

    for (const entry of entries) {
      if (!entry.id || !entry.command) {
        continue;
      }
      if (entry.enabled === false) {
        continue;
      }

      const normalized: AgentRegistryEntry = {
        ...entry,
        label: entry.title ?? entry.id,
        args: entry.args ?? [],
        enabled: entry.enabled ?? true,
      };
      this.agents.set(entry.id, normalized);
    }

    this.onDidChangeEmitter.fire();
  }
}
