/** A zero exit alone is not evidence: the expected tests must actually run. */
export function completedTap(output, expectedTests) {
  if (typeof output !== "string" || !Number.isSafeInteger(expectedTests) || expectedTests < 1) return false;
  const count = (name) => {
    const rows = [...output.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gm"))];
    return rows.length === 1 ? Number(rows[0][1]) : null;
  };
  return count("tests") === expectedTests && count("pass") === expectedTests && count("fail") === 0 && count("cancelled") === 0 && count("skipped") === 0 && count("todo") === 0;
}
