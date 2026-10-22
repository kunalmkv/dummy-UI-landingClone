// Tiny templating: html`` escapes every value unless it is raw(), so data from
// the API can never inject markup. Icons are lucide placeholders.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

class Raw {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

export function raw(value) {
  return new Raw(String(value));
}

function render(value) {
  if (value instanceof Raw) {
    return value.value;
  }
  if (Array.isArray(value)) {
    return value.map(render).join("");
  }
  if (value === null || value === undefined || value === false) {
    return "";
  }
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = "";
  strings.forEach((part, index) => {
    out += part;
    if (index < values.length) {
      out += render(values[index]);
    }
  });
  return new Raw(out);
}

export function icon(name, className = "") {
  return raw(`<i data-lucide="${name}" class="icon ${className}"></i>`);
}

/** Swap every lucide placeholder on the page for its SVG. */
export function refreshIcons() {
  if (window.lucide) {
    window.lucide.createIcons({ icons: window.lucide.icons });
  }
}

/** Replace an element's content and draw its icons. */
export function mount(element, content) {
  element.innerHTML = String(content);
  refreshIcons();
}
