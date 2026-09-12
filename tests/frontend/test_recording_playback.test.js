const fs = require('fs');
const path = require('path');
const vm = require('vm');

function setup() {
    const state = {};
    const listeners = {};
    const audio = {
        dataset: {}, paused: true, currentTime: 0,
        addEventListener: (name, callback) => { listeners[name] = callback; },
        load: vi.fn(function () { this.currentTime = 0; }),
        play: vi.fn(async function () { this.paused = false; listeners.play(); }),
        pause() { this.paused = true; listeners.pause(); },
    };
    const context = vm.createContext({
        window: { portalRuntimeContext: { appState: state } },
        document: { createElement: () => audio },
        showAlert: vi.fn(),
    });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/static/js/recordings_feature.js'), 'utf8'), context);
    function item(url) {
        const button = {};
        const area = { innerHTML: '', appendChild(node) { node.parentElement = this; } };
        return {
            recordingPlayUrl: url,
            querySelector: (selector) => selector === '.play-recording-btn' ? button : area,
        };
    }
    return { context, state, audio, listeners, item };
}

describe('recording playback position', () => {
    test('native pause keeps the player and resumes from a selected position', async () => {
        const { context, state, audio, item } = setup();
        const track = item('/recording.mp3');
        await context.startRecordingPlayback(track);
        audio.pause();
        audio.currentTime = 75;
        expect(state.currentAudio).toBe(audio);
        expect(state.currentRecordingItem).toBe(track);
        expect(audio.hidden).toBe(false);
        await context.toggleRecordingPlayback(track);
        expect(audio.currentTime).toBe(75);
        expect(audio.load).toHaveBeenCalledTimes(1);
        expect(state.currentPlayButton.textContent).toBe('一時停止');
    });

    test('row button pauses without resetting position and native play updates the label', async () => {
        const { context, state, audio, item } = setup();
        const track = item('/recording.mp3');
        await context.startRecordingPlayback(track);
        audio.currentTime = 42;
        await context.toggleRecordingPlayback(track);
        expect(audio.paused).toBe(true);
        expect(audio.currentTime).toBe(42);
        expect(state.currentPlayButton.textContent).toBe('再生');
        await audio.play();
        expect(state.currentPlayButton.textContent).toBe('一時停止');
    });

    test('switching tracks loads the new recording from the beginning', async () => {
        const { context, state, audio, item } = setup();
        await context.startRecordingPlayback(item('/first.mp3'));
        audio.currentTime = 42;
        const next = item('/second.mp3');
        await context.startRecordingPlayback(next);
        expect(audio.currentTime).toBe(0);
        expect(audio.load).toHaveBeenCalledTimes(2);
        expect(state.currentRecordingItem).toBe(next);
        expect(audio.src).toMatch(/^\/second.mp3\?/);
    });
});
