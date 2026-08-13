export function selectReportIds(selection, files) {
  for (const file of files || []) if (file?.id) selection.add(file.id);
  return selection;
}

export function clearReportIds(selection) {
  selection.clear();
  return selection;
}

export function reconcileReportIds(selection, files) {
  const valid = new Set((files || []).map((file) => file?.id).filter(Boolean));
  for (const id of selection) if (!valid.has(id)) selection.delete(id);
  return selection;
}

export function areAllReportIdsSelected(selection, files) {
  return Boolean(files?.length) && files.every((file) => selection.has(file.id));
}
