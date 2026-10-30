import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderToStaticMarkup } from 'react-dom/server';
import { TranscriptSettings, type TranscriptModelProps } from '../../src/components/TranscriptSettings';
import { getProviderCommands } from '../../src/lib/transcription-model-readiness';

test('the real native personal default used by fresh/deferred setup works with recording readiness and renders Settings', () => {
  const repo = resolve(import.meta.dir, '../../..');
  const directory = mkdtempSync(join(tmpdir(), 'meetily-provider-contract-'));
  try {
    const source = join(directory, 'default.rs');
    const binary = join(directory, 'default-provider');
    writeFileSync(source, `#[path = ${JSON.stringify(join(repo, 'frontend/src-tauri/src/config.rs'))}] mod config;
fn main() { let (provider, model) = config::default_transcript_model(); println!("{}\\n{}", provider, model); }`);
    const wrapper = join(repo, '../Work/with-tools.sh');
    const compiler = existsSync(wrapper) ? 'bash' : 'rustc';
    const args = [source, '--cfg', 'feature="personal-mac"', '-o', binary];
    const compiled = spawnSync(compiler, existsSync(wrapper) ? [wrapper, 'rustc', ...args] : args, { encoding: 'utf8' });
    expect(compiled.status).toBe(0);
    const output = spawnSync(binary, [], { encoding: 'utf8' });
    expect(output.status).toBe(0);
    const [provider, model] = output.stdout.trim().split('\n');
    expect(getProviderCommands(provider)).toEqual({
      initialize: 'whisper_init', hasAvailableModels: 'whisper_has_available_models', getAvailableModels: 'whisper_get_available_models',
    });
    const config = { provider, model } as TranscriptModelProps;
    const html = renderToStaticMarkup(<TranscriptSettings transcriptModelConfig={config} setTranscriptModelConfig={() => {}} />);
    expect(html).toContain('Transcript Model');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
