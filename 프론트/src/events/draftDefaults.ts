export function keepEditedDraft(
  current: string,
  previousDefault: string,
  nextDefault: string,
) {
  return current === previousDefault ? nextDefault : current;
}

export function localizeUneditedChoices(
  current: string[],
  previousDefaults: string[],
  nextDefaults: string[],
) {
  return current.map((value, index) =>
    value === previousDefaults[index] ? (nextDefaults[index] ?? value) : value,
  );
}
