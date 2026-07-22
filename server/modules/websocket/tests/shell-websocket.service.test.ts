import assert from 'node:assert/strict';
import os from 'node:os';
import { mock, test } from 'node:test';

import {
  buildShellCommand,
  type ShellIncomingMessage,
  type ShellWebSocketDependencies,
} from '@/modules/websocket/services/shell-websocket.service.js';

const dependencies: ShellWebSocketDependencies = {
  resolveProviderSessionId: (sessionId) => sessionId,
  stripAnsiSequences: (content) => content,
  normalizeDetectedUrl: () => null,
  extractUrlsFromText: () => [],
  shouldAutoOpenUrlFromOutput: () => false,
};

function withPlatform(platform: NodeJS.Platform, run: () => void): void {
  mock.method(os, 'platform', () => platform);
  try {
    run();
  } finally {
    mock.restoreAll();
  }
}

function withClaudeCliPath(value: string | undefined, run: () => void): void {
  const previous = process.env.CLAUDE_CLI_PATH;
  if (value === undefined) {
    delete process.env.CLAUDE_CLI_PATH;
  } else {
    process.env.CLAUDE_CLI_PATH = value;
  }
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CLI_PATH;
    } else {
      process.env.CLAUDE_CLI_PATH = previous;
    }
  }
}

test('buildShellCommand quotes the resolved claude binary when starting a fresh session', () => {
  withPlatform('linux', () => {
    withClaudeCliPath('/home/user/.local/bin/claude', () => {
      const message: ShellIncomingMessage = { provider: 'claude', hasSession: false };
      assert.equal(buildShellCommand(message, dependencies), '"/home/user/.local/bin/claude"');
    });
  });
});

test('buildShellCommand builds a resume-with-fallback command on POSIX', () => {
  withPlatform('linux', () => {
    withClaudeCliPath('/home/user/.local/bin/claude', () => {
      const message: ShellIncomingMessage = {
        provider: 'claude',
        hasSession: true,
        sessionId: 'abc-123',
      };
      assert.equal(
        buildShellCommand(message, dependencies),
        '"/home/user/.local/bin/claude" --resume "abc-123" || "/home/user/.local/bin/claude"'
      );
    });
  });
});

test('buildShellCommand builds a resume-with-fallback command on Windows using & invocation', () => {
  withPlatform('win32', () => {
    withClaudeCliPath('C:\\Users\\user\\claude.exe', () => {
      const message: ShellIncomingMessage = {
        provider: 'claude',
        hasSession: true,
        sessionId: 'abc-123',
      };
      assert.equal(
        buildShellCommand(message, dependencies),
        '& "C:\\Users\\user\\claude.exe" --resume "abc-123"; if ($LASTEXITCODE -ne 0) { & "C:\\Users\\user\\claude.exe" }'
      );
    });
  });
});

test('buildShellCommand escapes an embedded quote for bash with a backslash', () => {
  withPlatform('linux', () => {
    withClaudeCliPath('/home/user/weird"path/claude', () => {
      const message: ShellIncomingMessage = { provider: 'claude', hasSession: false };
      assert.equal(buildShellCommand(message, dependencies), '"/home/user/weird\\"path/claude"');
    });
  });
});

test('buildShellCommand escapes an embedded quote for PowerShell by doubling it', () => {
  withPlatform('win32', () => {
    withClaudeCliPath('C:\\weird"path\\claude.exe', () => {
      const message: ShellIncomingMessage = { provider: 'claude', hasSession: false };
      assert.equal(buildShellCommand(message, dependencies), '& "C:\\weird""path\\claude.exe"');
    });
  });
});

test('buildShellCommand falls back to initialCommand when hasSession is true but no resumable session id resolves', () => {
  withPlatform('linux', () => {
    withClaudeCliPath('/home/user/.local/bin/claude', () => {
      const message: ShellIncomingMessage = {
        provider: 'claude',
        hasSession: true,
        sessionId: 'not a safe session id',
        initialCommand: 'claude setup-token',
      };
      assert.equal(buildShellCommand(message, dependencies), 'claude setup-token');
    });
  });
});
