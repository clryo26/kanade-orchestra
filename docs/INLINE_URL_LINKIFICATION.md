# Inline URL Linkification

Updated: 2026-07-02

## Rule

Practice instructions and piece introductions render URLs in place inside the body text.

- Do not copy URLs into a separate block before the body text.
- Escape all non-URL body text before rendering.
- Convert only the detected URL span into an anchor tag.
- Keep trailing punctuation such as `。`, `.`, `)`, and `」` outside the link.

## Covered Views

- Member piece introduction detail
- Member practice instruction detail

## Regression Test

`tests/frontend/frontend_logic.test.js` verifies that a URL inside text is linkified in place without duplicating the surrounding body text.
