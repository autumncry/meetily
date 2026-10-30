import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';

const originalCore = { ...await import('@tauri-apps/api/core') };
const originalEvent = { ...await import('@tauri-apps/api/event') };
let commands: { command: string; args: any }[] = [];
let persisted: any = null;
mock.module('@tauri-apps/api/core', () => ({ ...originalCore, invoke: async (command: string, args?: any) => {
  commands.push({ command, args });
  if (command === 'get_onboarding_status') return persisted;
  if (command === 'check_first_launch') return false;
  if (command === 'builtin_ai_get_recommended_model') return 'qwen3.5:4b';
  if (command === 'builtin_ai_is_model_ready' || command === 'parakeet_has_available_models') return false;
  if (command === 'parakeet_get_available_models') return [];
  if (command === 'complete_onboarding') {
    persisted = { completed: true, current_step: 4, model_status: { parakeet: 'not_downloaded', summary: 'not_downloaded' } };
  }
} }));
mock.module('@tauri-apps/api/event', () => ({ ...originalEvent, listen: async () => () => {} }));
const { OnboardingProvider, useOnboarding } = await import('../../src/contexts/OnboardingContext');
let onboarding: ReturnType<typeof useOnboarding>;
let renderer: ReactTestRenderer;
function Harness() { onboarding = useOnboarding(); return null; }
async function mount() { await act(async () => { renderer = create(<OnboardingProvider><Harness /></OnboardingProvider>); }); }
beforeEach(async () => { commands = []; persisted = null; await mount(); });
afterEach(async () => { await act(async () => renderer.unmount()); });
afterAll(() => {
  mock.module('@tauri-apps/api/core', () => originalCore);
  mock.module('@tauri-apps/api/event', () => originalEvent);
});

test('configure later completes without starting missing models or declaring them ready, including after restart', async () => {
  await act(async () => { await onboarding.completeOnboarding({ configureLater: true }); });
  expect(commands.filter(call => /download|retry/.test(call.command))).toEqual([]);
  expect(commands.find(call => call.command === 'complete_onboarding')?.args.deferModels).toBe(true);
  expect(onboarding.parakeetDownloaded).toBe(false);
  expect(onboarding.summaryModelDownloaded).toBe(false);
  await act(async () => renderer.unmount());
  commands = [];
  await mount();
  expect(commands.filter(call => /download|retry/.test(call.command))).toEqual([]);
  expect(onboarding.parakeetDownloaded).toBe(false);
  expect(onboarding.summaryModelDownloaded).toBe(false);
});

test('normal completion retains the chosen summary download and truthful readiness', async () => {
  await act(async () => { await onboarding.completeOnboarding(); });
  expect(commands.find(call => call.command === 'builtin_ai_download_model')?.args.modelName).toBe('qwen3.5:4b');
  expect(commands.find(call => call.command === 'complete_onboarding')?.args.summaryReady).toBe(false);
  expect(onboarding.summaryModelDownloaded).toBe(false);
});
