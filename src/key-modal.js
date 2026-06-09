export function createKeyModal({ modal, form, input, cancelButton }) {
  let pendingResolver = null;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    close(input.value.trim());
  });

  cancelButton.addEventListener("click", () => close(""));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      close("");
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.classList.contains("hidden")) {
      close("");
    }
  });

  function requestApiKey() {
    if (pendingResolver) {
      close("");
    }
    input.value = "";
    modal.classList.remove("hidden");
    input.focus();
    return new Promise((resolve) => {
      pendingResolver = resolve;
    });
  }

  function close(value) {
    modal.classList.add("hidden");
    input.value = "";
    if (pendingResolver) {
      pendingResolver(value);
      pendingResolver = null;
    }
  }

  return { requestApiKey };
}
