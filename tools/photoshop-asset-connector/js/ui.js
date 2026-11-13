(function () {
  const pickers = new WeakMap();
  const entities = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) => String(value ?? '').replace(/[<>&"']/g, (character) => entities[character]);

  function fillPicker(picker, items, value) {
    const choices = (items || []).filter((item) => item != null).map((item) => {
      if (typeof item !== 'object') return { value: String(item), label: item };
      return { value: String(item.value ?? ''), label: item.label ?? item.value };
    });
    const wanted = choices.findIndex((choice) => choice.value === String(value ?? ''));
    const index = choices.length ? Math.max(0, wanted) : -1;
    const model = { choices, index, ready: false };
    pickers.set(picker, model);
    picker.setAttribute('aria-busy', 'true');

    const menu = picker.querySelector('sp-menu') || picker;
    menu.innerHTML = choices.map((choice, position) => '<sp-menu-item value="' + esc(choice.value) + '"'
      + (position === index ? ' selected' : '') + '>' + esc(choice.label) + '</sp-menu-item>').join('');

    function restoreIndex() {
      if (pickers.get(picker) !== model) return;
      try {
        picker.selectedIndex = index;
      } catch (_) {}
    }

    restoreIndex();
    Promise.resolve().then(restoreIndex);
    setTimeout(() => {
      if (pickers.get(picker) !== model) return;
      model.ready = true;
      picker.removeAttribute('aria-busy');
    }, 80);
  }

  function pickerValue(picker) {
    const model = pickers.get(picker);
    if (!model) return '';
    return (model.choices[picker.selectedIndex] || model.choices[model.index])?.value || '';
  }

  function onPick(picker, handler) {
    picker.addEventListener('change', (event) => {
      if (pickers.get(picker)?.ready && !picker.disabled) handler(event);
    });
  }

  DX.ui = { esc, fillPicker, pickerValue, onPick };
})();
