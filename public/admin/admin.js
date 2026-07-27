/* ==========================================================================
   Spage Admin JavaScript - Interactive UI Utilities
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
      } catch (err) {
        showToast('خطا در خواندن JSON: فرمت وارد شده معتبر نیست!', 'danger');
      }
    });
  }

  // 4. کپی کامند نصب نود
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sel = btn.getAttribute('data-copy');
      const el = sel ? document.querySelector(sel) : null;
      const text = el?.textContent?.trim() || '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        showToast('کامند نصب کپی شد.', 'success');
      } catch {
        showToast('کپی نشد — دستی انتخاب کنید.', 'danger');
      }
    });
  });
});

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
