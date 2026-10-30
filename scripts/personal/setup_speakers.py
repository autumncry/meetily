#!/usr/bin/env python3
"""Configure local-only speaker analysis. Downloads occur only with --install."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request

SEG_HASH = '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079'
EMB_HASH = 'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11'
BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/'
SEG_URL = BASE + 'speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2'
EMB_URL = BASE + 'speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'

def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as source:
        for data in iter(lambda: source.read(1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, default=Path(__file__).resolve().parents[3] / 'Work/diarization')
    parser.add_argument('--app-data', type=Path, default=Path.home() / 'Library/Application Support/com.autumncry.meetily.personal')
    parser.add_argument('--python', type=Path, help='Existing venv Python; otherwise RUNTIME/.venv/bin/python')
    parser.add_argument('--ffmpeg', type=Path, default=Path(shutil.which('ffmpeg') or '/opt/homebrew/bin/ffmpeg'))
    parser.add_argument('--ffprobe', type=Path, default=Path(shutil.which('ffprobe') or '/opt/homebrew/bin/ffprobe'))
    parser.add_argument('--install', action='store_true', help='Explicitly create a Python 3.12 venv and download public pinned dependencies/models')
    args = parser.parse_args()
    runtime = args.runtime.expanduser().absolute()
    python = (args.python or runtime / '.venv/bin/python').expanduser().absolute()
    segmentation = runtime / 'models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx'
    embedding = runtime / 'models/campplus.onnx'
    if args.install:
        if sys.version_info[:2] != (3, 12):
            parser.error('--install must be run using Python 3.12')
        runtime.mkdir(parents=True, exist_ok=True)
        if not python.exists():
            subprocess.run([sys.executable, '-m', 'venv', str(runtime / '.venv')], check=True)
        subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check',
                        'sherpa-onnx==2.0.1', 'sherpa-onnx-core==2.0.1', 'numpy==2.2.6'], check=True)
        downloads = runtime / 'downloads'
        downloads.mkdir(exist_ok=True)
        if not segmentation.is_file() or digest(segmentation) != SEG_HASH:
            archive = downloads / 'segmentation.tar.bz2'
            urllib.request.urlretrieve(SEG_URL, archive)
            # Extract only explicit regular-file members, never archive paths/symlinks.
            with tarfile.open(archive) as tar:
                for name in ['model.onnx', 'LICENSE']:
                    member = tar.getmember('sherpa-onnx-pyannote-segmentation-3-0/' + name)
                    if not member.isfile():
                        raise ValueError('Unexpected model archive member')
                    target = segmentation.parent / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with tar.extractfile(member) as source, open(target, 'wb') as dest:
                        shutil.copyfileobj(source, dest)
        if not embedding.is_file() or digest(embedding) != EMB_HASH:
            embedding.parent.mkdir(parents=True, exist_ok=True)
            urllib.request.urlretrieve(EMB_URL, embedding)
    for path in [python, segmentation, embedding, args.ffmpeg, args.ffprobe]:
        if not path.is_file():
            parser.error(f'Missing local dependency: {path}. Use --install with Python 3.12 or configure the existing runtime.')
    for path, expected in [(segmentation, SEG_HASH), (embedding, EMB_HASH)]:
        if digest(path) != expected:
            parser.error(f'Model SHA-256 mismatch: {path.name}; no configuration written.')
    subprocess.run([str(python), '-I', '-c',
        "import sys,numpy,sherpa_onnx,importlib.metadata as m;"
        "assert sys.version_info[:2]==(3,12);"
        "assert numpy.__version__=='2.2.6';"
        "assert sherpa_onnx.__version__=='2.0.1';"
        "assert m.version('sherpa-onnx-core')=='2.0.1'"], check=True)
    for binary in [args.ffmpeg, args.ffprobe]:
        subprocess.run([str(binary.absolute()), '-version'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    licenses = runtime / 'models/licenses'
    licenses.mkdir(parents=True, exist_ok=True)
    for source in (Path(__file__).parent / 'speaker-licenses').iterdir():
        shutil.copy2(source, licenses / source.name)
    config = dict(python=str(python), segmentation=str(segmentation), embedding=str(embedding),
                  ffmpeg=str(args.ffmpeg.absolute()), ffprobe=str(args.ffprobe.absolute()),
                  ffmpeg_sha256=digest(args.ffmpeg), ffprobe_sha256=digest(args.ffprobe))
    app_data = args.app_data.expanduser().absolute()
    app_data.mkdir(parents=True, exist_ok=True)
    target = app_data / 'speaker-runtime.json'
    temp = target.with_suffix('.tmp')
    temp.write_text(json.dumps(config, indent=2) + '\n')
    os.chmod(temp, 0o600)
    os.replace(temp, target)
    print('Speaker runtime verified and configured: ' + str(target))
    print('Analyze uses only local audio and installed dependencies; it never installs/downloads models.')

if __name__ == '__main__':
    main()
