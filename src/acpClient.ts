// SPDX-License-Identifier: Apache-2.0
import {
  AgentCapabilities,
  Client,
  ClientCapabilities,
  ClientSideConnection,
  ContentBlock,
  InitializeResponse,
  LoadSessionResponse,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptResponse,
  PROTOCOL_VERSION,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionModelState,
  SessionModeState,
  McpServer,
  McpServerStdio,
  SessionNotification,
  SetSessionModelRequest,
  SetSessionModeRequest,
} from "@agentclientprotocol/sdk";
import {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  spawn,
} from "node:child_process";
import path from "path";
import { TextDecoder, TextEncoder } from "node:util";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as vscode from "vscode";
import { AgentRegistryEntry } from "./agentRegistry";
import type { AcpMcpServerConfiguration } from "./types";
import { DisposableBase } from "./disposables";

export interface AcpPermissionHandler {
  requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse>;
}

const CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: {
    readTextFile: true,
    writeTextFile: true,
  },
  terminal: true,
};

const CLIENT_INFO = {
  name: "github-copilot-acp-client",
  version: "1.0.0",
};

export interface AcpClient extends Client, vscode.Disposable {
  onSessionUpdate: vscode.Event<SessionNotification>;
  onDidStop: vscode.Event<void>;
  onDidStart: vscode.Event<void>;
  onDidOptionsChanged: vscode.Event<void>;

  getCapabilities(): AgentCapabilities;
  createSession(
    cwd: string,
    mcpServers: AgentRegistryEntry["mcpServers"],
  ): Promise<NewSessionResponse>;
  getSupportedModelState(): SessionModelState | null;
  getSupportedModeState(): SessionModeState | null;
  loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: AgentRegistryEntry["mcpServers"],
  ): Promise<{
    modeId: string | undefined;
    modelId: string | undefined;
    notifications: SessionNotification[];
  }>;
  prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  changeMode(sessionId: string, modeId: string): Promise<void>;
  changeModel(sessionId: string, modelId: string): Promise<void>;
}

export function createAcpClient(
  agent: AgentRegistryEntry,
  permissionHandler: AcpPermissionHandler,
  logChannel: vscode.LogOutputChannel,
): AcpClient {
  return new AcpClientImpl(agent, permissionHandler, logChannel);
}

type ClientMode = "new_session" | "load_session";

class AcpClientImpl extends DisposableBase implements AcpClient {
  private agentProcess: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientSideConnection | null = null;
  private readyPromise: Promise<void> | null = null;
  private agentCapabilities?: InitializeResponse;
  private supportedModelState: SessionModelState | null = null;
  private supportedModeState: SessionModeState | null = null;
  private terminalIdCounter = 0;
  private terminals = new Map<string, TerminalState>();
  private readonly textEncoder = new TextEncoder();
  private readonly textDecoder = new TextDecoder("utf-8");
  private readonly allowedWriteSessions = new Set<string>();
  private readonly allowedTerminalSessions = new Set<string>();
  private permissionPromptCounter = 0;

  private readonly onSessionUpdateEmitter = this._register(
    new vscode.EventEmitter<SessionNotification>(),
  );
  public readonly onSessionUpdate: vscode.Event<SessionNotification> =
    this.onSessionUpdateEmitter.event;

  private readonly _onDidStop = this._register(new vscode.EventEmitter<void>());
  public readonly onDidStop: vscode.Event<void> = this._onDidStop.event;

  private readonly _onDidStart = this._register(
    new vscode.EventEmitter<void>(),
  );
  public readonly onDidStart: vscode.Event<void> = this._onDidStart.event;

  private readonly _onDidOptionsChanged = this._register(
    new vscode.EventEmitter<void>(),
  );
  public readonly onDidOptionsChanged: vscode.Event<void> =
    this._onDidOptionsChanged.event;

  private mode: ClientMode = "new_session";

  constructor(
    private readonly agent: AgentRegistryEntry,
    private readonly permissionHandler: AcpPermissionHandler,
    private readonly logChannel: vscode.LogOutputChannel,
  ) {
    super();
  }

  async ensureReady(expectedMode: ClientMode): Promise<void> {
    if (this.readyPromise) {
      if (this.mode === expectedMode) {
        return this.readyPromise;
      }
    }

    await this.stopProcess();
    this.readyPromise = this.createConnection(expectedMode);
    try {
      await this.readyPromise;
    } catch (error) {
      this.readyPromise = null;
      throw error;
    }
  }

  getCapabilities(): AgentCapabilities {
    return this.agentCapabilities || {};
  }

  async createSession(
    cwd: string,
    mcpServers: AgentRegistryEntry["mcpServers"],
  ): Promise<NewSessionResponse> {
    await this.ensureReady("new_session");

    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }
    // Use native path separators - opencode on Windows expects backslashes
    // Converting to forward slashes makes opencode treat it as a different directory
    const request: NewSessionRequest = {
      cwd: cwd,
      mcpServers: serializeMcpServers(mcpServers),
    };
    this.logChannel.info(`Calling session/new with cwd: ${cwd}`);

    // Add 10 second timeout for faster failure feedback
    const timeoutMs = 10_000;
    let timeoutId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        this.logChannel.error(`session/new timeout fired after ${timeoutMs / 1000}s`);
        reject(new Error(`session/new timed out after ${timeoutMs / 1000}s. Check the ACP Client output for opencode errors.`));
      }, timeoutMs);
      this.logChannel.info(`Timeout set for ${timeoutMs / 1000}s`);
    });

    this.logChannel.info(`Starting Promise.race for session/new...`);
    const racers: Promise<NewSessionResponse>[] = [this.connection.newSession(request), timeoutPromise];
    if (this.agentExitPromise) {
      racers.push(this.agentExitPromise);
    }

    let response: NewSessionResponse;
    try {
      this.logChannel.info(`Awaiting Promise.race with ${racers.length} racers...`);
      response = await Promise.race(racers);
      this.logChannel.info(`Promise.race resolved successfully`);
    } catch (error) {
      this.logChannel.error(`Promise.race rejected: ${error instanceof Error ? error.message : String(error)}`);
      if (timeoutId) clearTimeout(timeoutId);
      // Kill the agent and reset connection on failure so next attempt starts fresh
      this.logChannel.info(`Cleaning up agent process due to error...`);
      await this.stopProcess();
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    this.logChannel.info(`session/new response received: sessionId=${response.sessionId}`);
    this.supportedModeState = response.modes || null;
    this.supportedModelState = response.models || null;

    this._onDidOptionsChanged.fire();

    return response;
  }

  getSupportedModelState(): SessionModelState | null {
    return this.supportedModelState;
  }

  getSupportedModeState(): SessionModeState | null {
    return this.supportedModeState;
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: AgentRegistryEntry["mcpServers"],
  ): Promise<{
    modeId: string | undefined;
    modelId: string | undefined;
    notifications: SessionNotification[];
  }> {
    await this.ensureReady("load_session");
    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }

    const notifications: SessionNotification[] = [];

    const subscription = this.onSessionUpdate((notification) => {
      if (notification.sessionId === sessionId) {
        // Capture all session update types for history reconstruction
        notifications.push(notification);
      }
    });

    try {
      const response: LoadSessionResponse = await this.connection.loadSession({
        sessionId,
        cwd,
        mcpServers: serializeMcpServers(mcpServers),
      });

      this.supportedModelState = response.models || null;
      this.supportedModeState = response.modes || null;
      this._onDidOptionsChanged.fire();

      return {
        modelId: response.models?.currentModelId,
        modeId: response.modes?.currentModeId,
        notifications: notifications,
      };
    } finally {
      subscription.dispose();
    }
  }

  async prompt(
    sessionId: string,
    prompt: ContentBlock[],
  ): Promise<PromptResponse> {
    await this.ensureReady(this.mode);
    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }
    return this.connection.prompt({
      sessionId,
      prompt,
    });
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.connection) {
      return;
    }
    try {
      await this.connection.cancel({
        sessionId,
        requestId: "",
      });
    } catch (error) {
      this.logChannel.appendLine(
        `[acp:${this.agent.id}] failed to cancel session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.permissionHandler.requestPermission(request);
  }

  async sessionUpdate(notification: SessionNotification): Promise<void> {
    this.onSessionUpdateEmitter.fire(notification);
  }

  async changeMode(sessionId: string, modeId: string): Promise<void> {
    await this.ensureReady(this.mode);
    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }
    const resuest: SetSessionModeRequest = {
      modeId,
      sessionId,
    };
    await this.connection.setSessionMode(resuest);
  }

  async changeModel(sessionId: string, modelId: string): Promise<void> {
    await this.ensureReady(this.mode);
    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }

    const request: SetSessionModelRequest = {
      modelId,
      sessionId,
    };
    await this.connection.unstable_setSessionModel(request);
  }

  async dispose(): Promise<void> {
    await this.stopProcess();
    super.dispose();
  }

  private async ensureAgentRunning(): Promise<void> {
    if (this.agentProcess && !this.agentProcess.killed) {
      return;
    }
    const args = Array.from(this.agent.args ?? []);
    // Add --print-logs to see opencode's internal logs
    if (!args.includes("--print-logs")) {
      args.push("--print-logs");
    }
    this.logChannel.info(
      `Starting agent: ${this.agent.command} ${args.join(" ")}`,
    );
    // Use workspace cwd instead of process.cwd() which would be VS Code's install dir
    const effectiveCwd = this.agent.cwd ?? getWorkspaceCwd() ?? process.cwd();
    this.logChannel.info(`Agent process cwd: ${effectiveCwd}`);
    const agentProc = spawn(this.agent.command, args, {
      cwd: effectiveCwd,
      env: {
        ...process.env,
        ...this.agent.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    agentProc.stderr?.on("data", (data) => {
      // Log at info level so we can see opencode's internal logs
      this.logChannel.info(`agent:${this.agent.id}:stderr ${data.toString().trim()}`);
    });
    agentProc.on("exit", async (code) => {
      this.logChannel.info(
        `agent:${this.agent.id} exited with code ${code ?? "unknown"}`,
      );
      // Reject any pending operations when agent exits
      if (this.agentExitReject) {
        this.agentExitReject(new Error(`Agent process exited unexpectedly with code ${code ?? "unknown"}`));
        this.agentExitReject = null;
      }
      this.connection = null;
      this.readyPromise = null;
      this._onDidStop.fire();
    });
    agentProc.on("error", (error) => {
      this.logChannel.error(
        `agent:${this.agent.id} failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Reject any pending operations when agent fails to start
      if (this.agentExitReject) {
        this.agentExitReject(error instanceof Error ? error : new Error(String(error)));
        this.agentExitReject = null;
      }
    });

    // Create a promise that rejects when the agent exits
    this.agentExitPromise = new Promise<never>((_, reject) => {
      this.agentExitReject = reject;
    });
    this.agentProcess = agentProc;
  }

  private async createConnection(mode: ClientMode): Promise<void> {
    await this.ensureAgentRunning();
    this.logChannel.info(`Agent running, creating connection...`);
    const proc = this.agentProcess;
    if (!proc?.stdin || !proc?.stdout) {
      throw new Error("Failed to connect ACP client streams");
    }

    // Create WritableStream that accepts Uint8Array and writes to stdin
    const stdinStream = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        const text = this.textDecoder.decode(chunk);
        this.logChannel.info(
          `Sending to agent (${chunk.length} bytes): ${text.substring(0, 200)}`,
        );
        return new Promise<void>((resolve, reject) => {
          const ok = proc.stdin!.write(chunk, (err) => {
            if (err) {
              this.logChannel.error(`Write error: ${err.message}`);
              reject(err);
            } else {
              resolve();
            }
          });
          if (!ok) {
            proc.stdin!.once("drain", resolve);
          }
        });
      },
      close: async () => {
        return new Promise<void>((resolve) => {
          proc.stdin!.end(() => resolve());
        });
      },
      abort: async (reason) => {
        proc.stdin!.destroy(
          reason instanceof Error ? reason : new Error(String(reason)),
        );
      },
    });

    // Create ReadableStream that reads from stdout as Uint8Array
    const stdoutStream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        proc.stdout!.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          this.logChannel.info(
            `Received from agent (${chunk.length} bytes): ${text.substring(0, 200)}`,
          );
          controller.enqueue(new Uint8Array(chunk));
        });
        proc.stdout!.on("end", () => {
          this.logChannel.info(`Agent stdout ended`);
          controller.close();
        });
        proc.stdout!.on("error", (err) => {
          this.logChannel.error(`Agent stdout error: ${err.message}`);
          controller.error(err);
        });
      },
      cancel: () => {
        proc.stdout!.destroy();
      },
    });

    const stream = ndJsonStream(stdinStream, stdoutStream);
    this.connection = new ClientSideConnection(() => this, stream);

    this.logChannel.info(`Sending initialize request...`);

    // Add 120 second timeout for initialize
    const initTimeoutMs = 120_000;
    const initTimeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`initialize timed out after ${initTimeoutMs / 1000}s`)), initTimeoutMs);
    });

    const initRacers: Promise<InitializeResponse>[] = [
      this.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES,
        clientInfo: CLIENT_INFO,
      }),
      initTimeoutPromise,
    ];
    if (this.agentExitPromise) {
      initRacers.push(this.agentExitPromise);
    }

    let initResponse: InitializeResponse;
    try {
      initResponse = await Promise.race(initRacers);
    } catch (error) {
      this.logChannel.error(`Initialize failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.stopProcess();
      throw error;
    }
    this.logChannel.info(`Initialize response received`);
    this.agentCapabilities = initResponse.agentCapabilities;
    this._onDidStart.fire();
    this.mode = mode;
  }

  private async stopProcess(): Promise<void> {
    if (this.agentProcess && !this.agentProcess.killed) {
      this.agentProcess.kill();
      await this.connection?.closed;
    }

    this.agentProcess = null;
    this.connection = null;
    this.readyPromise = null;
  }
}

function serializeMcpServers(
  mcpServers: readonly AcpMcpServerConfiguration[] | undefined,
): McpServer[] {
  if (!mcpServers?.length) {
    return [];
  }
  return mcpServers
    .map(serializeStdioServer)
    .filter((value): value is McpServerStdio => value !== null);
}

function serializeStdioServer(
  config: AcpMcpServerConfiguration,
): McpServerStdio | null {
  if (config.type !== "stdio") {
    return null;
  }

  return {
    name: config.name,
    command: config.command,
    args: Array.from(config.args ?? []),
    env: serializeEnv(config.env),
  } satisfies McpServerStdio;
}

function serializeEnv(
  env: Record<string, string> | undefined,
): McpServerStdio["env"] {
  if (!env) {
    return [];
  }
  return Object.entries(env).map(([name, value]) => ({ name, value }));
}
