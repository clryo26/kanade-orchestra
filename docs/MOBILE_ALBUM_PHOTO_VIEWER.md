# Mobile Album Photo Viewer

Updated: 2026-07-02

## Summary

Album photos open inside the portal instead of navigating to a standalone image tab.

## Behavior

- Tapping a photo opens an in-portal full-screen viewer.
- The viewer always shows an `アルバムに戻る` button at the top.
- Closing the viewer returns to the member album screen without losing portal navigation.
- The Escape key and backdrop click also close the viewer on desktop-like environments.

## Regression Test

`tests/e2e/ui_css_reliability.spec.js` verifies that a smartphone-sized viewport can open an album photo and return to the portal album screen.
