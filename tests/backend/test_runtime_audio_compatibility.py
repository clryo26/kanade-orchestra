"""Exercise real codecs and numerical dependencies across the Python upgrade."""

import logging

import numpy as np
from pydub import AudioSegment

from src.backend.services import audio_processing_service as audio


def test_recording_conversion_and_duration_use_real_audio(tmp_path):
    source = tmp_path / "recording.wav"
    AudioSegment.silent(duration=250).export(source, format="wav")
    logger = logging.getLogger(__name__)
    assert audio.get_audio_duration_seconds(source, logger=logger) == 0.2
    converted = audio.convert_path_to_mp3(source, ".wav", 128, logger=logger)
    assert converted == source.with_suffix(".mp3")
    assert not source.exists()
    assert converted.read_bytes().startswith(b"ID3")
    assert converted.stat().st_size > 1000


def test_audio_analysis_dependency_computes_finite_rms():
    # librosa is a declared dependency; the HTTP analysis service is currently a
    # placeholder. This checks the numerical stack, not a completed API feature.
    import librosa

    samples = np.sin(2 * np.pi * 440 * np.arange(8000) / 8000).astype(np.float32)
    rms = librosa.feature.rms(y=samples, frame_length=256, hop_length=128)
    assert rms.shape[0] == 1
    assert np.all(np.isfinite(rms))
    assert 0.6 < float(rms.mean()) < 0.8
