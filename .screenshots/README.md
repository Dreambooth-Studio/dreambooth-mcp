# ChatGPT app directory screenshots

## portal/ — what to upload

Four PNGs, each exactly **706 x 860**, one per thing the app can make: a booth
draft, a frame preview, a filter preview, and a created booth. Build them with

    npx tsx .screenshots/build/build_cards.ts
    node .screenshots/build/render_portal.js .screenshots/portal

The portal's rule is 706 px wide, 400-860 px high, at most 4 images, and the
plugin guidelines add that screenshots "must accurately represent the plugin's
functionality and comply with the required dimensions" — they are **optional**,
so a small correct set beats a large flawed one.

`render_portal.js` puts the card on a 353x430 CSS stage (706x860 at 2x) and
**scales it down until the whole card fits**. That is the difference from the
2026-08-23 set, archived in `old-2026-08-23-clipped/`: those were cropped to
860 px instead, which cut the bottom off four of the eight images, and one of
the eight was a loading skeleton — a spinner over an empty placeholder shows
the waiting, not the feature. That set was rejected in the v2.0.0 review.

Scaling rather than cropping costs some size on the tall cards (the frame
preview renders at 0.70) but the card is whole, centred, and sits on the chat's
own light ground instead of floating on transparency.

## inline-card-*@2x.png — the Figma template

Made to the OpenAI "App Screenshot Template" (Figma, Inline Card page): the card
alone, 353 px wide, height up to 800 CSS px, exported at 2x, transparent outside
the card. `render_cards.js` produces these at each card's natural height, which
is why they range from 448 to 1200 px tall and why they cannot be uploaded to
the portal as-is. Keep them for the Figma template and for the README.

Rendered from the real widgets in `src/ui/` with headless Chrome. Images inside
the cards are real: Ale's AI frame from Frame Studio, the Studio's own
welcome-screen theme preview, and the Studio's filter sample photo.

`preview-mock-*.png` (the phone mock with a user bubble) bake a user prompt into
the image, so they are for marketing/README only, never the portal.
