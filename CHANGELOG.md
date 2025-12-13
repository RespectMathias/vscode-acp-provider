# Change Log

# Change Log

## [Unreleased]

### Changed

- Replaced the language model provider with a chat session provider powered by ACP agents.
- Switched configuration to the `acpClient.agents` namespace (breaking change; update existing settings).
- Added restart support for chat clients and improved logging/output handling.

## [0.1.0] - 2025-12-12

### Added

- Initial release
- ACP (Agent Client Protocol) client implementation
- Google Gemini CLI integration
- Support for multiple ACP-compliant servers
- Language Model Chat Provider API implementation
- Streaming response support
- Tool call support
- Model discovery and registration
- Configuration settings for server management
- Commands to show available models and restart providers
