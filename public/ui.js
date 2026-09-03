/* Small DOM and formatting helpers shared by the app.
   Everything builds nodes programmatically and sets user text through
   textContent — no innerHTML anywhere, so a track title containing markup is
   just a track title. */

export const $ = (selector, root = document) => root.querySelector(selector);

/**
 * Build an element.
 *
 * Styles go through the CSSOM (`node.style.setProperty`) rather than a `style`
 * attribute, because the page runs under a Content-Security-Policy without
 * `unsafe-inline` and attribute styles would be dropped.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') throw new Error('el() does not take raw HTML');
    else if (key === 'style') for (const [prop, val] of Object.entries(value)) node.style.setProperty(prop, val);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** An <svg><use href="#id"/></svg> reference into the inline sprite. */
export function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// --------------------------------------------------------------- formatting

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value >= 100 || exp === 0 ? Math.round(value) : value.toFixed(1)} ${units[exp]}`;
}

/** m:ss, or h:mm:ss once it runs past an hour. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** A running time in words, for headers where "1:04:12" reads as a clock. */
export function formatSpan(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

export function formatDate(ms) {
  if (!ms) return null;
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function plural(n, one, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

// ------------------------------------------------------------------- toasts

let toastTimer = null;

export function toast(message, kind = 'ok') {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('bad', kind === 'bad');
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, kind === 'bad' ? 6000 : 3200);
}

// ------------------------------------------------------------------ dialogs

function modal(build) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'dialog' });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      dialog.close();
    };
    dialog.addEventListener('close', () => { done(null); dialog.remove(); });
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); done(null); });
    build(dialog, done);
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Ask for a line (or a paragraph) of text. Resolves null when dismissed. */
export function askText({ title, label, value = '', placeholder = '', multiline = false, confirm = 'Save' }) {
  return modal((dialog, done) => {
    const input = multiline
      ? el('textarea', { rows: 4, placeholder, value })
      : el('input', { type: 'text', placeholder, value, autocomplete: 'off' });

    const form = el(
      'form',
      {
        class: 'dialog-body',
        onSubmit: (event) => { event.preventDefault(); done(input.value); },
      },
      el('label', { class: 'field' }, el('span', { class: 'label', text: label }), input),
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'btn', type: 'submit', text: confirm.toUpperCase() }),
        el('button', { class: 'btn btn-quiet', type: 'button', text: 'CANCEL', onClick: () => done(null) }),
      ),
    );

    dialog.append(
      el('div', { class: 'dialog-head' }, el('h2', { class: 'label', text: title })),
      form,
    );
    queueMicrotask(() => { input.focus(); input.select?.(); });
  });
}

/**
 * Ask for several fields at once. Resolves an object keyed by field name, or
 * null when dismissed. Used where two edits belong to one decision — renaming
 * a folder and describing it, say — so they are one dialog rather than two.
 */
export function askFields({ title, fields, confirm = 'Save' }) {
  return modal((dialog, done) => {
    const inputs = new Map();
    const grid = el('div', { class: 'field-grid' });

    for (const field of fields) {
      const input = field.multiline
        ? el('textarea', { rows: 4, placeholder: field.placeholder ?? '', value: field.value ?? '' })
        : el('input', { type: 'text', placeholder: field.placeholder ?? '', value: field.value ?? '', autocomplete: 'off' });
      inputs.set(field.name, input);
      grid.append(el('label', { class: 'field' }, el('span', { class: 'label', text: field.label }), input));
    }

    const form = el(
      'form',
      {
        class: 'dialog-body',
        onSubmit: (event) => {
          event.preventDefault();
          done(Object.fromEntries([...inputs].map(([name, input]) => [name, input.value])));
        },
      },
      grid,
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'btn', type: 'submit', text: confirm.toUpperCase() }),
        el('button', { class: 'btn btn-quiet', type: 'button', text: 'CANCEL', onClick: () => done(null) }),
      ),
    );

    dialog.append(el('div', { class: 'dialog-head' }, el('h2', { class: 'label', text: title })), form);
    queueMicrotask(() => {
      const first = [...inputs.values()][0];
      first?.focus();
      first?.select?.();
    });
  });
}

/**
 * Pick one of a list, or take the escape hatch at the bottom. Resolves the
 * chosen item's value, the string 'new' for the extra action, or null.
 */
export function askChoice({ title, body, options, extra }) {
  return modal((dialog, done) => {
    const list = el('ul', { class: 'pick-list' });
    for (const option of options) {
      list.append(
        el(
          'li',
          {},
          el(
            'button',
            { type: 'button', onClick: () => done(option.value) },
            el('span', { text: option.label }),
            option.hint ? el('small', { text: option.hint }) : null,
          ),
        ),
      );
    }
    if (options.length === 0) {
      list.append(el('li', {}, el('span', { class: 'muted', text: 'Nothing here yet.' })));
    }

    dialog.append(
      el('div', { class: 'dialog-head' }, el('h2', { class: 'label', text: title })),
      el(
        'div',
        { class: 'dialog-body' },
        body ? el('p', { class: 'muted', text: body }) : null,
        list,
        el(
          'div',
          { class: 'row' },
          extra ? el('button', { class: 'btn', text: extra.toUpperCase(), onClick: () => done('new') }) : null,
          el('button', { class: 'btn btn-quiet', text: 'CANCEL', onClick: () => done(null) }),
        ),
      ),
    );
    queueMicrotask(() => dialog.querySelector('button')?.focus());
  });
}

/** Yes/no. Resolves true only on an explicit confirmation. */
export function confirmAction({ title, body, confirm = 'Continue', danger = false }) {
  return modal((dialog, done) => {
    dialog.append(
      el('div', { class: 'dialog-head' }, el('h2', { class: 'label', text: title })),
      el(
        'div',
        { class: 'dialog-body' },
        el('p', { class: 'muted', text: body }),
        el(
          'div',
          { class: 'row' },
          el('button', {
            class: `btn ${danger ? 'btn-danger' : ''}`,
            text: confirm.toUpperCase(),
            onClick: () => done(true),
          }),
          el('button', { class: 'btn btn-quiet', text: 'CANCEL', onClick: () => done(false) }),
        ),
      ),
    );
    queueMicrotask(() => dialog.querySelector('button').focus());
  });
}

/** Debounce that keeps the latest call's arguments. */
export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
