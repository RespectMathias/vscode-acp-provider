import { AcpClient, AcpPermissionHandler } from "./acpClient";
import {
  createPreprogrammedAcpClient,
  PreprogrammedConfig,
} from "./preprogrammedAcpClient";

export function createTestAcpClientWithScenarios(
  permissionHandler: AcpPermissionHandler,
): AcpClient {
  const config: PreprogrammedConfig = {
    permissionHandler: permissionHandler,
    promptPrograms: [],
    session: {
      sessionId: "test-session-id",
    },
  };

  addThinkingOfJoke(config);
  addAskForPermissionAndGetWeather(config);

  return createPreprogrammedAcpClient(config);
}

function addThinkingOfJoke(config: PreprogrammedConfig) {
  config.promptPrograms?.push({
    promptText: "tell joke",
    notifications: {
      prompt: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: "Thinking of a joke...",
            },
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Why did the scarecrow win an award? Because he was outstanding in his field!",
            },
          },
        },
      ],
    },
  });
}
function addAskForPermissionAndGetWeather(config: PreprogrammedConfig) {
  config.promptPrograms?.push({
    promptText: "fetch weather",
    permission: {
      title: "Allow access to weather data?",
      rawInput: {
        command: [
          "/bin/sh",
          "-c",
          "curl https://api.weather.com/v3/wx/conditions/current",
        ],
      },
    },
    notifications: {
      permissionAllowed: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "fetch_weather_tool_call_1",
            title: "Fetch Weather Data",
            rawInput: {
              command: [
                "/bin/sh",
                "-c",
                "curl https://api.weather.com/v3/wx/conditions/current",
              ],
            },
            status: "in_progress",
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "fetch_weather_tool_call_1",
            content: [
              {
                type: "content",
                content: {
                  text: "72°F, Clear Skies",
                  type: "text",
                },
              },
            ],
            rawOutput: {
              output: "Current temperature is 72°F with clear skies.",
            },
            rawInput: {
              command: [
                "/bin/sh",
                "-c",
                "curl https://api.weather.com/v3/wx/conditions/current",
              ],
            },
            status: "completed",
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "The current temperature is 72°F with clear skies.",
            },
          },
        },
      ],
      permissionDenied: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "I was unable to fetch the weather data because permission was denied.",
            },
          },
        },
      ],
    },
  });
}
