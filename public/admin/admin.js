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

  // 3. JSON Formatter & Validator in Form Editor
  const formatJsonBtn = document.getElementById('format-json-btn');
  const jsonTextarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('body'));

  if (formatJsonBtn && jsonTextarea) {
    formatJsonBtn.addEventListener('click', () => {
      try {
        const parsed = JSON.parse(jsonTextarea.value);
        jsonTextarea.value = JSON.stringify(parsed, null, 2);
        showToast('فرمت کد JSON با موفقیت مرتب شد.', 'success');
        refreshLandingSnippets();
      } catch (err) {
        showToast('خطا در خواندن JSON: فرمت وارد شده معتبر نیست!', 'danger');
      }
    });
  }

  // 4. کپی متن از data-copy (کامند نصب، اسنیپت فرم و …)
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sel = btn.getAttribute('data-copy');
      const el = sel ? document.querySelector(sel) : null;
      const text = el?.textContent?.trim() || '';
      if (!text) return;
      const okMsg =
        btn.getAttribute('data-copy-toast') || 'متن کپی شد.';
      try {
        await navigator.clipboard.writeText(text);
        showToast(okMsg, 'success');
      } catch {
        showToast('کپی نشد — دستی انتخاب کنید.', 'danger');
      }
    });
  });

  // 5. اسنیپت HTML + اسکریپت برای لندینگ (جدا از هم)
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
    jsonTextarea?.addEventListener('change', refreshLandingSnippets);
  }
});

/**
 * از فیلدهای JSON صفحه، HTML فرم و اسکریپت سابمیشن رو می‌سازه
 */
function refreshLandingSnippets() {
  const htmlEl = document.getElementById('snippet-html');
  const scriptEl = document.getElementById('snippet-script');
  if (!htmlEl || !scriptEl) return;

  const keyInput = /** @type {HTMLInputElement} */ (document.getElementById('key'));
  const bodyEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('body'));
  const key = (keyInput?.value || '').trim() || 'YOUR_FORM_KEY';

  let fields = [];
  try {
    const parsed = JSON.parse(bodyEl?.value || '[]');
    fields = Array.isArray(parsed) ? parsed : [];
  } catch {
    htmlEl.textContent =
      '<!-- Fix the JSON fields above, then refresh snippets -->';
    scriptEl.textContent =
      '<!-- Fix the JSON fields above, then refresh snippets -->';
    return;
  }

  const formId = `sp-form-${sanitizeId(key)}`;
  htmlEl.textContent = buildLandingFormHtml(formId, fields);
  scriptEl.textContent = buildLandingFormScript(formId, key);
}

/** فقط کاراکترهای امن برای id */
function sanitizeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '-') || 'form';
}

/** escape ساده برای attribute HTML */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * @param {string} formId
 * @param {Array<Record<string, unknown>>} fields
 */
function buildLandingFormHtml(formId, fields) {
  const parts = [`<form id="${escapeAttr(formId)}">`];

  for (const field of fields) {
    const name = String(field.name || '').trim();
    if (!name) continue;
    const label = String(field.label || name);
    const required = field.required ? ' required' : '';
    const type = String(field.type || 'text').toLowerCase();

    if (type === 'textarea') {
      parts.push(
        `  <label>\n    ${escapeHtmlText(label)}\n    <textarea name="${escapeAttr(name)}"${required}></textarea>\n  </label>`,
      );
      continue;
    }

    if (type === 'select') {
      const options = Array.isArray(field.options) ? field.options : [];
      const opts = options
        .map((opt) => {
          if (opt && typeof opt === 'object') {
            const o = /** @type {Record<string, unknown>} */ (opt);
            const val = String(o.value ?? o.label ?? '');
            const lab = String(o.label ?? o.value ?? '');
            return `      <option value="${escapeAttr(val)}">${escapeHtmlText(lab)}</option>`;
          }
          return `      <option value="${escapeAttr(opt)}">${escapeHtmlText(opt)}</option>`;
        })
        .join('\n');
      parts.push(
        `  <label>\n    ${escapeHtmlText(label)}\n    <select name="${escapeAttr(name)}"${required}>\n${opts}\n    </select>\n  </label>`,
      );
      continue;
    }

    if (type === 'checkbox') {
      parts.push(
        `  <label>\n    <input type="checkbox" name="${escapeAttr(name)}" value="1"${required} />\n    ${escapeHtmlText(label)}\n  </label>`,
      );
      continue;
    }

    const inputType = [
      'email',
      'tel',
      'number',
      'password',
      'date',
      'url',
      'hidden',
    ].includes(type)
      ? type
      : 'text';

    if (inputType === 'hidden') {
      parts.push(
        `  <input type="hidden" name="${escapeAttr(name)}" value="" />`,
      );
      continue;
    }

    parts.push(
      `  <label>\n    ${escapeHtmlText(label)}\n    <input type="${inputType}" name="${escapeAttr(name)}"${required} />\n  </label>`,
    );
  }

  parts.push('  <button type="submit">Submit</button>');
  parts.push('</form>');
  return parts.join('\n');
}

/**
 * @param {string} formId
 * @param {string} formKey
 */
function buildLandingFormScript(formId, formKey) {
  const otpEnabled = /** @type {HTMLInputElement} */ (document.getElementById('otpEnabled'))?.checked;
  const otpField = /** @type {HTMLInputElement} */ (document.getElementById('otpField'))?.value || 'mobile';

  if (!otpEnabled) {
    return `<script>
(function () {
  var form = document.getElementById(${JSON.stringify(formId)});
  if (!form) return;
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var data = Object.fromEntries(new FormData(form).entries());
    var res = await fetch(${JSON.stringify('/api/forms/' + formKey + '/submit')}, {
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
</script>`;
  }

  // اسکریپت با پشتیبانی از OTP
  return `<script>
(function () {
  var form = document.getElementById(${JSON.stringify(formId)});
  if (!form) return;
  
  // متغیر برای ذخیره موقت کد تایید
  var pendingOtpData = null;

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var data = Object.fromEntries(new FormData(form).entries());
    
    // اگر قبلا کد گرفته‌ایم، حالا سابمیت نهایی انجام بدهیم
    if (pendingOtpData) {
      var code = prompt("لطفا کد تایید پیامک شده را وارد کنید:");
      if (code) {
        data.__otpCode = code;
      }
      
      var res = await fetch(${JSON.stringify('/api/forms/' + formKey + '/submit')}, {
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

    // مرحله اول: درخواست کد تایید
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
</script>`;
}
    });
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      alert(err.message || 'Submit failed');
      return;
    }
    alert('Submitted successfully');
    form.reset();
  });
})();
</script>`;
}

/**
 * Display dynamic Toast Notification
 * @param {string} message 
 * @param {'success' | 'danger' | 'warning'} type 
 */
function showToast(message, type = 'success') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-message">${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}
