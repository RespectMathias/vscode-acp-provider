export interface AcpAgentConfigurationEntry {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly icon?: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly enabled?: boolean;
}

export const VscodeToolNames = {
  VscodeGetConfirmation: "vscode_get_confirmation",
};
