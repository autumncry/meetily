import { afterAll, expect, mock, test } from 'bun:test';
const originalApp = { ...await import('@tauri-apps/api/app') };
const originalUpdater = { ...await import('@tauri-apps/plugin-updater') };
const originalProcess = { ...await import('@tauri-apps/plugin-process') };
let identifier = 'com.autumncry.meetily.personal';
let checks = 0;
mock.module('@tauri-apps/api/app', () => ({ ...originalApp, getIdentifier: async () => identifier, getVersion: async () => '0.4.1' }));
mock.module('@tauri-apps/plugin-updater', () => ({ ...originalUpdater, check: async () => { checks++; return null; } }));
mock.module('@tauri-apps/plugin-process', () => ({ ...originalProcess, relaunch: async () => {} }));
const { UpdateService } = await import('../../src/services/updateService');
afterAll(() => {
  mock.module('@tauri-apps/api/app', () => originalApp);
  mock.module('@tauri-apps/plugin-updater', () => originalUpdater);
  mock.module('@tauri-apps/plugin-process', () => originalProcess);
});
test('personal automatic and forced checks never call the upstream updater', async () => {
  identifier = 'com.autumncry.meetily.personal'; checks = 0;
  const service = new UpdateService();
  expect(await service.checkForUpdates()).toEqual({ available: false, currentVersion: '0.4.1', disabled: true });
  await service.checkForUpdates(true);
  expect(checks).toBe(0);
});
test('official builds retain the normal update check', async () => {
  identifier = 'com.meetily.ai'; checks = 0;
  await new UpdateService().checkForUpdates(true);
  expect(checks).toBe(1);
});
