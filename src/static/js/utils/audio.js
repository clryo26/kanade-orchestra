function portalStopAudio(audio) {
    if (!audio) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
}
