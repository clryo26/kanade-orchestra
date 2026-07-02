# Mobile Recording And Member Photo Layout

Updated: 2026-07-02

## Recording Room

On smartphone widths, the member recording room shows the continuous playback control as its own full-width row below the search filters and above the recording list.

This prevents the control from being clipped when the filter inputs wrap.

## Member Introduction Photos

Member introduction photos use a larger portrait layout:

- Max width: `320px`
- Aspect ratio: `4 / 5`
- Object fit: `cover`

The shape remains close to square while giving the photo a vertical orientation.

## Regression Test

`tests/e2e/ui_css_reliability.spec.js` checks the smartphone layout for the continuous playback control and the member introduction photo dimensions.
