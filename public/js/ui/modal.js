// App-wide confirm dialog, shared by every destructive action (delete chat,
// forget a memory, clear memory). Replaces window.confirm(): the native box
// cannot be styled, carries no context about what is about to happen, and
// reads as browser chrome rather than part of this app.
//
// It is a real <dialog> opened with showModal() on purpose — the browser then
// owns the top layer, the centring, the focus trap and Esc handling, which is
// also what lets this stack cleanly on top of the memory panel's own dialog
// without any z-index bookkeeping. The card itself is built here in JS, so no
// markup has to be carried around in index.html for it.

let dialogEl = null;
let titleEl, textEl, okBtn, cancelBtn;
let resolveOpen = null; // resolves the promise handed out by the open confirm

function build() {
  if (dialogEl) return dialogEl;
  dialogEl = document.createElement('dialog');
  dialogEl.className = 'dialog modal danger';
  dialogEl.setAttribute('role', 'alertdialog');
  dialogEl.innerHTML = `
    <div class="modal-body">
      <div class="modal-head">
        <span class="modal-icon" aria-hidden="true">\u26A0</span>
        <h2 id="modalTitle" class="modal-title"></h2>
      </div>
      <p id="modalText" class="modal-text"></p>
      <div class="dialog-actions">
        <button type="button" class="btn modal-cancel"></button>
        <button type="button" class="btn btn-primary modal-ok"></button>
      </div>
    </div>`;
  document.body.appendChild(dialogEl);
  // Scoped lookups: the ids do not exist in the document until the dialog is
  // appended above, and querying inside the dialog keeps them private to it.
  titleEl = dialogEl.querySelector('.modal-title');
  textEl = dialogEl.querySelector('.modal-text');
  okBtn = dialogEl.querySelector('.modal-ok');
  cancelBtn = dialogEl.querySelector('.modal-cancel');
  // Only the skeleton above is HTML: every caller-supplied string is set with
  // textContent below, so a chat title or a remembered fact can never inject
  // markup into the dialog.
  cancelBtn.addEventListener('click', () => dialogEl.close('cancel'));
  okBtn.addEventListener('click', () => dialogEl.close('ok'));
  // Clicking the backdrop closes it, like every other modal. With padding: 0
  // the only place a click can land on the dialog itself is outside the card.
  dialogEl.addEventListener('click', (e) => {
    if (e.target === dialogEl) dialogEl.close('cancel');
  });
  dialogEl.addEventListener('close', () => {
    // Esc leaves returnValue at 'cancel', so a dismissed dialog is a "no".
    const ok = dialogEl.returnValue === 'ok';
    resolveOpen?.(ok);
    resolveOpen = null;
  });
  return dialogEl;
}

/**
 * Ask before doing something destructive.
 * Resolves true only on an explicit yes — the cancel button, Esc and a
 * backdrop click all resolve false.
 *
 * @param {object} o
 * @param {string} o.title          short question, e.g. 'Delete this chat?'
 * @param {string} [o.message]      detail; omitted hides the line
 * @param {string} [o.confirmLabel] verb of the action, never 'OK'
 * @param {string} [o.cancelLabel]
 * @param {boolean} [o.danger]      show the warning glyph (default true). The
 *                                  confirm button is always the standard
 *                                  charcoal primary — same as every other
 *                                  action in this app, no red shouting.
 */
export function confirmDialog({ title, message, confirmLabel = 'Delete',
                                cancelLabel = 'Cancel', danger = true } = {}) {
  const d = build();
  // Already open (a double click on a delete cross): answer the second ask
  // with "no" instead of throwing or stacking another dialog on the first.
  if (d.open) return Promise.resolve(false);

  titleEl.textContent = title;
  textEl.textContent = message || '';
  textEl.hidden = !message;
  cancelBtn.textContent = cancelLabel;
  okBtn.textContent = confirmLabel;
  d.classList.toggle('danger', danger);
  d.setAttribute('aria-labelledby', 'modalTitle');
  d.setAttribute('aria-describedby', 'modalText');

  return new Promise((resolve) => {
    resolveOpen = resolve;
    d.returnValue = 'cancel'; // in case it is closed by Esc, not by a button
    d.showModal();
    // Focus the cancel button, not the destructive one: an impatient Enter or a
    // stray tap must never delete anything on its own.
    cancelBtn.focus();
  });
}
