import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOpenCodeDefinitionFromVerboseModels,
  buildOpenCodeDefinitionFromIds,
  parseOpenCodeModelsStdout,
  parseOpenCodeVerboseModelsStdout,
  OpenCodeProviderModels,
  OPENCODE_FALLBACK_MODELS,
} from '@/modules/providers/list/opencode/opencode-models.provider.js';

test('OpenCode models provider parses plain CLI output and removes duplicates', () => {
  const ids = parseOpenCodeModelsStdout(`
opencode/big-pickle
not a model
anthropic/claude-opus-4-7-fast
anthropic/claude-opus-4-7-fast
openai/gpt-5.5-pro
`);

  assert.deepEqual(ids, [
    'opencode/big-pickle',
    'anthropic/claude-opus-4-7-fast',
    'openai/gpt-5.5-pro',
  ]);
});

test('OpenCode models provider formats frontend labels from provider-prefixed ids', () => {
  const definition = buildOpenCodeDefinitionFromIds([
    'opencode/deepseek-v4-flash-free',
    'opencode/nemotron-3-super-free',
    'anthropic/claude-3-5-sonnet-20241022',
    'anthropic/claude-opus-4-7-fast',
    'google/model-alpha',
    'openai/gpt-5.4-mini-fast',
    'openai/gpt-5.5-pro',
    'newprovider/alpha-v12-special-20261231',
  ]);

  assert.deepEqual(definition.OPTIONS, [
    {
      value: 'opencode/deepseek-v4-flash-free',
      label: 'Deepseek V4 Flash Free',
      description: 'opencode - opencode/deepseek-v4-flash-free',
    },
    {
      value: 'opencode/nemotron-3-super-free',
      label: 'Nemotron 3 Super Free',
      description: 'opencode - opencode/nemotron-3-super-free',
    },
    {
      value: 'anthropic/claude-3-5-sonnet-20241022',
      label: 'Claude 3.5 Sonnet (2024-10-22)',
      description: 'anthropic - anthropic/claude-3-5-sonnet-20241022',
    },
    {
      value: 'anthropic/claude-opus-4-7-fast',
      label: 'Claude Opus 4.7 Fast',
      description: 'anthropic - anthropic/claude-opus-4-7-fast',
    },
    {
      value: 'openai/gpt-5.4-mini-fast',
      label: 'GPT-5.4 Mini Fast',
      description: 'openai - openai/gpt-5.4-mini-fast',
    },
    {
      value: 'openai/gpt-5.5-pro',
      label: 'GPT-5.5 Pro',
      description: 'openai - openai/gpt-5.5-pro',
    },
    {
      value: 'newprovider/alpha-v12-special-20261231',
      label: 'Alpha V12 Special (2026-12-31)',
      description: 'newprovider - newprovider/alpha-v12-special-20261231',
    },
  ]);
});

test('OpenCode models provider maps verbose model variants to effort options', () => {
  const models = parseOpenCodeVerboseModelsStdout(`
opencode/deepseek-v4-flash-free
{
  "id": "deepseek-v4-flash-free",
  "providerID": "opencode",
  "name": "DeepSeek V4 Flash Free",
  "variants": {
    "low": {
      "reasoningEffort": "low"
    },
    "high": {
      "reasoningEffort": "high"
    }
  }
}
anthropic/claude-sonnet-5
{
  "id": "claude-sonnet-5",
  "providerID": "anthropic",
  "name": "Claude Sonnet 5",
  "variants": {
    "low": {
      "effort": "low"
    },
    "max": {
      "effort": "max"
    }
  }
}
google/model-alpha
{
  "id": "model-alpha",
  "providerID": "google",
  "name": "Model Alpha"
}
`);

  const definition = buildOpenCodeDefinitionFromVerboseModels(models);

  assert.deepEqual(definition.OPTIONS, [
    {
      value: 'opencode/deepseek-v4-flash-free',
      label: 'DeepSeek V4 Flash Free',
      description: 'opencode - opencode/deepseek-v4-flash-free',
      effort: {
        values: [
          { value: 'low' },
          { value: 'high' },
        ],
      },
    },
    {
      value: 'anthropic/claude-sonnet-5',
      label: 'Claude Sonnet 5',
      description: 'anthropic - anthropic/claude-sonnet-5',
      effort: {
        values: [
          { value: 'low' },
          { value: 'max' },
        ],
      },
    },
  ]);
});

const VERBOSE_STDOUT_ONE_MODEL = `
anthropic/claude-sonnet-5
{
  "id": "claude-sonnet-5",
  "providerID": "anthropic",
  "name": "Claude Sonnet 5"
}
`;

test('OpenCodeProviderModels caches getSupportedModels for the TTL: two calls within it invoke the command runner once', async () => {
  let invocationCount = 0;
  let now = 1_000;
  const models = new OpenCodeProviderModels({
    runModelsCommand: async () => {
      invocationCount += 1;
      return VERBOSE_STDOUT_ONE_MODEL;
    },
    now: () => now,
  });

  const first = await models.getSupportedModels();
  now += 60_000; // well within the 3-day TTL
  const second = await models.getSupportedModels();

  assert.equal(invocationCount, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(first.OPTIONS.map((option) => option.value), ['anthropic/claude-sonnet-5']);
});

test('OpenCodeProviderModels re-invokes the command runner once the TTL has elapsed', async () => {
  let invocationCount = 0;
  let now = 1_000;
  const models = new OpenCodeProviderModels({
    runModelsCommand: async () => {
      invocationCount += 1;
      return VERBOSE_STDOUT_ONE_MODEL;
    },
    now: () => now,
  });

  await models.getSupportedModels();
  now += 3 * 24 * 60 * 60 * 1000 + 1; // just past the 3-day TTL
  await models.getSupportedModels();

  assert.equal(invocationCount, 2);
});

test('OpenCodeProviderModels dedupes concurrent calls during an in-flight spawn into a single command invocation', async () => {
  let invocationCount = 0;
  let resolveSpawn: (stdout: string) => void = () => {};
  const models = new OpenCodeProviderModels({
    runModelsCommand: () => {
      invocationCount += 1;
      return new Promise((resolve) => {
        resolveSpawn = resolve;
      });
    },
    now: () => Date.now(),
  });

  const firstCall = models.getSupportedModels();
  const secondCall = models.getSupportedModels();
  resolveSpawn(VERBOSE_STDOUT_ONE_MODEL);
  const [first, second] = await Promise.all([firstCall, secondCall]);

  assert.equal(invocationCount, 1);
  assert.deepEqual(first, second);
});

test('OpenCodeProviderModels clears the cache on a failed spawn so the next call retries', async () => {
  let invocationCount = 0;
  const models = new OpenCodeProviderModels({
    runModelsCommand: async () => {
      invocationCount += 1;
      if (invocationCount === 1) {
        throw new Error('opencode models timed out');
      }
      return VERBOSE_STDOUT_ONE_MODEL;
    },
    now: () => Date.now(),
  });

  const failedResult = await models.getSupportedModels();
  const retriedResult = await models.getSupportedModels();

  assert.equal(invocationCount, 2);
  assert.deepEqual(failedResult, OPENCODE_FALLBACK_MODELS);
  assert.deepEqual(retriedResult.OPTIONS.map((option) => option.value), ['anthropic/claude-sonnet-5']);
});
