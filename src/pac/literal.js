/**
 * Serializes a string as a JavaScript string literal that is safe to embed in generated source.
 * The result is pure ASCII, so line separators and non-ASCII text cannot change how the PAC parses.
 *
 * @param {string} value
 */
export function jsStringLiteral(value) {
  if (typeof value !== "string") {
    throw new TypeError("jsStringLiteral expects a string.");
  }
  return JSON.stringify(value).replace(/[\u007F-\uFFFF]/g,
    (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}
