#!/usr/bin/env python3
"""Offline anonymous speaker turns. No network calls; ffmpeg decodes locally.
Output timestamps use the original input timeline, including --start offset.
"""
import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import resource
import subprocess
import sys
import time

SCHEMA = 'meetily.local-diarization.v1'

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    temp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')
    os.replace(temp, path)

def execute(args):
    import numpy as np
    import sherpa_onnx as sherpa
    wall_start = time.perf_counter()
    def progress(phase):
        if args.progress:
            write_json(args.progress, {'phase': phase})
    if sherpa.__version__ != '2.0.1' or importlib.metadata.version('sherpa-onnx-core') != '2.0.1' or np.__version__ != '2.2.6':
        raise ValueError('runtime_version_mismatch_run_setup')
    progress('Checking saved audio…')
    if not args.input.is_file():
        raise ValueError('input_missing')
    if args.output.resolve() == args.input.resolve():
        raise ValueError('output_must_differ_from_input')
    if not math.isfinite(args.start) or args.start < 0:
        raise ValueError('start_must_be_nonnegative_finite')
    if args.duration is not None and (not math.isfinite(args.duration) or args.duration <= 0):
        raise ValueError('duration_must_be_positive_finite')
    if not 1 <= args.speakers <= 12:
        raise ValueError('speakers_must_be_1_to_12')
    if args.threads < 1:
        raise ValueError('threads_must_be_positive')
    for path in [args.segmentation, args.embedding]:
        if not path.is_file():
            raise ValueError('model_missing')
    try:
        probe = subprocess.run([args.ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(args.input)], check=True, capture_output=True)
        source_duration = float(json.loads(probe.stdout)['format']['duration'])
    except (subprocess.CalledProcessError, KeyError, ValueError):
        raise ValueError('audio_probe_failed') from None
    if args.start >= source_duration:
        raise ValueError('start_outside_audio')
    progress('Decoding saved audio…')
    decode_start = time.perf_counter()
    command = [args.ffmpeg, '-v', 'error', '-nostdin', '-i', str(args.input), '-ss', str(args.start)]
    if args.duration is not None:
        command.extend(['-t', str(args.duration)])
    command.extend(['-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'])
    try:
        raw = subprocess.run(command, check=True, capture_output=True).stdout
    except subprocess.CalledProcessError:
        raise ValueError('audio_decode_failed') from None
    samples = np.frombuffer(raw, dtype='<f4').copy()
    del raw
    if samples.size == 0 or not np.isfinite(samples).all():
        raise ValueError('empty_or_nonfinite_audio')
    duration = len(samples) / 16000
    decode_elapsed = time.perf_counter() - decode_start
    config = sherpa.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(args.segmentation), window_shift_ratio=0.1),
            num_threads=args.threads, provider='cpu'),
        embedding=sherpa.SpeakerEmbeddingExtractorConfig(model=str(args.embedding), num_threads=args.threads, provider='cpu'),
        clustering=sherpa.FastClusteringConfig(num_clusters=args.speakers, threshold=0.5),
        min_duration_on=0.3, min_duration_off=0.5)
    if not config.validate():
        raise ValueError('invalid_model_configuration')
    progress('Loading local speaker models…')
    init_start = time.perf_counter()
    engine = sherpa.OfflineSpeakerDiarization(config)
    init_elapsed = time.perf_counter() - init_start
    if engine.sample_rate != 16000:
        raise ValueError('unexpected_model_sample_rate')
    progress('Analyzing anonymous speaker turns…')
    infer_start = time.perf_counter()
    result = engine.process(samples).sort_by_start_time()
    inference = time.perf_counter() - infer_start
    turns = []
    for r in result:
        start, end = float(r.start), float(r.end)
        if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= duration + 0.1):
            raise ValueError('model_returned_invalid_turn_bounds')
        # Clamp <=100ms frame rounding at the input tail, retain original timeline.
        turns.append({'start': round(start + args.start, 6), 'end': round(min(end, duration) + args.start, 6), 'speaker': f'speaker-{int(r.speaker) + 1:02d}'})
    progress('Validating audio and model hashes…')
    hashes = {'source_sha256': sha256(args.input), 'decoded_f32le_sha256': hashlib.sha256(samples.tobytes()).hexdigest()}
    total = time.perf_counter() - wall_start
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {'schema_version': SCHEMA, 'status': 'ok', 'input': {**hashes, 'source_duration_seconds': source_duration, 'start_seconds': args.start, 'duration_seconds': duration, 'sample_rate_hz': 16000, 'channels': 1},
        'models': {'segmentation': {'file': args.segmentation.name, 'sha256': sha256(args.segmentation)}, 'embedding': {'file': args.embedding.name, 'sha256': sha256(args.embedding)}},
        'configuration': {'provider': 'cpu', 'threads': args.threads, 'requested_speakers': args.speakers, 'cluster_threshold': 0.5, 'window_shift_ratio': 0.1, 'min_duration_on': 0.3, 'min_duration_off': 0.5},
        'environment': {'python': platform.python_version(), 'platform': platform.platform(), 'sherpa_onnx': sherpa.__version__, 'sherpa_onnx_core': importlib.metadata.version('sherpa-onnx-core'), 'numpy': np.__version__},
        'timing': {'decode_seconds': decode_elapsed, 'model_init_seconds': init_elapsed, 'inference_seconds': inference, 'total_seconds': total, 'inference_real_time_factor': inference/duration},
        'resources': {'process_peak_rss_bytes': peak if sys.platform == 'darwin' else peak * 1024},
        'validation': {'finite_sorted_valid_bounds': True, 'bounds_start_seconds': args.start, 'bounds_end_seconds': args.start + duration, 'turn_count': len(turns), 'speaker_count': len({t['speaker'] for t in turns})}, 'turns': turns}

def main():
    root = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('input', type=Path)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--speakers', type=int, required=True, choices=range(1, 13), help='User-specified participant count')
    p.add_argument('--progress', type=Path)
    p.add_argument('--start', type=float, default=0)
    p.add_argument('--duration', type=float)
    p.add_argument('--threads', type=int, default=2)
    p.add_argument('--segmentation', type=Path, required=True)
    p.add_argument('--embedding', type=Path, required=True)
    p.add_argument('--ffmpeg', required=True)
    p.add_argument('--ffprobe', required=True)
    args = p.parse_args()
    try:
        result = execute(args)
        write_json(args.output, result)
    except Exception as exc:
        # Do not echo input filenames, source dialogue or model internals in errors.
        code = str(exc) if isinstance(exc, ValueError) else 'local_backend_failed'
        result = {'schema_version': SCHEMA, 'status': 'error', 'error': {'code': code, 'type': type(exc).__name__}}
        try:
            if args.output.resolve() != args.input.resolve():
                write_json(args.output, result)
        except OSError:
            pass
        print(json.dumps(result), file=sys.stderr)
        return 1
    print(json.dumps({'status': 'ok', 'turn_count': len(result['turns']), 'speaker_count': result['validation']['speaker_count'], 'inference_seconds': result['timing']['inference_seconds']}))
    return 0

if __name__ == '__main__':
    sys.exit(main())
