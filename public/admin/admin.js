/* ==========================================================================
   SyncPage Admin JavaScript - Interactive UI Utilities
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  // 1. Drag & Drop File Upload Handler
  const zipInput = document.getElementById('zip-upload');
  const uploadArea = document.querySelector('.upload-area');

  if (zipInput && uploadArea) {
    const textTarget = uploadArea.querySelector('p');
    const subTextTarget = uploadArea.querySelector('.sub-text');

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
      uploadArea.addEventListener(eventName, preventDefaults, false);
      document.body.addEventListener(eventName, preventDefaults, false);
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
      uploadArea.addEventListener(eventName, () => uploadArea.classList.add('drag-over'), false);
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      uploadArea.addEventListener(eventName, () => uploadArea.classList.remove('drag-over'), false);
    });

    uploadArea.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      const files = dt?.files;
      if (files && files.length > 0) {
        /** @type {HTMLInputElement} */ (zipInput).files = files;
        updateFileName(files[0]);
      }
    });

    zipInput.addEventListener('change', () => {
      const files = /** @type {HTMLInputElement} */ (zipInput).files;
      if (files && files[0]) {
        updateFileName(files[0]);
      }
    });

    function updateFileName(file) {
      if (textTarget) {
        textTarget.textContent = `فایل انتخاب شده: ${file.name}`;
      }
      if (subTextTarget) {
        const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
        subTextTarget.textContent = `حجم فایل: ${sizeMb} MB`;
      }
      showToast(`فایل ${file.name} انتخاب شد.`, 'success');
    }
  }

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  // 2. Mobile Navigation Sidebar Toggle
  const toggleBtn = document.getElementById('mobile-nav-toggle');
  const sidebar = document.querySelector('.sidebar');
  if (toggleBtn && sidebar) {
    toggleBtn.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
  }

  // 3. کپی متن از data-copy
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sel = btn.getAttribute('data-copy');
      const el = sel ? document.querySelector(sel) : null;
      const text = el?.textContent?.trim() || '';
      if (!text) return;
      const okMsg = btn.getAttribute('data-copy-toast') || 'متن کپی شد.';
      try {
        await navigator.clipboard.writeText(text);
        showToast(okMsg, 'success');
      } catch {
        showToast('کپی نشد — دستی انتخاب کنید.', 'danger');
      }
    });
  });

  // ===================================================================
  //  FORM-EDIT: Tab System
  // ===================================================================
  const tabContainer = document.getElementById('form-tabs');
  if (tabContainer) {
    tabContainer.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement} */ (e.target).closest('.form-tab-btn');
      if (!btn) return;
      const targetId = btn.getAttribute('data-tab');
      if (!targetId) return;

      // deactivate all
      tabContainer.querySelectorAll('.form-tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.form-tab-panel').forEach((p) => p.classList.remove('active'));

      // activate clicked
      btn.classList.add('active');
      const panel = document.getElementById(targetId);
      if (panel) panel.classList.add('active');

      // refresh snippets when switching to that tab
      if (targetId === 'tab-snippets') refreshLandingSnippets();
    });
  }

  // ===================================================================
  //  FORM-EDIT: Profile change handler
  // ===================================================================
  const profileSelect = document.getElementById('profileId');
  if (profileSelect) {
    profileSelect.addEventListener('change', function () { handleProfileChange(this); });
    if (/** @type {HTMLSelectElement} */ (profileSelect).value) {
      handleProfileChange(/** @type {HTMLSelectElement} */ (profileSelect));
    }
  }

  // ===================================================================
  //  FORM-EDIT: OTP toggle
  // ===================================================================
  const otpCheckbox = document.getElementById('otpEnabled');
  if (otpCheckbox) {
    otpCheckbox.addEventListener('change', function () {
      const settings = document.getElementById('otp-settings');
      if (settings) settings.style.display = /** @type {HTMLInputElement} */ (this).checked ? 'block' : 'none';
    });
  }

  // ===================================================================
  //  FORM-EDIT: Visual Field Builder
  // ===================================================================
  const fieldList = document.getElementById('field-list');
  const addFieldBtn = document.getElementById('add-field-btn');
  const bodyTextarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('body'));
  const bodyHidden = /** @type {HTMLTextAreaElement} */ (document.getElementById('body-hidden'));
  const jsonRawToggle = /** @type {HTMLInputElement} */ (document.getElementById('json-raw-toggle'));
  const builderView = document.getElementById('field-builder-view');
  const jsonRawView = document.getElementById('json-raw-view');

  if (fieldList) {
    // Initialize from seed data
    const seedFields = window.__FORM_BODY_JSON || [];
    if (Array.isArray(seedFields)) {
      seedFields.forEach((f) => addFieldRow(f));
    }
    updateFieldCountBadge();
    syncBuilderToHidden();

    // Add field button
    if (addFieldBtn) {
      addFieldBtn.addEventListener('click', () => {
        addFieldRow({ type: 'text', name: '', label: '', required: false });
        updateFieldCountBadge();
        syncBuilderToHidden();
        // focus the name input of the new row
        const rows = fieldList.querySelectorAll('.field-row');
        const last = rows[rows.length - 1];
        if (last) {
          const nameInput = last.querySelector('[data-field="name"]');
          if (nameInput) /** @type {HTMLInputElement} */ (nameInput).focus();
        }
      });
    }

    // JSON raw toggle
    if (jsonRawToggle && builderView && jsonRawView) {
      jsonRawToggle.addEventListener('change', () => {
        if (jsonRawToggle.checked) {
          // switching to raw: sync builder → textarea
          syncBuilderToTextarea();
          builderView.style.display = 'none';
          jsonRawView.style.display = 'block';
          // enable the visible textarea, disable hidden
          if (bodyTextarea) bodyTextarea.removeAttribute('disabled');
          if (bodyHidden) bodyHidden.setAttribute('disabled', 'true');
        } else {
          // switching to builder: parse textarea → rebuild
          if (bodyTextarea) {
            try {
              const parsed = JSON.parse(bodyTextarea.value);
              if (Array.isArray(parsed)) {
                fieldList.innerHTML = '';
                parsed.forEach((f) => addFieldRow(f));
                updateFieldCountBadge();
              }
            } catch {
              showToast('JSON نامعتبر — ابتدا فرمت را اصلاح کنید.', 'danger');
              jsonRawToggle.checked = true;
              return;
            }
          }
          builderView.style.display = 'block';
          jsonRawView.style.display = 'none';
          if (bodyTextarea) bodyTextarea.setAttribute('disabled', 'true');
          if (bodyHidden) bodyHidden.removeAttribute('disabled');
          syncBuilderToHidden();
        }
      });
      // initial state: builder active, raw hidden textarea disabled
      if (bodyTextarea) bodyTextarea.setAttribute('disabled', 'true');
      if (bodyHidden) bodyHidden.removeAttribute('disabled');
    }

    // JSON format button
    const formatJsonBtn = document.getElementById('format-json-btn');
    if (formatJsonBtn && bodyTextarea) {
      formatJsonBtn.addEventListener('click', () => {
        try {
          const parsed = JSON.parse(bodyTextarea.value);
          bodyTextarea.value = JSON.stringify(parsed, null, 2);
          showToast('فرمت JSON مرتب شد.', 'success');
        } catch {
          showToast('JSON نامعتبر!', 'danger');
        }
      });
    }

    // Form submit: sync builder to hidden before submit
    const formEl = document.getElementById('form-edit-form');
    if (formEl) {
      formEl.addEventListener('submit', () => {
        if (jsonRawToggle && jsonRawToggle.checked) {
          // raw mode: copy visible textarea to hidden
          if (bodyHidden && bodyTextarea) {
            bodyHidden.value = bodyTextarea.value;
            bodyHidden.removeAttribute('disabled');
          }
          if (bodyTextarea) bodyTextarea.setAttribute('disabled', 'true');
        } else {
          syncBuilderToHidden();
          if (bodyHidden) bodyHidden.removeAttribute('disabled');
        }
      });
    }

    // Delegate events on field-list
    fieldList.addEventListener('input', () => {
      syncBuilderToHidden();
    });
    fieldList.addEventListener('change', () => {
      syncBuilderToHidden();
      updateFieldCountBadge();
    });

    // Drag & drop reorder
    let dragSrcRow = null;
    fieldList.addEventListener('dragstart', (e) => {
      const row = /** @type {HTMLElement} */ (e.target).closest('.field-row');
      if (!row) return;
      dragSrcRow = row;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    fieldList.addEventListener('dragend', (e) => {
      const row = /** @type {HTMLElement} */ (e.target).closest('.field-row');
      if (row) row.classList.remove('dragging');
      fieldList.querySelectorAll('.field-row').forEach((r) => {
        r.classList.remove('drag-over-above', 'drag-over-below');
      });
      dragSrcRow = null;
      syncBuilderToHidden();
    });
    fieldList.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const row = /** @type {HTMLElement} */ (e.target).closest('.field-row');
      if (!row || row === dragSrcRow) return;
      fieldList.querySelectorAll('.field-row').forEach((r) => {
        r.classList.remove('drag-over-above', 'drag-over-below');
      });
      const rect = row.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        row.classList.add('drag-over-above');
      } else {
        row.classList.add('drag-over-below');
      }
    });
    fieldList.addEventListener('drop', (e) => {
      e.preventDefault();
      const row = /** @type {HTMLElement} */ (e.target).closest('.field-row');
      if (!row || !dragSrcRow || row === dragSrcRow) return;
      const rect = row.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        fieldList.insertBefore(dragSrcRow, row);
      } else {
        fieldList.insertBefore(dragSrcRow, row.nextSibling);
      }
    });

    // Remove field (delegated)
    fieldList.addEventListener('click', (e) => {
      const removeBtn = /** @type {HTMLElement} */ (e.target).closest('.field-remove-btn');
      if (removeBtn) {
        const row = removeBtn.closest('.field-row');
        if (row) {
          row.remove();
          updateFieldCountBadge();
          syncBuilderToHidden();
        }
        return;
      }
      // Options toggle
      const optionsBtn = /** @type {HTMLElement} */ (e.target).closest('.field-options-btn');
      if (optionsBtn) {
        const row = optionsBtn.closest('.field-row');
        if (!row) return;
        let panel = row.querySelector('.field-options-panel');
        if (panel) {
          panel.remove();
          optionsBtn.classList.remove('has-options');
        } else {
          panel = createOptionsPanel(row);
          row.appendChild(panel);
          optionsBtn.classList.add('has-options');
          const input = panel.querySelector('input');
          if (input) input.focus();
        }
      }
    });
  }

  // ===================================================================
  //  FORM-EDIT: Landing Snippets
  // ===================================================================
  const snippetsRoot = document.querySelector('[data-form-snippets]');
  if (snippetsRoot) {
    const refreshBtn = document.getElementById('refresh-snippets-btn');
    const keyInput = /** @type {HTMLInputElement} */ (document.getElementById('key'));
    refreshLandingSnippets();
    refreshBtn?.addEventListener('click', () => {
      refreshLandingSnippets();
      showToast('اسنیپت‌ها بروزرسانی شد.', 'success');
    });
    keyInput?.addEventListener('input', refreshLandingSnippets);
  }

  // ===================================================================
  //  FILE MANAGER: مرور، ویرایش و دانلود فایل‌های لندینگ
  // ===================================================================
  const fileManager = document.getElementById('file-manager');
  if (fileManager) {
    initFileManager(fileManager);
  }
});

// =====================================================================
//  Field Builder Helpers
// =====================================================================

const FIELD_TYPES = [
  { value: 'text', label: 'متن (text)' },
  { value: 'email', label: 'ایمیل (email)' },
  { value: 'tel', label: 'تلفن (tel)' },
  { value: 'number', label: 'عدد (number)' },
  { value: 'textarea', label: 'متن بلند (textarea)' },
  { value: 'select', label: 'لیست انتخاب (select)' },
  { value: 'checkbox', label: 'چک‌باکس (checkbox)' },
  { value: 'date', label: 'تاریخ (date)' },
  { value: 'url', label: 'لینک (url)' },
  { value: 'password', label: 'رمز عبور (password)' },
  { value: 'hidden', label: 'مخفی (hidden)' },
];

/**
 * @param {Record<string, unknown>} field
 */
function addFieldRow(field) {
  const fieldList = document.getElementById('field-list');
  if (!fieldList) return;

  const row = document.createElement('div');
  row.className = 'field-row';
  row.draggable = true;

  const type = String(field.type || 'text');
  const name = String(field.name || '');
  const label = String(field.label || '');
  const required = !!field.required;
  const options = Array.isArray(field.options) ? field.options : [];
  const hasOptions = type === 'select' && options.length > 0;

  // drag handle
  const dragHandle = document.createElement('div');
  dragHandle.className = 'drag-handle';
  dragHandle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';

  // name input
  const nameInput = document.createElement('input');
  nameInput.className = 'field-input';
  nameInput.type = 'text';
  nameInput.placeholder = 'نام فیلد (name)';
  nameInput.value = name;
  nameInput.setAttribute('data-field', 'name');
  nameInput.dir = 'ltr';

  // type select
  const typeSelect = document.createElement('select');
  typeSelect.className = 'field-input';
  typeSelect.setAttribute('data-field', 'type');
  FIELD_TYPES.forEach((ft) => {
    const opt = document.createElement('option');
    opt.value = ft.value;
    opt.textContent = ft.label;
    if (ft.value === type) opt.selected = true;
    typeSelect.appendChild(opt);
  });

  // required toggle
  const reqLabel = document.createElement('label');
  reqLabel.className = 'field-req-toggle';
  const reqCb = document.createElement('input');
  reqCb.type = 'checkbox';
  reqCb.checked = required;
  reqCb.setAttribute('data-field', 'required');
  reqLabel.appendChild(reqCb);
  reqLabel.appendChild(document.createTextNode('اجباری'));

  // options button (for select)
  const optionsBtn = document.createElement('button');
  optionsBtn.type = 'button';
  optionsBtn.className = 'field-options-btn' + (hasOptions ? ' has-options' : '');
  optionsBtn.title = 'تنظیم گزینه‌ها (options)';
  optionsBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

  // remove button
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'field-remove-btn';
  removeBtn.title = 'حذف فیلد';
  removeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

  row.appendChild(dragHandle);
  row.appendChild(nameInput);
  row.appendChild(typeSelect);
  row.appendChild(reqLabel);
  row.appendChild(optionsBtn);
  row.appendChild(removeBtn);

  // store options data on row element
  row.__fieldOptions = options;
  row.__fieldLabel = label;

  // label stored as data attribute for builder → JSON sync
  const labelInput = document.createElement('input');
  labelInput.type = 'hidden';
  labelInput.value = label;
  labelInput.setAttribute('data-field', 'label');
  row.appendChild(labelInput);

  // if options exist and type is select, auto-open panel
  if (hasOptions) {
    const panel = createOptionsPanel(row);
    row.appendChild(panel);
  }

  fieldList.appendChild(row);
}

/**
 * Create inline options editing panel
 * @param {HTMLElement} row
 * @returns {HTMLElement}
 */
function createOptionsPanel(row) {
  const panel = document.createElement('div');
  panel.className = 'field-options-panel';

  const currentOptions = row.__fieldOptions || [];
  const optStr = currentOptions.map((o) => {
    if (o && typeof o === 'object') return String(o.label || o.value || '');
    return String(o);
  }).join(', ');

  const labelEl = document.createElement('label');
  labelEl.textContent = 'لیبل (نمایش فارسی فیلد)';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.placeholder = 'مثلاً: نام کامل';
  const hiddenLabel = row.querySelector('[data-field="label"]');
  labelInput.value = hiddenLabel ? /** @type {HTMLInputElement} */ (hiddenLabel).value : (row.__fieldLabel || '');
  labelInput.addEventListener('input', () => {
    if (hiddenLabel) /** @type {HTMLInputElement} */ (hiddenLabel).value = labelInput.value;
    row.__fieldLabel = labelInput.value;
    syncBuilderToHidden();
  });

  const optLabel = document.createElement('label');
  optLabel.textContent = 'گزینه‌ها (Options) — با کاما جدا کنید';
  optLabel.style.marginTop = '0.75rem';
  const optInput = document.createElement('input');
  optInput.type = 'text';
  optInput.placeholder = 'مثلاً: مرد, زن, سایر';
  optInput.value = optStr;
  optInput.dir = 'rtl';
  optInput.addEventListener('input', () => {
    const parts = optInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    row.__fieldOptions = parts;
    syncBuilderToHidden();
  });
  const small = document.createElement('small');
  small.textContent = 'فقط برای فیلد نوع select کاربرد دارد.';

  panel.appendChild(labelEl);
  panel.appendChild(labelInput);
  panel.appendChild(optLabel);
  panel.appendChild(optInput);
  panel.appendChild(small);

  return panel;
}

function getFieldsFromBuilder() {
  const fieldList = document.getElementById('field-list');
  if (!fieldList) return [];
  const rows = fieldList.querySelectorAll('.field-row');
  const fields = [];
  rows.forEach((row) => {
    const name = /** @type {HTMLInputElement} */ (row.querySelector('[data-field="name"]'))?.value?.trim() || '';
    const type = /** @type {HTMLSelectElement} */ (row.querySelector('[data-field="type"]'))?.value || 'text';
    const required = /** @type {HTMLInputElement} */ (row.querySelector('[data-field="required"]'))?.checked || false;
    const label = /** @type {HTMLInputElement} */ (row.querySelector('[data-field="label"]'))?.value?.trim() || name;
    const options = /** @type {any} */ (row).__fieldOptions || [];

    if (!name) return; // skip empty rows

    const fieldObj = { type, name, label, required };
    if (type === 'select' && options.length > 0) {
      fieldObj.options = options;
    }
    fields.push(fieldObj);
  });
  return fields;
}

function syncBuilderToHidden() {
  const bodyHidden = /** @type {HTMLTextAreaElement} */ (document.getElementById('body-hidden'));
  if (!bodyHidden) return;
  const fields = getFieldsFromBuilder();
  bodyHidden.value = JSON.stringify(fields, null, 2);
}

function syncBuilderToTextarea() {
  const bodyTextarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('body'));
  if (!bodyTextarea) return;
  const fields = getFieldsFromBuilder();
  bodyTextarea.value = JSON.stringify(fields, null, 2);
}

function updateFieldCountBadge() {
  const badge = document.getElementById('field-count-badge');
  const fieldList = document.getElementById('field-list');
  if (badge && fieldList) {
    badge.textContent = String(fieldList.querySelectorAll('.field-row').length);
  }
}

// =====================================================================
//  Profile Change Handler
// =====================================================================
function handleProfileChange(select) {
  const integrationFields = document.getElementById('integration-fields');
  if (select.value) {
    integrationFields.style.opacity = '0.5';
    integrationFields.style.pointerEvents = 'none';

    const option = select.options[select.selectedIndex];
    document.getElementById('webhookUrl').value = option.getAttribute('data-webhook') || '';
    document.getElementById('googleSheetUrl').value = option.getAttribute('data-sheet') || '';

    const metaStr = option.getAttribute('data-meta');
    if (metaStr) {
      try {
        const meta = JSON.parse(metaStr);
        document.getElementById('startRow').value = meta.startRow || 2;
        if (meta.columns) {
          document.getElementById('columnMapping').value = JSON.stringify(meta.columns, null, 2);
        }
      } catch(e) {}
    }
  } else {
    integrationFields.style.opacity = '1';
    integrationFields.style.pointerEvents = 'auto';
  }
}

// =====================================================================
//  Landing Snippets
// =====================================================================

function refreshLandingSnippets() {
  const htmlEl = document.getElementById('snippet-html');
  const scriptEl = document.getElementById('snippet-script');
  if (!htmlEl || !scriptEl) return;

  const keyInput = /** @type {HTMLInputElement} */ (document.getElementById('key'));
  const key = (keyInput?.value || '').trim() || 'YOUR_FORM_KEY';

  // get fields from builder OR from hidden textarea
  let fields = [];
  try {
    const bodyHidden = /** @type {HTMLTextAreaElement} */ (document.getElementById('body-hidden'));
    const bodyTextarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('body'));
    const src = (bodyHidden && !bodyHidden.disabled) ? bodyHidden : bodyTextarea;
    if (src) {
      const parsed = JSON.parse(src.value || '[]');
      fields = Array.isArray(parsed) ? parsed : [];
    }
  } catch {
    // fallback: try from builder
    fields = typeof getFieldsFromBuilder === 'function' ? getFieldsFromBuilder() : [];
  }

  const formId = `sp-form-${sanitizeId(key)}`;
  htmlEl.textContent = buildLandingFormHtml(formId, fields);
  scriptEl.textContent = buildLandingFormScript(formId, key);
}

function sanitizeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '-') || 'form';
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildLandingFormHtml(formId, fields) {
  const parts = [`<form id="${escapeAttr(formId)}">`];
  for (const field of fields) {
    const name = String(field.name || '').trim();
    if (!name) continue;
    const label = String(field.label || name);
    const required = field.required ? ' required' : '';
    const type = String(field.type || 'text').toLowerCase();

    if (type === 'textarea') {
      parts.push(`  <label>\n    ${escapeHtmlText(label)}\n    <textarea name="${escapeAttr(name)}"${required}></textarea>\n  </label>`);
      continue;
    }
    if (type === 'select') {
      const options = Array.isArray(field.options) ? field.options : [];
      const opts = options.map((opt) => {
        if (opt && typeof opt === 'object') {
          const val = String(opt.value ?? opt.label ?? '');
          const lab = String(opt.label ?? opt.value ?? '');
          return `      <option value="${escapeAttr(val)}">${escapeHtmlText(lab)}</option>`;
        }
        return `      <option value="${escapeAttr(opt)}">${escapeHtmlText(opt)}</option>`;
      }).join('\n');
      parts.push(`  <label>\n    ${escapeHtmlText(label)}\n    <select name="${escapeAttr(name)}"${required}>\n${opts}\n    </select>\n  </label>`);
      continue;
    }
    if (type === 'checkbox') {
      parts.push(`  <label>\n    <input type="checkbox" name="${escapeAttr(name)}" value="1"${required} />\n    ${escapeHtmlText(label)}\n  </label>`);
      continue;
    }
    const inputType = ['email', 'tel', 'number', 'password', 'date', 'url', 'hidden'].includes(type) ? type : 'text';
    if (inputType === 'hidden') {
      parts.push(`  <input type="hidden" name="${escapeAttr(name)}" value="" />`);
      continue;
    }
    parts.push(`  <label>\n    ${escapeHtmlText(label)}\n    <input type="${inputType}" name="${escapeAttr(name)}"${required} />\n  </label>`);
  }
  parts.push('  <button type="submit">Submit</button>');
  parts.push('</form>');
  return parts.join('\n');
}

function buildLandingFormScript(formId, formKey) {
  const otpEnabled = /** @type {HTMLInputElement} */ (document.getElementById('otpEnabled'))?.checked;
  const otpField = /** @type {HTMLInputElement} */ (document.getElementById('otpField'))?.value || 'mobile';

  if (!otpEnabled) {
    return `<script>
(function () {
  var form = document.getElementById(${JSON.stringify(formId)});
  if (!form) return;

  try {
    var searchParams = new URLSearchParams(window.location.search);
    searchParams.forEach(function (val, key) {
      if (key.indexOf('utm_') === 0 && val) {
        sessionStorage.setItem('sp_' + key, val);
      }
    });
  } catch (e) {}

  function getStoredUtms() {
    var utms = {};
    try {
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if (k && k.indexOf('sp_utm_') === 0) {
          utms[k.replace('sp_', '')] = sessionStorage.getItem(k);
        }
      }
    } catch (e) {}
    return utms;
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var data = Object.fromEntries(new FormData(form).entries());
    var utms = getStoredUtms();
    Object.assign(data, utms);

    var qs = window.location.search;
    var res = await fetch(${JSON.stringify('/api/forms/' + formKey + '/submit')} + qs, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      alert(err.message || 'خطا در ثبت فرم');
      return;
    }
    alert('فرم با موفقیت ثبت شد');
    form.reset();
  });
})();
<\/script>`;
  }

  return `<script>
(function () {
  var form = document.getElementById(${JSON.stringify(formId)});
  if (!form) return;

  try {
    var searchParams = new URLSearchParams(window.location.search);
    searchParams.forEach(function (val, key) {
      if (key.indexOf('utm_') === 0 && val) {
        sessionStorage.setItem('sp_' + key, val);
      }
    });
  } catch (e) {}

  function getStoredUtms() {
    var utms = {};
    try {
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if (k && k.indexOf('sp_utm_') === 0) {
          utms[k.replace('sp_', '')] = sessionStorage.getItem(k);
        }
      }
    } catch (e) {}
    return utms;
  }

  var pendingOtpData = null;

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var data = Object.fromEntries(new FormData(form).entries());
    var utms = getStoredUtms();
    Object.assign(data, utms);

    if (pendingOtpData) {
      var code = prompt("لطفا کد تایید پیامک شده را وارد کنید:");
      if (code) data.__otpCode = code;
      
      var qs = window.location.search;
      var res = await fetch(${JSON.stringify('/api/forms/' + formKey + '/submit')} + qs, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        var err = await res.json().catch(function () { return {}; });
        alert(err.message || 'خطا در ثبت نهایی فرم');
        return;
      }
      alert('فرم با موفقیت ثبت شد');
      form.reset();
      pendingOtpData = null;
      return;
    }

    var mobile = data[${JSON.stringify(otpField)}];
    if (!mobile) {
      alert('لطفا فیلد شماره موبایل را پر کنید');
      return;
    }

    var otpRes = await fetch(${JSON.stringify('/api/forms/' + formKey + '/otp')}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: mobile }),
    });

    if (!otpRes.ok) {
      var err = await otpRes.json().catch(function () { return {}; });
      alert(err.message || 'خطا در ارسال پیامک');
      return;
    }

    alert('کد تایید ارسال شد. لطفاً فرم را دوباره سابمیت کنید تا کد پرسیده شود.');
    pendingOtpData = data;
  });
})();
<\/script>`;
}

// =====================================================================
//  Toast Notification
// =====================================================================
function showToast(message, type = 'success') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-message">${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// =====================================================================
//  File Manager (CodeMirror 6 editor + file tree)
// =====================================================================

/** آیکن‌های SVG برای گره‌های درخت */
const FM_ICONS = {
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  caret: '<svg class="ft-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>',
};

function fmFormatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/** لود تنبل CodeMirror 6 از CDN (esm) — فقط یک بار */
let __cmPromise = null;
function fmLoadCodeMirror() {
  if (__cmPromise) return __cmPromise;
  __cmPromise = (async () => {
    const [view, state, lang] = await Promise.all([
      import('https://esm.sh/@codemirror/view@6'),
      import('https://esm.sh/@codemirror/state@6'),
      import('https://esm.sh/@codemirror/language@6'),
    ]);
    const { html } = await import('https://esm.sh/@codemirror/lang-html@6');
    const { css } = await import('https://esm.sh/@codemirror/lang-css@6');
    const { javascript } = await import('https://esm.sh/@codemirror/lang-javascript@6');
    const { json } = await import('https://esm.sh/@codemirror/lang-json@6');
    const { oneDark } = await import('https://esm.sh/@codemirror/theme-one-dark@6');
    return { view, state, lang, html, css, javascript, json, oneDark };
  })();
  return __cmPromise;
}

function fmLanguageFor(cm, path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'html':
    case 'htm':
      return cm.html();
    case 'css':
      return cm.css();
    case 'js':
    case 'mjs':
      return cm.javascript();
    case 'json':
      return cm.json();
    default:
      return null;
  }
}

function initFileManager(root) {
  const treeEl = document.getElementById('file-tree');
  const landingSelect = /** @type {HTMLSelectElement} */ (document.getElementById('landing-select'));
  const editorTitle = document.getElementById('fm-editor-title');
  const editorActions = document.getElementById('fm-editor-actions');
  const emptyState = document.getElementById('fm-empty-state');
  const editorContainer = document.getElementById('fm-editor-container');
  const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('fm-editor-textarea'));
  const saveBtn = document.getElementById('fm-save-file');
  const downloadFileBtn = /** @type {HTMLAnchorElement} */ (document.getElementById('fm-download-file'));
  const slugPill = document.getElementById('fm-slug-pill');

  let slug = root.getAttribute('data-active-slug') || (landingSelect && landingSelect.value) || '';
  let treeData = [];
  try {
    const raw = document.getElementById('fm-tree-data')?.textContent || '[]';
    treeData = JSON.parse(raw);
  } catch {
    treeData = [];
  }

  let cmView = null;
  let currentPath = null;

  // --- رندر درخت فایل ---
  function renderTree(nodes, container) {
    const ul = document.createElement('ul');
    for (const node of nodes) {
      const li = document.createElement('li');
      li.className = 'ft-node';

      const row = document.createElement('div');
      row.className = 'ft-row';
      row.setAttribute('role', 'treeitem');
      row.setAttribute('data-path', node.path);
      row.setAttribute('data-type', node.type);

      if (node.type === 'directory') {
        row.innerHTML = FM_ICONS.caret + FM_ICONS.folder + '<span class="ft-name"></span>';
        const childrenUl = renderTree(node.children || [], li);
        childrenUl.classList.add('ft-children');
        row.addEventListener('click', () => {
          li.classList.toggle('open');
        });
      } else {
        row.innerHTML = '<span style="width:14px;flex-shrink:0;"></span>' + FM_ICONS.file + '<span class="ft-name"></span><span class="ft-size"></span>';
        row.querySelector('.ft-size').textContent = fmFormatSize(node.size);
        row.addEventListener('click', () => {
          openFile(node.path, row);
        });
      }
      row.querySelector('.ft-name').textContent = node.name;
      row.title = node.path;
      li.insertBefore(row, li.firstChild);
      ul.appendChild(li);
    }
    container.appendChild(ul);
    return ul;
  }

  function rebuildTree(nodes) {
    if (!treeEl) return;
    treeEl.innerHTML = '';
    if (!nodes || nodes.length === 0) {
      treeEl.innerHTML = '<div class="fm-empty-state" style="padding:2rem 1rem;"><p>پوشه لندینگ خالی است.</p></div>';
      return;
    }
    renderTree(nodes, treeEl);
  }

  rebuildTree(treeData);

  // --- ساخت / بازسازی ویرایشگر CodeMirror ---
  async function ensureEditor(content, path) {
    const cm = await fmLoadCodeMirror();
    const extensions = [
      cm.view.lineNumbers(),
      cm.view.highlightActiveLine(),
      cm.view.highlightActiveLineGutter(),
      cm.lang.syntaxHighlighting(cm.lang.defaultHighlightStyle, { fallback: true }),
      cm.oneDark,
      cm.view.EditorView.lineWrapping,
    ];
    const langExt = fmLanguageFor(cm, path);
    if (langExt) extensions.push(langExt);

    const state = cm.state.EditorState.create({
      doc: content,
      extensions,
    });

    if (cmView) {
      cmView.setState(state);
    } else {
      if (textarea) textarea.style.display = 'none';
      cmView = new cm.view.EditorView({
        state,
        parent: editorContainer,
      });
    }
  }

  function getEditorContent() {
    if (cmView) return cmView.state.doc.toString();
    return textarea ? textarea.value : '';
  }

  // --- باز کردن فایل ---
  async function openFile(path, rowEl) {
    if (!slug) return;
    document.querySelectorAll('.ft-row.active').forEach((r) => r.classList.remove('active'));
    if (rowEl) rowEl.classList.add('active');

    try {
      const res = await fetch(`/spadmin/files/api/read?slug=${encodeURIComponent(slug)}&path=${encodeURIComponent(path)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.message || 'خواندن فایل ممکن نشد (فایل باینری؟)', 'danger');
        return;
      }
      const data = await res.json();
      currentPath = path;

      if (editorTitle) editorTitle.textContent = path;
      if (emptyState) emptyState.style.display = 'none';
      if (editorContainer) editorContainer.style.display = 'block';
      if (editorActions) editorActions.style.display = 'flex';
      if (downloadFileBtn) {
        downloadFileBtn.href = `/spadmin/files/download/file?slug=${encodeURIComponent(slug)}&path=${encodeURIComponent(path)}`;
      }

      await ensureEditor(data.content, path);
    } catch (err) {
      showToast('خطا در خواندن فایل', 'danger');
    }
  }

  // --- ذخیره فایل ---
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (!slug || !currentPath) return;
      saveBtn.disabled = true;
      try {
        const res = await fetch('/spadmin/files/api/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, path: currentPath, content: getEditorContent() }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showToast(err.message || 'ذخیره فایل ناموفق بود', 'danger');
          return;
        }
        showToast(`فایل ${currentPath} ذخیره شد.`, 'success');
      } catch {
        showToast('خطا در ذخیره فایل', 'danger');
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  // --- تعویض لندینگ ---
  if (landingSelect) {
    landingSelect.addEventListener('change', () => {
      const next = landingSelect.value;
      if (next && next !== slug) {
        window.location.href = `/spadmin/files?slug=${encodeURIComponent(next)}`;
      }
    });
  }

  // --- باز کردن خودکار فایل انتخاب‌شده از سرور (اگر path در URL باشد) ---
  const urlParams = new URLSearchParams(window.location.search);
  const initialPath = urlParams.get('path');
  if (initialPath) {
    const row = treeEl ? treeEl.querySelector(`.ft-row[data-path="${CSS.escape(initialPath)}"]`) : null;
    // باز کردن گره‌های والد
    if (row) {
      let node = row.closest('.ft-node');
      while (node) {
        node.classList.add('open');
        node = node.parentElement ? node.parentElement.closest('.ft-node') : null;
      }
    }
    openFile(initialPath, row);
  }
}
