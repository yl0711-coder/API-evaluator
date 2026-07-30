import { applyProfileTemplateToForm } from "./operator-guidance.js";

export function applyProfileTemplate({ form, templateSelect, onApplied }) {
  const template = applyProfileTemplateToForm(form, templateSelect.value);
  if (template) {
    onApplied(template);
  }
}
