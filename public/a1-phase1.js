(() => {
  const slider = document.getElementById('raise-slider-demo');
  const output = document.getElementById('raise-output');
  const amount = document.getElementById('raise-value');
  const confirmAmount = document.getElementById('confirm-raise-value');
  const message = document.getElementById('demo-message');
  const actionStatus = document.getElementById('demo-action-status');
  const presets = Array.from(document.querySelectorAll('[data-raise-value]'));

  const formatAmount = (value) => Number(value).toLocaleString('zh-CN');

  function setRaiseValue(value) {
    const nextValue = Math.max(Number(slider.min), Math.min(Number(slider.max), Number(value)));
    slider.value = String(nextValue);
    const formatted = formatAmount(nextValue);
    output.value = formatted;
    output.textContent = formatted;
    amount.textContent = formatted;
    confirmAmount.textContent = formatted;
    presets.forEach((button) => {
      const selected = Number(button.dataset.raiseValue) === nextValue;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }

  slider.addEventListener('input', () => setRaiseValue(slider.value));

  presets.forEach((button) => {
    button.addEventListener('click', () => {
      setRaiseValue(button.dataset.raiseValue);
      message.textContent = `快捷加注已设为 ${formatAmount(button.dataset.raiseValue)}。`;
    });
  });

  document.querySelectorAll('[data-raise-step]').forEach((button) => {
    button.addEventListener('click', () => {
      setRaiseValue(Number(slider.value) + Number(button.dataset.raiseStep));
    });
  });

  document.querySelectorAll('[data-demo-action]').forEach((button) => {
    button.addEventListener('click', () => {
      actionStatus.textContent = `样稿交互 · ${button.dataset.demoAction}`;
      message.textContent = `已触发“${button.dataset.demoAction}”视觉状态；未发送牌局操作。`;
    });
  });

  document.querySelectorAll('[data-demo-message]').forEach((button) => {
    button.addEventListener('click', () => {
      message.textContent = button.dataset.demoMessage;
    });
  });

  setRaiseValue(slider.value);
})();
