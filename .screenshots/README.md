# ChatGPT app directory screenshots

## portal/ — what to upload

**Four** PNGs, each exactly **706 x 860**: a booth draft, a frame preview, a
filter preview and a created booth. Four is the portal's cap. Build them with

    CAPTURE_DIR=.screenshots/build/real-booth npx tsx .screenshots/build/build_cards_real.ts
    CARDS_DIR=.screenshots/build/cards-real node .screenshots/build/render_portal.js .screenshots/portal

All four come from `build/real-booth`, the 2026-09-23 OAuth write check: 37
checks, 0 failures, against the production Studio. That run is the first that
ever got `create_booth` to complete, so `04-booth-created.png` exists for the
first time - "Booth created", Garden Gold, the real welcome screen with its
`Mulai` button. The 2026-09-07 run in `build/real` is kept as the earlier
evidence; it stopped at 64 seconds with the booth still being created.

The set was briefly **two** on 2026-09-23, while the booth tools were withdrawn
and a card showing a booth draft would have been a picture of a feature a
reviewer could not reach. `digital_mode` went live the same day and they are
back.

Note the portal attaches screenshots **per starter prompt**, and there are three
prompts. `04-booth-created.png` therefore has no prompt slot: use it wherever
the listing takes app-level images, or swap it in for `01`.

The portal's rule is 706 px wide, 400-860 px high, at most 4 images, and the
plugin guidelines add that screenshots "must accurately represent the plugin's
functionality and comply with the required dimensions" — they are **optional**,
so a small correct set beats a large flawed one. The rule that decides the
count is accuracy, not quantity: four when every card shows something a
reviewer can reach, two when one of them would not.

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
