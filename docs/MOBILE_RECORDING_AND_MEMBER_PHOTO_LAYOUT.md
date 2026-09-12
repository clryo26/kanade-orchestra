# Mobile Recording And Member Photo Layout

Updated: 2026-07-02

## Recording Room

On smartphone widths, the member recording room shows the continuous playback control as its own full-width row below the search filters and above the recording list.

This prevents the control from being clipped when the filter inputs wrap.

### Playback position (2026-09-12)

After opening a recording with the play button, use the native audio timeline to select a playback position. Native pause and the row's pause button retain the audio element and current position, so the timeline remains available while paused. Resuming the same recording does not reload its source. The row label follows native play/pause events. Selecting a different recording starts that recording from the beginning; continuous playback and explicit cleanup retain their existing behavior.

`tests/frontend/test_recording_playback.test.js` covers pause, position selection and resume, native button synchronization, and track switching. iPhone Safari and production GCS audio require manual verification.

## Member Introduction Photos

Member introduction photos use a larger portrait layout:

- Max width: `320px`
- Aspect ratio: `4 / 5`
- Object fit: `cover`

The shape remains close to square while giving the photo a vertical orientation.

## Regression Test

`tests/e2e/ui_css_reliability.spec.js` checks the smartphone layout for the continuous playback control and the member introduction photo dimensions.
