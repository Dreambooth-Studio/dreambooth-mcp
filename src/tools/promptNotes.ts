/**
 * How the calling model should write the text it hands to the image tools.
 *
 * The connector adds nothing to a prompt: `start_frame`, `refine_frame`,
 * `start_booth` and `refine_booth` forward it verbatim to the Studio, whose
 * system prompts are shared with the dashboard and /new (see frameGeneration.ts
 * and boothGeneration.ts). So the one thing this side decides is what the model
 * calling us writes — and left to "the operator's own words", it writes a
 * caption: "a stunning, elegant frame with intricate golden florals and
 * sparkling bokeh". Every adjective there is an instruction to produce the
 * same glossy, over-decorated image the model has seen most often. That is
 * what operators call AI slop, and it is made here, before the Studio sees it.
 *
 * These sentences go in the `prompt` / `instruction` parameter descriptions,
 * because that is what the model reads at the moment it composes the value.
 * They are kept short: every tool description is sent on every `tools/list`,
 * in every conversation.
 *
 * Steering words, not content. Each brief starts with what the operator said,
 * in their own words and language, because that sentence is the creative
 * intent and everything after it is our interpretation of it: the Studio reads
 * the prompt as the operator's request (the dashboard thread shows it as their
 * message), and an interpretation that replaced it would lose the one part
 * nobody can reconstruct. Their specifics (names, colours, motif names,
 * wording they want printed) pass through untouched; the brief fills only what
 * they left open.
 */

/** The opening every first-prompt brief shares. */
const THEIR_WORDS_FIRST =
  "Start with what the operator said, in their words and language, then add the brief. Never swap a choice they made for one you prefer; fill only what they left open.";

/** Words that carry no instruction and pull every image toward the same look. */
const PRAISE_WORDS = "'stunning', 'elegant', 'magical', 'vibrant', 'intricate', 'high quality', '4k'";

/** Effects the image model adds by default when a prompt does not rule them out. */
const DEFAULT_EFFECTS = "sparkles, glitter, bokeh, lens flare, glow, glossy 3D";

/**
 * For a frame's first prompt: a designer's brief, made concrete.
 *
 * "A plain paper colour is a valid choice" is worded to fit the Studio's frame
 * rule that no area is left blank or white: a stated colour or texture is a
 * style, an empty canvas is not.
 */
export const FRAME_BRIEF =
  `${THEIR_WORDS_FIRST} ` +
  "Write it as a designer's brief, not a caption. Keep their specifics exactly (names, colours, motif names such as kawung or mega mendung, the occasion) and make concrete: " +
  "one technique (e.g. risograph, linocut, screen print, paper cut-out, gouache, batik tulis); " +
  "2-3 colours, named or hex; " +
  "1-3 named motifs and where they sit (top band, corners, along the edge); " +
  "how dense it is — a plain paper colour or texture around the photos is a valid choice, say which. " +
  `Add nothing they did not ask for: no ${DEFAULT_EFFECTS}, no praise words (${PRAISE_WORDS}). ` +
  "If it is too vague to fill these in, ask one question, or pick one direction and tell the operator which.";

/**
 * For a booth's first prompt: facts and art direction for the Studio's spec
 * writer, which writes the title, headline and button text itself.
 *
 * The references are deliberately local and print-based. "Modern and fun" gets
 * the gradient-and-confetti welcome screen; "hand-painted warung sign" gets a
 * design someone could recognise.
 *
 * The reference is the calling model's job, not a question for the operator:
 * most operators have no design vocabulary to answer with, so asking for one
 * stalls the conversation. It is words, never an image — start_booth takes none.
 */
export const BOOTH_BRIEF =
  `${THEIR_WORDS_FIRST} ` +
  "Write facts and art direction, not marketing copy. Include: the occasion or business, with names, ages, dates and places exactly as given; " +
  "one visual reference in words — theirs if they gave one, otherwise one you pick from the occasion and name to them (e.g. '1970s Indonesian film poster', 'hand-painted warung sign', 'Swiss minimalist poster'); do not ask them for one; " +
  "2-3 colours; 2-4 concrete objects or motifs (e.g. 'enamel tin mugs', 'pressed jasmine'). " +
  "Do not write the headline or taglines — the Studio writes the copy — unless the operator gave exact wording; then quote it and say it must appear as written. " +
  `No emoji, no praise words (${PRAISE_WORDS}, 'unforgettable'), no ${DEFAULT_EFFECTS} unless asked.`;

/**
 * For refine_frame and refine_booth: the change, and only the change.
 *
 * A refinement is read against the whole thread (frames) or the existing
 * design (booth redraws), so restating the original only adds words for the
 * model to reinterpret — and an inflated "darker, moodier, more sophisticated"
 * moves three things when the operator asked for one.
 */
export const CHANGE_BRIEF =
  "State the change and nothing else, starting from the operator's own words: what changes, to what, and what to keep if that matters ('background to deep green #1F3B2D, keep the motifs where they are'). " +
  "Turn a vague word into a concrete change ('more festive' → which colour, motif or density moves). " +
  "Do not restate the original design or add mood or praise words.";

/**
 * For filter adjustments: restraint.
 *
 * Slop in a filter is the over-cooked look — every slider moved, vignette and
 * grain and clarity stacked to read as "cinematic", skin shifted green by a
 * hue rotation. Booth photos are faces under venue light, so the skin has to
 * survive whatever the look is.
 */
export const FILTER_RESTRAINT =
  "A look is a few small moves, not every slider: most need 2-5 adjustments, each within about 25 of neutral (75-125 on the 0-200 scales) unless the operator asks for something strong ('high contrast', 'black and white'). " +
  "Booth photos are faces under venue light, so keep skin believable: leave hueRotate at 0 unless they ask for a surreal colour shift (it turns skin green or blue), and keep tint within 15 of 0. " +
  "Do not stack vignette, grain, clarity and dehaze to make it 'cinematic'; one of them, lightly, is usually the whole effect.";
