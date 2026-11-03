/**
 * For a result whose card draws the image.
 *
 * Without this the model, told to "show it", also put the URL in its reply as a
 * Markdown image. ChatGPT drew that as a large grey box with a broken-image icon
 * directly under a card showing the same picture.
 */
export const CARD_SHOWS_IMAGE =
  "The card already shows this image to the operator, so do not add the image or its URL to your reply.";
