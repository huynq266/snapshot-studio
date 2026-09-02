/* kb-notes.js — a step's `notes` turned into the article's `> **Note:**`
   callout lines.

   Six lines of code get their own module because the field arrives in two
   different shapes and only one of them is renderable:

     capture stage   `notes` is a STRING — the handoff prose kb-job.js asks
                     that agent for ("written for someone who cannot open the
                     app"). Internal: it tells the write stage what was on the
                     screen, and is never meant for the reader.
     write stage     `notes` is [{ kind, text }] — the reader-facing callouts,
                     which is what this renders.

   Both renderers used to do `for (const note of s.notes || [])` against the
   second shape alone. Handed the first, `for...of` walked the string CHARACTER
   BY CHARACTER, and every character became a `> **Note:** undefined` line: one
   real job's two steps produced 1357 of them in the live preview, which is the
   whole stretch of a job where `notes` is still a string. Nothing threw.

   So: a string is not an array and renders NOTHING, which is the correct
   article for a mid-capture job. A bare string INSIDE the array is taken as
   the note's text, since that is the near-miss an agent writes next. */

/** @param notes a step's `notes`, in any of the shapes above
 *  @returns markdown lines (each callout followed by a blank line), never null */
export function noteLines(notes) {
  if (!Array.isArray(notes)) return [];
  const out = [];
  for (const note of notes) {
    const text = typeof note === "string" ? note : note && note.text;
    if (!text) continue;
    const kind = (note && typeof note === "object" && note.kind) || "Note";
    // A newline inside the text would drop the rest of the note out of the
    // blockquote, so continuation lines carry their own marker.
    const [first, ...rest] = String(text).trim().split(/\r?\n/);
    out.push(`> **${kind}:** ${first}`);
    for (const line of rest) out.push(line.trim() ? `> ${line.trim()}` : ">");
    out.push("");
  }
  return out;
}
