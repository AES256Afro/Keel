const navButton = document.querySelector("[data-nav-toggle]");
const navMenu = document.querySelector("[data-nav-menu]");

if (navButton && navMenu) {
  navButton.addEventListener("click", () => {
    const open = navButton.getAttribute("aria-expanded") === "true";
    navButton.setAttribute("aria-expanded", String(!open));
    navMenu.toggleAttribute("data-open", !open);
  });
}

for (const chooser of document.querySelectorAll("[data-install-chooser]")) {
  const buttons = [...chooser.querySelectorAll("[data-install-target]")];
  const panels = [...document.querySelectorAll("[data-install-panel]")];

  function select(target) {
    for (const button of buttons) {
      const active = button.dataset.installTarget === target;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    for (const panel of panels) {
      panel.hidden = panel.dataset.installPanel !== target;
    }
  }

  for (const button of buttons) {
    button.addEventListener("click", () => select(button.dataset.installTarget));
    button.addEventListener("keydown", (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const current = buttons.indexOf(button);
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const next = buttons[(current + direction + buttons.length) % buttons.length];
      next.focus();
      select(next.dataset.installTarget);
    });
  }
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const selector = button.dataset.copy;
    const source = selector ? document.querySelector(selector) : null;
    if (!source) return;
    const text = source.textContent.trim();
    try {
      await navigator.clipboard.writeText(text);
      const previous = button.textContent;
      button.textContent = "Copied";
      button.dataset.copied = "true";
      window.setTimeout(() => {
        button.textContent = previous;
        delete button.dataset.copied;
      }, 1800);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  });
}

const observed = document.querySelectorAll("[data-reveal]");
if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  document.documentElement.dataset.motion = "ready";
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.dataset.visible = "true";
      observer.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
  observed.forEach((element) => observer.observe(element));
}
