// Character-length extraction for result columns. The driver reports each
// field's type modifier (atttypmod); for character types it carries the
// declared length plus VARHDRSZ (4), which the row editor turns into a
// maxlength on the text control. Other types' modifiers mean other things
// (numeric precision/scale, temporal precision), so they yield null.

/** Declared character length of a type+typmod pair, or null. */
export function typeLength(type: string, typmod: number): number | null {
  if (typmod < 0) return null
  if (type !== 'character varying' && type !== 'character') return null
  const length = typmod - 4
  return length > 0 ? length : null
}
