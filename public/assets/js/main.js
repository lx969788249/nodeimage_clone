const savedTheme = localStorage.getItem('nodeimage_theme');
function detectSystemTheme() {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const state = {
  theme: savedTheme || detectSystemTheme(),
  settings: {
    compressToWebp: localStorage.getItem('ni_compressToWebp') !== 'false',
    webpQuality: Number(localStorage.getItem('ni_webpQuality')) || 95,
    autoWatermark: localStorage.getItem('ni_autoWatermark') === 'true',
    watermarkContent: localStorage.getItem('ni_watermarkContent') || '',
    autoCopyLink: localStorage.getItem('ni_autoCopyLink') === 'true',
    autoDelete: localStorage.getItem('ni_autoDelete') === 'true',
    deleteDays: Number(localStorage.getItem('ni_deleteDays')) || 30
  },
  results: [],
  history: {
    items: [],
    total: 0,
    totalPages: 1,
    currentPage: 1,
    selected: new Set(),
    formatSelection: new Map()
  },
  resultFormats: new Map(),
  user: null,
  branding: {
    name: 'Nodeimage',
    subtitle: 'NodeSeek专用图床·克隆版',
    icon: null,
    footer: 'Modified from <a href="https://www.nodeimage.com/" target="_blank" rel="noopener noreferrer">NodeImage</a>',
    registrationEnabled: false
  }
};

const els = {
  themeToggle: document.getElementById('themeToggleBtn'),
  uploadArea: document.getElementById('uploadArea'),
  fileInput: document.getElementById('fileInput'),
  progressContainer: document.getElementById('progressContainer'),
  progressText: document.getElementById('progressText'),
  resultContainer: document.getElementById('resultContainer'),
  resultCopyAllBar: document.getElementById('resultCopyAllBar'),
  copyAllDirectBtn: document.getElementById('copyAllDirectBtn'),
  copyAllHtmlBtn: document.getElementById('copyAllHtmlBtn'),
  copyAllMdBtn: document.getElementById('copyAllMdBtn'),
  copyAllBbBtn: document.getElementById('copyAllBbBtn'),
  historyView: document.getElementById('historyView'),
  mainView: document.getElementById('mainView'),
  apiView: document.getElementById('apiView'),
  historyBtn: document.getElementById('historyBtn'),
  backBtn: document.getElementById('backBtn'),
  backBtn2: document.getElementById('backBtn2'),
  apiBtn: document.getElementById('apiBtn'),
  totalImages: document.getElementById('totalImages'),
  compressToWebp: document.getElementById('compressToWebp'),
  webpQuality: document.getElementById('webpQuality'),
  qualityValue: document.getElementById('qualityValue'),
  qualityType: document.getElementById('qualityType'),
  autoWatermark: document.getElementById('autoWatermark'),
  watermarkContent: document.getElementById('watermarkContent'),
  autoCopyLink: document.getElementById('autoCopyLink'),
  autoDelete: document.getElementById('autoDelete'),
  deleteDays: document.getElementById('deleteDays'),
  daysInputInline: document.getElementById('daysInputInline'),
  settingsBtn: document.getElementById('settingsBtn'),
  backToUploadBtn: document.getElementById('backToUploadBtn'),
  flipCardInner: document.getElementById('flipCardInner'),
  settingsTooltip: document.getElementById('settingsTooltip'),
  authModal: document.getElementById('authModal'),
  openAuthBtn: document.getElementById('openAuthBtn'),
  loginUsername: document.getElementById('loginUsername'),
  loginPassword: document.getElementById('loginPassword'),
  loginBtn: document.getElementById('loginBtn'),
  userControls: document.getElementById('userControls'),
  userMenuContainer: document.querySelector('.user-menu-container'),
  username: document.getElementById('username'),
  userMenu: document.getElementById('userMenu'),
  userInfo: document.getElementById('userInfo'),
  logoutBtn: document.getElementById('logoutBtn'),
  changePasswordBtn: document.getElementById('changePasswordBtn'),
  changeCredsModal: document.getElementById('changeCredsModal'),
  changeOldPassword: document.getElementById('changeOldPassword'),
  changeNewUsername: document.getElementById('changeNewUsername'),
  changeNewPassword: document.getElementById('changeNewPassword'),
  changeNewPasswordConfirm: document.getElementById('changeNewPasswordConfirm'),
  newCredFields: document.getElementById('newCredFields'),
  changeCredsSubmit: document.getElementById('changeCredsSubmit'),
  changeCredsCancel: document.getElementById('changeCredsCancel'),
  brandName: document.getElementById('brandName'),
  brandSubtitle: document.getElementById('brandSubtitle'),
  brandLogo: document.getElementById('brandLogo'),
  brandNameInput: document.getElementById('brandNameInput'),
  brandSubtitleInput: document.getElementById('brandSubtitleInput'),
  brandIconInput: document.getElementById('brandIconInput'),
  allowRegisterInput: document.getElementById('allowRegisterInput'),
  applyBrandingBtn: document.getElementById('applyBrandingBtn'),
  usersList: document.getElementById('usersList'),
  backupDownloadBtn: document.getElementById('backupDownloadBtn'),
  backupRestoreBtn: document.getElementById('backupRestoreBtn'),
  backupFileInput: document.getElementById('backupFileInput'),
  selectAllCheckbox: document.getElementById('selectAllCheckbox'),
  selectionText: document.getElementById('selectionText'),
  batchActionsBar: document.getElementById('batchActionsBar'),
  batchOperations: document.getElementById('batchOperations'),
  batchCopyBtn: document.getElementById('batchCopyBtn'),
  batchDeleteBtn: document.getElementById('batchDeleteBtn'),
  historyCopyDropdown: document.getElementById('historyCopyDropdown'),
  imagesGrid: document.getElementById('imagesGrid'),
  historyPagination: document.getElementById('historyPagination'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  copyApiKeyBtn: document.getElementById('copyApiKeyBtn'),
  regenerateApiKeyBtn: document.getElementById('regenerateApiKeyBtn'),
  apiKeyInfo: document.getElementById('apiKeyInfo'),
  curlCopyBtns: document.querySelectorAll('.copy-curl-btn'),
  goHome: document.getElementById('goHome'),
  modal: document.getElementById('imageModal'),
  modalImage: document.getElementById('modalImage'),
  closeModal: document.getElementById('closeModal'),
  zoomSlider: document.getElementById('zoomSlider'),
  registerBtn: document.getElementById('registerBtn')
};

const allowedTypes = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif'
];

const ICONS = {
  url: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 14a5 5 0 0 1 0-7.07l1.76-1.76a5 5 0 0 1 7.07 7.07l-1.42 1.42"/><path d="M14 10a5 5 0 0 1 0 7.07l-1.76 1.76a5 5 0 0 1-7.07-7.07l1.42-1.42"/></svg>',
  html: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 512" width="18" height="18" fill="currentColor"><path d="M392.8 1.2c-17-4.9-34.7 5-39.6 22l-128 448c-4.9 17 5 34.7 22 39.6s34.7-5 39.6-22l128-448c4.9-17-5-34.7-22-39.6zm80.6 120.1c-12.5 12.5-12.5 32.8 0 45.3L562.7 256l-89.4 89.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0l112-112c12.5-12.5 12.5-32.8 0-45.3l-112-112c-12.5-12.5-32.8-12.5-45.3 0zm-306.7 0c-12.5 12.5-32.8 12.5-45.3 0l-112 112c-12.5 12.5-12.5 32.8 0 45.3l112 112c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L77.3 256l89.4-89.4c12.5-12.5 12.5-32.8 0-45.3z"/></svg>',
  markdown: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 512" width="18" height="18" fill="currentColor"><path d="M593.8 59.1H46.2C20.7 59.1 0 79.8 0 105.2v301.5c0 25.5 20.7 46.2 46.2 46.2h547.7c25.5 0 46.2-20.7 46.1-46.1V105.2c0-25.4-20.7-46.1-46.2-46.1zM338.5 360.6H277v-120l-61.5 76.9-61.5-76.9v120H92.3V151.4h61.5l61.5 76.9 61.5-76.9h61.5v209.2zm135.3 3.1L381.5 256H443V151.4h61.5v104.6h61.5L473.8 363.7z"/></svg>',
  bb: '<span class="text-icon">[BB]</span>'
};

// 修改账号密码流程的原密码验证标记
let credVerified = false;

function applyCopyAllIcons() {
  const setIcon = (el, icon) => {
    if (!el) return;
    const label = el.dataset.label || el.textContent.trim() || '复制全部';
    el.innerHTML = `${label} ${icon}`;
  };
  setIcon(els.copyAllDirectBtn, ICONS.url);
  setIcon(els.copyAllHtmlBtn, ICONS.html);
  setIcon(els.copyAllMdBtn, ICONS.markdown);
  setIcon(els.copyAllBbBtn, ICONS.bb);
  const dropdownOptions = document.querySelectorAll('.copy-option');
  dropdownOptions.forEach((opt) => {
    const type = opt.dataset.type;
    const icon =
      type === 'html'
        ? ICONS.html
        : type === 'markdown'
          ? ICONS.markdown
          : type === 'bbcode'
            ? ICONS.bb
            : ICONS.url;
    setIcon(opt, icon);
  });
}

function applyTheme(theme, { persist = true } = {}) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  document.body.setAttribute('data-theme', next);
  state.theme = next;
  if (persist) {
    localStorage.setItem('nodeimage_theme', next);
  }
  const sun = els.themeToggle.querySelector('.sun-icon');
  const moon = els.themeToggle.querySelector('.moon-icon');
  if (next === 'dark') {
    sun.style.display = 'none';
    moon.style.display = 'block';
  } else {
    sun.style.display = 'block';
    moon.style.display = 'none';
  }
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatByType(item, type) {
  const url = item.url;
  switch (type) {
    case 'html':
      return `<img src="${url}" alt="image" />`;
    case 'markdown':
      return `![image](${url})`;
    case 'bbcode':
      return `[img]${url}[/img]`;
    default:
      return url;
  }
}

function showNotification(message, type = 'info', duration = 3200) {
  const container = document.getElementById('notificationContainer');
  if (!container) return;
  const li = document.createElement('li');
  li.className = `notification ${type}`;
  li.innerHTML = `
    <div class="notification-content">
      <div class="notification-icon">${type === 'error' ? '!' : type === 'success' ? '✓' : 'i'}</div>
      <div class="notification-text">${message}</div>
    </div>
    <div class="notification-progress-bar"></div>
  `;
  container.appendChild(li);
  setTimeout(() => li.classList.add('show'), 20);
  setTimeout(() => {
    li.classList.remove('show');
    setTimeout(() => li.remove(), 400);
  }, duration);
}

async function copyText(text, message = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
    showNotification(message, 'success');
  } catch (err) {
    console.error(err);
    showNotification('复制失败，请手动选择文本', 'error');
  }
}

function toggleAuthModal(show) {
  els.authModal.style.display = show ? 'flex' : 'none';
}

function toggleChangeCredsModal(show) {
  if (!els.changeCredsModal) return;
  els.changeCredsModal.style.display = show ? 'flex' : 'none';
  if (show) {
    els.changeOldPassword.value = '';
    els.changeNewUsername.value = '';
    els.changeNewPassword.value = '';
    if (els.changeNewPasswordConfirm) els.changeNewPasswordConfirm.value = '';
    if (els.newCredFields) els.newCredFields.style.display = 'none';
    credVerified = false;
  }
}

async function refreshUserStatus() {
  try {
    const res = await fetch('/api/user/status', { credentials: 'include' });
    if (!res.ok) throw new Error('status');
    const data = await res.json();
    if (data.authenticated) {
      state.user = data;
      els.username.textContent = data.username;
      els.userControls.style.display = 'flex';
      els.openAuthBtn.style.display = 'none';
      els.openAuthBtn.classList.add('hidden-auth');
    } else {
      state.user = null;
      els.userControls.style.display = 'none';
      els.openAuthBtn.style.display = 'inline-flex';
      els.openAuthBtn.classList.remove('hidden-auth');
    }
  } catch (err) {
    console.error(err);
    state.user = null;
    els.userControls.style.display = 'none';
    els.openAuthBtn.style.display = 'inline-flex';
    els.openAuthBtn.classList.remove('hidden-auth');
  }
  if (els.registerBtn) {
    const showReg = state.branding.registrationEnabled && !state.user;
    els.registerBtn.style.display = showReg ? 'inline-flex' : 'none';
  }
  setSettingsEnabled(Boolean(state.user));

  if (isAdminUser()) {
    loadAdminUsers();
  } else if (els.usersList) {
    els.usersList.innerHTML = '<div class="text-muted">仅管理员可见</div>';
  }
}

async function updateStats() {
  try {
    if (!state.user) {
      els.totalImages.textContent = '';
      els.totalImages.classList.add('hide-badge');
      return;
    }
    const res = await fetch('/api/images?page=1&limit=1', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    els.totalImages.textContent = data.total ?? 0;
    els.totalImages.classList.remove('hide-badge');
  } catch (err) {
    console.error(err);
  }
}

function syncSettingsUi() {
  els.compressToWebp.checked = state.settings.compressToWebp;
  els.webpQuality.value = state.settings.webpQuality;
  els.qualityValue.textContent = state.settings.webpQuality;
  els.qualityType.textContent = state.settings.webpQuality >= 90 ? '高质量' : state.settings.webpQuality >= 70 ? '平衡' : '体积优先';
  els.autoWatermark.checked = state.settings.autoWatermark;
  if (els.watermarkContent) els.watermarkContent.value = state.settings.watermarkContent || '';
  els.autoCopyLink.checked = state.settings.autoCopyLink;
  els.autoDelete.checked = state.settings.autoDelete;
  els.deleteDays.value = state.settings.deleteDays;
  els.daysInputInline.style.display = state.settings.autoDelete ? 'flex' : 'none';
}

function persistSettings() {
  localStorage.setItem('ni_compressToWebp', String(state.settings.compressToWebp));
  localStorage.setItem('ni_webpQuality', String(state.settings.webpQuality));
  localStorage.setItem('ni_autoWatermark', String(state.settings.autoWatermark));
  localStorage.setItem('ni_watermarkContent', state.settings.watermarkContent || '');
  localStorage.setItem('ni_autoCopyLink', String(state.settings.autoCopyLink));
  localStorage.setItem('ni_autoDelete', String(state.settings.autoDelete));
  localStorage.setItem('ni_deleteDays', String(state.settings.deleteDays));
}

function showProgress(text) {
  els.progressText.textContent = text;
  els.progressContainer.style.display = 'flex';
}

function hideProgress() {
  els.progressContainer.style.display = 'none';
}

function switchView(view) {
  // 始终保持 mainView 可见，内部切换子视图
  if (els.mainView) els.mainView.style.display = 'block';
  if (els.uploadArea) els.uploadArea.style.display = view === 'main' ? 'block' : 'none';
  els.historyView.style.display = view === 'history' ? 'flex' : 'none';
  els.apiView.style.display = view === 'api' ? 'block' : 'none';
  // 隐藏/显示 flip-card 整体，避免占位
  const flipCard = document.querySelector('.flip-card');
  if (flipCard) {
    flipCard.style.display = view === 'main' ? 'block' : 'none';
  }
  els.backBtn.style.display = view !== 'main' ? 'inline-flex' : 'none';
  els.backBtn2.style.display = 'none';
  if (view !== 'main') {
    state.results = [];
    state.resultFormats.clear();
    els.resultContainer.innerHTML = '';
    els.resultContainer.style.display = 'none';
    if (els.resultCopyAllBar) els.resultCopyAllBar.style.display = 'none';
  } else if (state.results.length) {
    els.resultContainer.style.display = 'grid';
    if (els.resultCopyAllBar) els.resultCopyAllBar.style.display = 'flex';
  } else if (els.resultCopyAllBar) {
    els.resultCopyAllBar.style.display = 'none';
  }
}

function flipToSettings(showSettings) {
  els.flipCardInner.classList.toggle('flipped', showSettings);
}

function buildUrlButtons(result, withActive = false, onChange, activeType = 'direct') {
  const formats = [
    { type: 'direct', label: '直链', value: result.url },
    { type: 'html', label: 'HTML', value: result.html },
    { type: 'markdown', label: 'Markdown', value: result.markdown },
    { type: 'bbcode', label: 'BBCode', value: result.bbcode }
  ];
  const container = document.createElement('div');
  container.className = `url-buttons glass-radio-group ${activeType || 'direct'}`;
  const glider = document.createElement('div');
  glider.className = 'glass-glider';
  container.appendChild(glider);

  formats.forEach((fmt, idx) => {
    const btn = document.createElement('button');
    const isActive = withActive && (fmt.type === activeType || (!activeType && idx === 0));
    btn.className = `format-btn ${isActive ? 'active' : ''}`;
    btn.innerHTML = fmt.icon || fmt.label;
    if (isActive) container.classList.add(fmt.type);
    btn.addEventListener('click', () => {
      container.querySelectorAll('.format-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      container.classList.remove('direct', 'html', 'markdown', 'bbcode');
      container.classList.add(fmt.type);
      if (onChange) {
        onChange(fmt.value, btn, fmt.type);
      }
      copyText(fmt.value, `${fmt.label} 已复制`);
    });
    container.appendChild(btn);
  });
  return container;
}

function renderResults() {
  if (!state.results.length) {
    els.resultContainer.style.display = 'none';
    if (els.resultCopyAllBar) els.resultCopyAllBar.style.display = 'none';
    return;
  }
  if (els.resultCopyAllBar) {
    els.resultCopyAllBar.style.display = state.results.length >= 2 ? 'flex' : 'none';
  }
  els.resultContainer.style.display = 'grid';
  els.resultContainer.innerHTML = '';
  state.results.forEach((res) => {
    const formatKey = res.id || res.filename || res.url;
    const currentFormat = state.resultFormats.get(formatKey) || 'direct';
    if (!state.resultFormats.has(formatKey)) state.resultFormats.set(formatKey, currentFormat);

    const card = document.createElement('div');
    card.className = 'history-card upload-history-card';

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'thumb-wrap';
    const imageEl = document.createElement('img');
    imageEl.src = res.thumbUrl || res.url;
    imageEl.alt = '图片';
    imageEl.loading = 'lazy';
    thumbWrap.appendChild(imageEl);
    thumbWrap.addEventListener('click', () => openImageModal(res.url));
    card.appendChild(thumbWrap);

    const body = document.createElement('div');
    body.className = 'body';

    const titleRow = document.createElement('div');
    titleRow.className = 'title-row';
    const idSpan = document.createElement('div');
    idSpan.className = 'id';
    idSpan.textContent = res.id || res.filename || '图片';
    const dateSpan = document.createElement('div');
    dateSpan.className = 'date';
    const sizeText = formatSize(res.size) || '';
    dateSpan.textContent = `${sizeText ? `${sizeText} · ` : ''}已上传`;
    titleRow.appendChild(idSpan);
    titleRow.appendChild(dateSpan);
    body.appendChild(titleRow);

    const linkInputWrap = document.createElement('div');
    linkInputWrap.className = 'link-input';
    const linkInput = document.createElement('input');
    linkInput.value = formatValue(res, currentFormat);
    linkInput.readOnly = true;
    linkInputWrap.appendChild(linkInput);
    body.appendChild(linkInputWrap);

    const formats = [
      { label: '直链', type: 'direct', value: formatValue(res, 'direct'), color: '#a4fe81', icon: ICONS.url },
      { label: 'HTML', type: 'html', value: formatValue(res, 'html'), color: '#ffe488', icon: ICONS.html },
      { label: 'Markdown', type: 'markdown', value: formatValue(res, 'markdown'), color: '#ffe488', icon: ICONS.markdown },
      { label: '[BB]', type: 'bbcode', value: formatValue(res, 'bbcode'), color: '#ffa590', icon: '[BB]' }
    ];
    const formatRow = createFormatSelector(formats, currentFormat, (f) => {
      state.resultFormats.set(formatKey, f.type);
      linkInput.value = f.value;
      copyText(f.value, `${f.label} 已复制`);
    });
    body.appendChild(formatRow);

    card.appendChild(body);
    els.resultContainer.appendChild(card);
  });
}

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('image', file);
  formData.append('compressToWebp', state.settings.compressToWebp);
  formData.append('webpQuality', state.settings.webpQuality);
  formData.append('autoWatermark', state.settings.autoWatermark);
  formData.append('watermarkContent', state.settings.watermarkContent || '');
  formData.append('autoCopyLink', state.settings.autoCopyLink);
  formData.append('autoDelete', state.settings.autoDelete);
  formData.append('deleteDays', state.settings.deleteDays);

  showProgress('上传中...');
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
      credentials: 'include'
    });
    if (res.status === 401) {
      toggleAuthModal(true);
      showNotification('请先完成授权', 'error');
      return null;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || '上传失败');
    const result = {
      ...data,
      filename: file.name
    };
    state.results.unshift(result);
    renderResults();
    if (state.settings.autoCopyLink) {
      await copyText(data.url, '直链已自动复制');
    }
    showNotification(`${file.name} 上传完成`, 'success');
    updateStats();
    return result;
  } catch (err) {
    console.error(err);
    showNotification(err.message || '上传失败', 'error');
    return null;
  } finally {
    hideProgress();
  }
}

async function handleFiles(fileList) {
  if (!state.user) {
    toggleAuthModal(true);
    return;
  }
  const files = Array.from(fileList || []).filter((f) => allowedTypes.includes(f.type));
  if (!files.length) {
    showNotification('请选择支持的图片格式', 'error');
    return;
  }
  for (const file of files) {
    await uploadFile(file);
  }
}

function renderHistory() {
  els.imagesGrid.innerHTML = '';
  state.history.items.forEach((img) => {
    const card = document.createElement('div');
    card.className = `history-card ${state.history.selected.has(img.id) ? 'selected' : ''}`;
    const currentFormat = state.history.formatSelection.get(img.id) || 'direct';

    const checkboxWrap = document.createElement('div');
    checkboxWrap.className = 'checkbox-abs';
    const cbInput = document.createElement('input');
    cbInput.type = 'checkbox';
    cbInput.id = `checkbox-${img.id}`;
    cbInput.checked = state.history.selected.has(img.id);
    const cbLabel = document.createElement('label');
    cbLabel.setAttribute('for', cbInput.id);
    cbInput.addEventListener('change', (e) => {
      if (e.target.checked) state.history.selected.add(img.id);
      else state.history.selected.delete(img.id);
      updateBatchBar();
      renderHistory();
    });
    checkboxWrap.appendChild(cbInput);
    checkboxWrap.appendChild(cbLabel);
    card.appendChild(checkboxWrap);

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'thumb-wrap';
    const imageEl = document.createElement('img');
    imageEl.src = img.thumbUrl || img.url;
    imageEl.alt = '图片';
    imageEl.loading = 'lazy';
    thumbWrap.appendChild(imageEl);
    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.title = '删除';
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteImages([img.id]);
    });
    thumbWrap.appendChild(delBtn);
    thumbWrap.addEventListener('click', () => openImageModal(img.url));
    card.appendChild(thumbWrap);

    const body = document.createElement('div');
    body.className = 'body';
    const titleRow = document.createElement('div');
    titleRow.className = 'title-row';
    const idSpan = document.createElement('div');
    idSpan.className = 'id';
    idSpan.textContent = img.id;
    const dateSpan = document.createElement('div');
    dateSpan.className = 'date';
    const sizeText = formatSize(img.size) || '';
    const dateText = img.createdAt ? new Date(img.createdAt).toLocaleDateString() : '';
    dateSpan.textContent = `${dateText}${sizeText ? ` · ${sizeText}` : ''}`;
    titleRow.appendChild(idSpan);
    titleRow.appendChild(dateSpan);
    body.appendChild(titleRow);

    const linkInputWrap = document.createElement('div');
    linkInputWrap.className = 'link-input';
    const linkInput = document.createElement('input');
    linkInput.value = formatValue(img, currentFormat);
    linkInput.readOnly = true;
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', () => copyText(linkInput.value, '链接已复制'));
    linkInputWrap.appendChild(linkInput);
    
    body.appendChild(linkInputWrap);

    const formats = [
      { label: '直链', type: 'direct', value: formatValue(img, 'direct'), color: '#a4fe81', icon: ICONS.url },
      { label: 'HTML', type: 'html', value: formatValue(img, 'html'), color: '#ffe488', icon: ICONS.html },
      { label: 'Markdown', type: 'markdown', value: formatValue(img, 'markdown'), color: '#ffe488', icon: ICONS.markdown },
      { label: '[BB]', type: 'bbcode', value: formatValue(img, 'bbcode'), color: '#ffa590', icon: '[BB]' }
    ];
    const formatRow = createFormatSelector(formats, currentFormat, (f) => {
      state.history.formatSelection.set(img.id, f.type);
      linkInput.value = f.value;
      copyText(f.value, `${f.label} 已复制`);
    });
    body.appendChild(formatRow);

    card.appendChild(body);
    els.imagesGrid.appendChild(card);
  });
  renderPagination();
  updateBatchBar();
}

function renderPagination() {
  const { currentPage, totalPages, total } = state.history;
  els.historyPagination.innerHTML = '';
  const info = document.createElement('div');
  info.className = 'pagination-info';
  info.textContent = `第 ${currentPage} / ${totalPages} 页，共 ${total} 张图片`;
  const controls = document.createElement('div');
  controls.className = 'pagination-controls';

  function addBtn(label, page, disabled = false, active = false) {
    const btn = document.createElement('button');
    btn.className = `pagination-btn ${active ? 'active' : ''} ${disabled ? 'disabled' : ''}`;
    btn.textContent = label;
    btn.disabled = disabled;
    if (!disabled) btn.addEventListener('click', () => loadHistory(page));
    controls.appendChild(btn);
  }

  addBtn('上一页', Math.max(1, currentPage - 1), currentPage === 1);
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 2) {
      addBtn(String(i), i, false, i === currentPage);
    } else if (i === 2 || i === totalPages - 1) {
      const span = document.createElement('span');
      span.className = 'pagination-ellipsis';
      span.textContent = '...';
      controls.appendChild(span);
    }
  }
  addBtn('下一页', Math.min(totalPages, currentPage + 1), currentPage === totalPages);

  els.historyPagination.appendChild(controls);
  els.historyPagination.appendChild(info);
}

function updateBatchBar() {
  const selectedCount = state.history.selected.size;
  const total = state.history.items.length;
  els.batchActionsBar.style.display = total ? 'block' : 'none';
  els.batchOperations.classList.toggle('visible', selectedCount > 0);
  els.selectionText.textContent = selectedCount ? `已选择 ${selectedCount} 张` : '全选';
  const checkbox = els.selectAllCheckbox;
  checkbox.checked = selectedCount === total && total > 0;
  checkbox.indeterminate = selectedCount > 0 && selectedCount < total;
  if (els.historyCopyDropdown && selectedCount < 2) {
    els.historyCopyDropdown.style.display = 'none';
  }
}

function formatValue(img, type) {
  switch (type) {
    case 'markdown':
      return `![image](${img.url})`;
    case 'html':
      return `<img src=\"${img.url}\" alt=\"image\" />`;
    case 'bbcode':
      return `[img]${img.url}[/img]`;
    default:
      return img.url;
  }
}

function copyAllLinks(type, scope) {
  const list = scope === 'history' ? state.history.items : state.results;
  if (!list || !list.length) {
    showNotification('暂无可复制的链接', 'error');
    return;
  }
  const text = list.map((item) => formatValue(item, type)).filter(Boolean).join('\n');
  if (!text) {
    showNotification('暂无可复制的链接', 'error');
    return;
  }
  copyText(text, `已复制 ${list.length} 条`);
}

async function logoutUser() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  state.user = null;
  await refreshUserStatus();
  await updateStats();
  showNotification('已注销', 'success');
}

function createFormatSelector(formats, currentType, onSelect) {
  const row = document.createElement('div');
  row.className = 'icon-format-row';
  const indicator = document.createElement('div');
  indicator.className = 'format-indicator';
  row.appendChild(indicator);
  const buttons = [];
  let activeBtn = null;

  formats.forEach((f, i) => {
    const btn = document.createElement('button');
    btn.className = 'format-icon-btn';
    btn.dataset.color = f.color;
    btn.dataset.type = f.type;
    btn.innerHTML = typeof f.icon === 'string' && f.icon.startsWith('<') ? f.icon : `<span class="text-icon">${f.icon}</span>`;
    btn.title = f.label;
    if (f.type === currentType || (!activeBtn && i === 0)) {
      activeBtn = btn;
    }
    btn.addEventListener('click', () => {
      if (activeBtn === btn) {
        onSelect(f);
        return;
      }
      activeBtn = btn;
      setIndicator();
      onSelect(f);
    });
    buttons.push(btn);
    row.appendChild(btn);
  });

  function setIndicator() {
    if (!activeBtn) return;
    indicator.style.width = `${activeBtn.offsetWidth}px`;
    indicator.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
    indicator.style.background = activeBtn.dataset.color || 'var(--color-primary)';
    buttons.forEach((b) => b.classList.toggle('active', b === activeBtn));
  }

  requestAnimationFrame(setIndicator);
  return row;
}

async function loadHistory(page = 1) {
  if (!state.user) {
    toggleAuthModal(true);
    return;
  }
  try {
    const res = await fetch(`/api/images?page=${page}&limit=12`, { credentials: 'include' });
    if (res.status === 401) {
      toggleAuthModal(true);
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || '获取历史失败');
    state.history.items = data.items || [];
    state.history.total = data.total || 0;
    state.history.totalPages = data.totalPages || 1;
    state.history.currentPage = data.currentPage || page;
    state.history.selected.clear();
    state.history.formatSelection = new Map();
    renderHistory();
    switchView('history');
  } catch (err) {
    console.error(err);
    showNotification(err.message, 'error');
  }
}

async function deleteImages(ids) {
  if (!ids.length) return;
  if (!confirm(`确定要删除选中的 ${ids.length} 张图片吗？`)) return;
  try {
    const res = await fetch('/api/images/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
      credentials: 'include'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || '删除失败');
    showNotification('删除完成', 'success');
    await loadHistory(state.history.currentPage);
    updateStats();
  } catch (err) {
    console.error(err);
    showNotification(err.message, 'error');
  }
}

function openImageModal(url) {
  els.modalImage.src = url;
  els.modalImage.style.transform = 'translate(-50%, -50%) scale(1)';
  els.zoomSlider.value = 1;
  els.modal.style.display = 'flex';
}

function closeImageModal() {
  els.modal.style.display = 'none';
  els.modalImage.src = '';
}

function bindModalInteractions() {
  let isPanning = false;
  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let currentY = 0;
  let scale = 1;

  els.zoomSlider.addEventListener('input', () => {
    scale = Number(els.zoomSlider.value);
    updateTransform();
  });

  function updateTransform() {
    els.modalImage.style.transform = `translate(calc(-50% + ${currentX}px), calc(-50% + ${currentY}px)) scale(${scale})`;
  }

  els.modalImage.addEventListener('mousedown', (e) => {
    isPanning = true;
    startX = e.clientX - currentX;
    startY = e.clientY - currentY;
    els.modalImage.classList.add('panning');
  });

  window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    currentX = e.clientX - startX;
    currentY = e.clientY - startY;
    updateTransform();
  });

  window.addEventListener('mouseup', () => {
    isPanning = false;
    els.modalImage.classList.remove('panning');
  });

  els.modal.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    scale = Math.min(5, Math.max(0.2, scale + delta));
    els.zoomSlider.value = scale;
    updateTransform();
  });

  els.closeModal.addEventListener('click', closeImageModal);
  els.modal.addEventListener('click', (e) => {
    if (e.target === els.modal) closeImageModal();
  });
}

async function loadApiKey() {
  if (!state.user) return;
  try {
    const res = await fetch('/api/user/api-key', { credentials: 'include' });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || '获取失败');
    els.apiKeyInput.value = data.apiKey;
    els.apiKeyInfo.textContent = `保管好您的密钥，上传接口需要在 Header 中附带 X-API-Key。`;
  } catch (err) {
    console.error(err);
    showNotification(err.message, 'error');
  }
}

async function regenerateApiKey() {
  if (!confirm('确定要重新生成 API 密钥吗？旧密钥将失效。')) return;
  try {
    const res = await fetch('/api/user/regenerate-api-key', { method: 'POST', credentials: 'include' });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || '重新生成失败');
    els.apiKeyInput.value = data.apiKey;
    await copyText(data.apiKey, '新 API 密钥已复制');
  } catch (err) {
    console.error(err);
    showNotification(err.message, 'error');
  }
}

function isAdminUser() {
  return state.user && (state.user.username === 'admin' || state.user.id === 'admin' || state.user.level >= 9);
}

async function loginUser() {
  const username = els.loginUsername.value.trim();
  const password = els.loginPassword.value;
  if (!username || !password) {
    showNotification('请输入用户名和密码', 'error');
    return;
  }
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      credentials: 'include'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || '操作失败');
    showNotification(data.message || '成功', 'success');
    els.loginPassword.value = '';
    await refreshUserStatus();
    await updateStats();
    toggleAuthModal(false);
    setSettingsEnabled(true);
  } catch (err) {
    console.error(err);
    showNotification(err.message, 'error');
  }
}

async function registerUser() {
  const username = els.loginUsername.value.trim();
  const password = els.loginPassword.value;
  if (!username || !password) {
    showNotification('请输入用户名和密码', 'error');
    return;
  }
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      credentials: 'include'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || '注册失败');
    showNotification(data.message || '注册成功', 'success');
    els.loginPassword.value = '';
    await refreshUserStatus();
    await updateStats();
    toggleAuthModal(false);
    setSettingsEnabled(true);
  } catch (err) {
    console.error(err);
    showNotification(err.message || '注册失败', 'error');
  }
}

function setupEventListeners() {
  els.themeToggle.addEventListener('click', () => applyTheme(state.theme === 'light' ? 'dark' : 'light'));
  els.settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.user) {
      toggleAuthModal(true);
      return;
    }
    if (!isAdminUser()) {
      showNotification('权限不足', 'error');
      return;
    }
    flipToSettings(true);
    loadAdminUsers();
  });
  els.backToUploadBtn.addEventListener('click', () => flipToSettings(false));
  // 只允许点击上传内容区域触发 fileInput，避免点击 result-container 触发
  if (els.uploadArea) {
    const uploadContent = els.uploadArea.querySelector('.upload-content');
    if (uploadContent) {
      uploadContent.addEventListener('click', (e) => {
        if (e.target.closest('.card-corner-btn')) return;
        els.fileInput.click();
      });
      uploadContent.addEventListener('mouseenter', () => els.uploadArea.classList.add('hovering'));
      uploadContent.addEventListener('mouseleave', () => els.uploadArea.classList.remove('hovering'));
    }
  }
  els.fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
  els.uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.uploadArea.classList.add('dragover');
  });
  els.uploadArea.addEventListener('dragleave', () => els.uploadArea.classList.remove('dragover'));
  els.uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    els.uploadArea.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData?.files;
    if (items && items.length) handleFiles(items);
  });

  els.historyBtn.addEventListener('click', () => loadHistory(1));
  els.apiBtn.addEventListener('click', () => {
    switchView('api');
    loadApiKey();
  });
  els.backBtn.addEventListener('click', () => {
    state.results = [];
    els.resultContainer.innerHTML = '';
    switchView('main');
  });
  els.backBtn2.addEventListener('click', () => {
    state.results = [];
    els.resultContainer.innerHTML = '';
    switchView('main');
  });
  els.goHome?.addEventListener('click', () => switchView('main'));

  els.compressToWebp.addEventListener('change', (e) => {
    state.settings.compressToWebp = e.target.checked;
    persistSettings();
  });
  els.webpQuality.addEventListener('input', (e) => {
    state.settings.webpQuality = Number(e.target.value);
    syncSettingsUi();
    persistSettings();
  });
  els.autoWatermark.addEventListener('change', (e) => {
    state.settings.autoWatermark = e.target.checked;
    syncSettingsUi();
    persistSettings();
  });
  if (els.watermarkContent) {
    els.watermarkContent.addEventListener('input', (e) => {
      state.settings.watermarkContent = e.target.value;
      persistSettings();
    });
  }
  els.autoCopyLink.addEventListener('change', (e) => {
    state.settings.autoCopyLink = e.target.checked;
    persistSettings();
  });
  els.autoDelete.addEventListener('change', (e) => {
    state.settings.autoDelete = e.target.checked;
    syncSettingsUi();
    persistSettings();
  });
  els.deleteDays.addEventListener('input', (e) => {
    const num = Math.min(365, Math.max(1, Number(e.target.value) || 30));
    state.settings.deleteDays = num;
    persistSettings();
  });

  els.openAuthBtn.addEventListener('click', () => toggleAuthModal(true));
  els.authModal.addEventListener('click', (e) => {
    if (e.target === els.authModal) toggleAuthModal(false);
  });

  els.userInfo.addEventListener('click', () => {
    const isOpen = els.userMenuContainer?.classList.contains('open');
    if (isOpen) {
      els.userMenuContainer.classList.remove('open');
      if (els.userMenu) els.userMenu.style.display = 'none';
    } else {
      els.userMenuContainer?.classList.add('open');
      if (els.userMenu) els.userMenu.style.display = 'block';
    }
  });
  document.addEventListener('click', (e) => {
    if (els.userMenu && !els.userMenu.contains(e.target) && !els.userInfo.contains(e.target)) {
      els.userMenu.style.display = 'none';
      els.userMenuContainer?.classList.remove('open');
    }
  });
  els.logoutBtn.addEventListener('click', async () => {
    await logoutUser();
  });
  // Branding listeners
  if (els.applyBrandingBtn) {
    els.applyBrandingBtn.addEventListener('click', () => {
      if (!state.user) {
        toggleAuthModal(true);
        return;
      }
      applyBrandingFromInputs();
    });
  }

  if (els.changePasswordBtn) {
    els.changePasswordBtn.addEventListener('click', () => {
      if (!state.user) {
        toggleAuthModal(true);
        return;
      }
      credVerified = false;
      if (els.changeOldPassword) els.changeOldPassword.value = '';
      if (els.changeNewUsername) els.changeNewUsername.value = '';
      if (els.changeNewPassword) els.changeNewPassword.value = '';
      if (els.changeNewPasswordConfirm) els.changeNewPasswordConfirm.value = '';
      if (els.newCredFields) els.newCredFields.style.display = 'none';
      toggleChangeCredsModal(true);
    });
  }

  if (els.changeCredsCancel) {
    els.changeCredsCancel.addEventListener('click', (e) => {
      e.preventDefault();
      toggleChangeCredsModal(false);
    });
  }
  if (els.changeCredsModal) {
    els.changeCredsModal.addEventListener('click', (e) => {
      if (e.target === els.changeCredsModal) toggleChangeCredsModal(false);
    });
  }

  if (els.changeCredsSubmit) {
    els.changeCredsSubmit.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!state.user) {
        toggleChangeCredsModal(false);
        toggleAuthModal(true);
        return;
      }
      const oldPassword = (els.changeOldPassword.value || '').trim();
      // 如果还未验证原密码，先验证当前用户的原密码
      if (!credVerified) {
        if (!oldPassword) {
          showNotification('请输入原密码', 'error');
          return;
        }
        try {
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: state.user.username, password: oldPassword }),
            credentials: 'include'
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.message || '原密码验证失败');
          credVerified = true;
          if (els.newCredFields) els.newCredFields.style.display = 'block';
          showNotification('原密码验证通过，请输入新用户名和新密码', 'success');
        } catch (err) {
          console.error(err);
          showNotification(err.message || '原密码错误', 'error');
        }
        return;
      }

      const newUsername = (els.changeNewUsername.value || '').trim();
      const newPassword = (els.changeNewPassword.value || '').trim();
      const newPasswordConfirm = (els.changeNewPasswordConfirm.value || '').trim();
      if (!newUsername || !newPassword || !newPasswordConfirm) {
        showNotification('请完整填写新用户名和两次新密码', 'error');
        return;
      }
      if (newPassword !== newPasswordConfirm) {
        showNotification('两次输入的新密码不一致', 'error');
        return;
      }
      try {
        const res = await fetch('/api/user/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldPassword, newUsername, newPassword }),
          credentials: 'include'
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message || '修改失败');
        showNotification(data.message || '账号密码已更新，请重新登录', 'success');
        toggleChangeCredsModal(false);
        await logoutUser();
        toggleAuthModal(true);
      } catch (err) {
        console.error(err);
        showNotification(err.message, 'error');
      }
    });
  }

  els.loginBtn.addEventListener('click', () => loginUser());
  if (els.registerBtn) {
    els.registerBtn.addEventListener('click', () => registerUser());
  }

  // 只保留一个返回按钮
  els.backBtn2.style.display = 'none';

  els.selectAllCheckbox.addEventListener('change', (e) => {
    if (e.target.checked) {
      state.history.items.forEach((img) => state.history.selected.add(img.id));
    } else {
      state.history.selected.clear();
    }
    renderHistory();
  });

  els.batchCopyBtn.addEventListener('click', () => {
    const count = state.history.selected.size;
    if (count < 2) {
      showNotification('请选择至少两张图片', 'error');
      return;
    }
    if (els.historyCopyDropdown) {
      const isShown = els.historyCopyDropdown.style.display === 'flex';
      els.historyCopyDropdown.style.display = isShown ? 'none' : 'flex';
    }
  });
  els.batchDeleteBtn.addEventListener('click', () => deleteImages(Array.from(state.history.selected)));

  const bindCopyAll = (btn, type, scope) => {
    if (!btn) return;
    btn.addEventListener('click', () => copyAllLinks(type, scope));
  };
  bindCopyAll(els.copyAllDirectBtn, 'direct', 'results');
  bindCopyAll(els.copyAllHtmlBtn, 'html', 'results');
  bindCopyAll(els.copyAllMdBtn, 'markdown', 'results');
  bindCopyAll(els.copyAllBbBtn, 'bbcode', 'results');

  if (els.historyCopyDropdown) {
    const options = els.historyCopyDropdown.querySelectorAll('.copy-option');
    options.forEach((opt) => {
      opt.addEventListener('click', () => {
        const type = opt.dataset.type;
        copyAllLinks(type === 'bbcode' ? 'bbcode' : type, 'history');
        els.historyCopyDropdown.style.display = 'none';
      });
    });
    document.addEventListener('click', (e) => {
      if (!els.historyCopyDropdown) return;
      if (els.historyCopyDropdown.style.display === 'none') return;
      if (els.batchCopyBtn.contains(e.target) || els.historyCopyDropdown.contains(e.target)) return;
      els.historyCopyDropdown.style.display = 'none';
    });
  }

  if (els.backupDownloadBtn) {
    els.backupDownloadBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/backup', { credentials: 'include' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message || '备份失败');
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `nodeimage-backup-${Date.now()}.tar.gz`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showNotification('备份已生成并下载', 'success');
      } catch (err) {
        showNotification(err.message || '备份失败', 'error');
      }
    });
  }

  if (els.backupRestoreBtn && els.backupFileInput) {
    els.backupRestoreBtn.addEventListener('click', () => els.backupFileInput.click());
    els.backupFileInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('backup', file);
      try {
        const res = await fetch('/api/backup/restore', {
          method: 'POST',
          body: formData,
          credentials: 'include'
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || '恢复失败');
        showNotification('备份已恢复，稍后刷新数据', 'success');
        setTimeout(() => window.location.reload(), 800);
      } catch (err) {
        showNotification(err.message || '恢复失败', 'error');
      } finally {
        e.target.value = '';
      }
    });
  }

  els.copyApiKeyBtn.addEventListener('click', () => {
  if (els.apiKeyInput.value) copyText(els.apiKeyInput.value, 'API 密钥已复制');
});
  els.regenerateApiKeyBtn.addEventListener('click', regenerateApiKey);

  els.curlCopyBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const text = document.getElementById(targetId)?.textContent || '';
      copyText(text, 'cURL 已复制');
    });
  });

  if (els.brandNameInput) els.brandNameInput.addEventListener('input', handleBrandingInput);
  if (els.brandSubtitleInput) els.brandSubtitleInput.addEventListener('input', handleBrandingInput);
  if (els.brandIconInput) els.brandIconInput.addEventListener('input', handleBrandingInput);
  if (els.allowRegisterInput) els.allowRegisterInput.addEventListener('change', handleBrandingInput);

  // --- 备份设置 ---
  const elsBackup = {
    saveBtn: document.getElementById('saveBackupSettingsBtn'),
    intervalHours: document.getElementById('backupIntervalHours'),
    keepCount: document.getElementById('backupKeepCount'),
    s3Endpoint: document.getElementById('s3Endpoint'),
    s3Region: document.getElementById('s3Region'),
    s3Bucket: document.getElementById('s3Bucket'),
    s3AccessKey: document.getElementById('s3AccessKey'),
    s3SecretKey: document.getElementById('s3SecretKey'),
    webhookUrl: document.getElementById('backupWebhookUrl'),
    testS3Btn: document.getElementById('testS3Btn'),
    testS3Result: document.getElementById('testS3Result'),
    testWebhookBtn: document.getElementById('testWebhookBtn'),
    testWebhookResult: document.getElementById('testWebhookResult'),
    triggerBtn: document.getElementById('triggerBackupBtn'),
    backupStatus: document.getElementById('backupStatus')
  };

  async function loadBackupSettings() {
    try {
      const res = await fetch('/api/settings/backup', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (elsBackup.intervalHours) elsBackup.intervalHours.value = data.intervalHours;
      if (elsBackup.keepCount) elsBackup.keepCount.value = data.keepCount;
      if (elsBackup.s3Endpoint) elsBackup.s3Endpoint.value = data.s3Endpoint || '';
      if (elsBackup.s3Region) elsBackup.s3Region.value = data.s3Region || '';
      if (elsBackup.s3Bucket) elsBackup.s3Bucket.value = data.s3Bucket || '';
      if (elsBackup.s3AccessKey) elsBackup.s3AccessKey.value = data.s3AccessKey || '';
      if (elsBackup.webhookUrl) elsBackup.webhookUrl.value = data.webhookUrl || '';
      // s3SecretKey is masked by server, don't overwrite if user is editing
    } catch (err) {
      console.error('loadBackupSettings', err);
    }
  }

  async function saveBackupSettings() {
    const payload = {
      intervalHours: Number(elsBackup.intervalHours?.value) || 24,
      keepCount: Number(elsBackup.keepCount?.value) || 7,
      s3Endpoint: elsBackup.s3Endpoint?.value || '',
      s3Region: elsBackup.s3Region?.value || 'auto',
      s3Bucket: elsBackup.s3Bucket?.value || '',
      s3AccessKey: elsBackup.s3AccessKey?.value || '',
      s3SecretKey: elsBackup.s3SecretKey?.value || '',
      webhookUrl: elsBackup.webhookUrl?.value || ''
    };
    try {
      const res = await fetch('/api/settings/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || '保存失败');
      // 密钥字段不回传完整值，清空输入框避免混淆
      if (elsBackup.s3SecretKey) elsBackup.s3SecretKey.value = '';
      showNotification(data.message || '备份设置已保存', 'success');
      await loadBackupSettings();
    } catch (err) {
      showNotification(err.message, 'error');
    }
  }

  async function testS3() {
    if (elsBackup.testS3Result) elsBackup.testS3Result.textContent = '测试中...';
    try {
      // 先保存当前 S3 配置
      await fetch('/api/settings/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          s3Endpoint: elsBackup.s3Endpoint?.value || '',
          s3Region: elsBackup.s3Region?.value || 'auto',
          s3Bucket: elsBackup.s3Bucket?.value || '',
          s3AccessKey: elsBackup.s3AccessKey?.value || '',
          s3SecretKey: elsBackup.s3SecretKey?.value || ''
        }),
        credentials: 'include'
      });
      const res = await fetch('/api/settings/backup/test-s3', { method: 'POST', credentials: 'include' });
      const data = await res.json();
      if (res.ok) {
        if (elsBackup.testS3Result) { elsBackup.testS3Result.textContent = '✅ ' + data.message; elsBackup.testS3Result.style.color = 'green'; }
      } else {
        if (elsBackup.testS3Result) { elsBackup.testS3Result.textContent = '❌ ' + data.message; elsBackup.testS3Result.style.color = 'red'; }
      }
    } catch (err) {
      if (elsBackup.testS3Result) { elsBackup.testS3Result.textContent = '❌ 请求失败'; elsBackup.testS3Result.style.color = 'red'; }
    }
  }

  async function testWebhook() {
    if (elsBackup.testWebhookResult) elsBackup.testWebhookResult.textContent = '测试中...';
    try {
      await fetch('/api/settings/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookUrl: elsBackup.webhookUrl?.value || '' }),
        credentials: 'include'
      });
      const res = await fetch('/api/settings/backup/test-webhook', { method: 'POST', credentials: 'include' });
      const data = await res.json();
      if (res.ok) {
        if (elsBackup.testWebhookResult) { elsBackup.testWebhookResult.textContent = '✅ ' + data.message; elsBackup.testWebhookResult.style.color = 'green'; }
      } else {
        if (elsBackup.testWebhookResult) { elsBackup.testWebhookResult.textContent = '❌ ' + data.message; elsBackup.testWebhookResult.style.color = 'red'; }
      }
    } catch (err) {
      if (elsBackup.testWebhookResult) { elsBackup.testWebhookResult.textContent = '❌ 请求失败'; elsBackup.testWebhookResult.style.color = 'red'; }
    }
  }

  async function triggerBackup() {
    if (elsBackup.backupStatus) elsBackup.backupStatus.textContent = '备份中...';
    try {
      const res = await fetch('/api/backup/auto', { method: 'POST', credentials: 'include' });
      const data = await res.json();
      if (res.ok) {
        if (elsBackup.backupStatus) { elsBackup.backupStatus.textContent = '✅ ' + data.message; elsBackup.backupStatus.style.color = 'green'; }
      } else {
        if (elsBackup.backupStatus) { elsBackup.backupStatus.textContent = '❌ ' + (data.message || '失败'); elsBackup.backupStatus.style.color = 'red'; }
      }
    } catch (err) {
      if (elsBackup.backupStatus) { elsBackup.backupStatus.textContent = '❌ 请求失败'; elsBackup.backupStatus.style.color = 'red'; }
    }
  }

  if (elsBackup.saveBtn) elsBackup.saveBtn.addEventListener('click', saveBackupSettings);
  if (elsBackup.testS3Btn) elsBackup.testS3Btn.addEventListener('click', testS3);
  if (elsBackup.testWebhookBtn) elsBackup.testWebhookBtn.addEventListener('click', testWebhook);
  if (elsBackup.triggerBtn) elsBackup.triggerBtn.addEventListener('click', triggerBackup);

  // 打开管理面板时加载备份设置
  const origAdminPanelBtn = document.getElementById('adminPanelBtn');
  if (origAdminPanelBtn) {
    origAdminPanelBtn.addEventListener('click', () => {
      setTimeout(loadBackupSettings, 300);
    });
  }

  bindModalInteractions();
}

async function init() {
  applyTheme(state.theme, { persist: Boolean(savedTheme) });
  // 跟随系统：仅当用户未手动选择主题时，监听系统主题变化
  if (!savedTheme && typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e) => applyTheme(e.matches ? 'dark' : 'light', { persist: false });
    if (mq.addEventListener) {
      mq.addEventListener('change', handler);
    } else if (mq.addListener) {
      mq.addListener(handler);
    }
  }
  syncSettingsUi();
  await loadBrandingFromServer();
  applyBranding();
  setupEventListeners();
  maybeShowSettingsTip();
  updateCurlExamples();
  toggleAuthModal(false);
  await refreshUserStatus();
  await updateStats();
  setSettingsEnabled(Boolean(state.user));
}

applyCopyAllIcons();
init();

function maybeShowSettingsTip() {
  if (!els.settingsTooltip) return;
  const shown = localStorage.getItem('ni_settings_tip_shown') === 'true';
  if (shown) return;
  setTimeout(() => {
    els.settingsTooltip.classList.add('show');
    setTimeout(() => els.settingsTooltip.classList.remove('show'), 4000);
  }, 800);
  localStorage.setItem('ni_settings_tip_shown', 'true');
}

function updateCurlExamples() {
  const origin = window.location.origin;
  const ex1 = document.getElementById('curlExample1');
  const ex2 = document.getElementById('curlExample2');
  const ex3 = document.getElementById('curlExample3');
  if (ex1) ex1.textContent = `curl -X POST \"${origin}/api/upload\" \\\n  -H \"X-API-Key: 您的API密钥\" \\\n  -F \"image=@/path/to/your/image.jpg\"`;
  if (ex2) ex2.textContent = `curl -X DELETE \"${origin}/api/v1/delete/{image_id}\" \\\n  -H \"X-API-Key: 您的API密钥\"`;
  if (ex3) ex3.textContent = `curl -X GET \"${origin}/api/v1/list\" \\\n  -H \"X-API-Key: 您的API密钥\"`;
}

function handleBrandingInput() {
  state.branding.name = els.brandNameInput ? els.brandNameInput.value : state.branding.name;
  state.branding.subtitle = els.brandSubtitleInput ? els.brandSubtitleInput.value : state.branding.subtitle;
  state.branding.icon = els.brandIconInput ? els.brandIconInput.value : state.branding.icon;
  state.branding.registrationEnabled = els.allowRegisterInput ? els.allowRegisterInput.checked : state.branding.registrationEnabled;
}

function applyBranding() {
  const displayName = state.branding.name || 'Nodeimage';
  const displaySubtitle = state.branding.subtitle || 'NodeSeek专用图床·克隆版';
  const displayFooter = state.branding.footer || 'Modified from <a href="https://www.nodeimage.com/" target="_blank" rel="noopener noreferrer">NodeImage</a>';
  const defaultLogo = els.brandLogo?.dataset?.default || els.brandLogo?.src || '';
  const displayIcon = state.branding.icon || defaultLogo;

  if (els.brandName) els.brandName.textContent = displayName;
  if (els.brandSubtitle) els.brandSubtitle.textContent = displaySubtitle;
  if (els.brandLogo) {
    if (state.branding.icon) els.brandLogo.src = state.branding.icon;
    else els.brandLogo.src = defaultLogo;
  }
  if (els.brandNameInput) els.brandNameInput.value = state.branding.name;
  if (els.brandSubtitleInput) els.brandSubtitleInput.value = state.branding.subtitle;
  if (els.brandIconInput) els.brandIconInput.value = state.branding.icon || '';
  if (els.allowRegisterInput) els.allowRegisterInput.checked = !!state.branding.registrationEnabled;

  // 动态渲染页脚
  const footer = document.querySelector('.global-footer');
  if (footer) footer.innerHTML = displayFooter;

  // 同步浏览器标题和 Favicon
  document.title = displayName || document.title;
  const link = document.querySelector("link[rel*='icon']") || document.createElement('link');
  link.rel = 'icon';
  if (!link.parentNode) document.head.appendChild(link);
  if (displayIcon) link.href = displayIcon;

  if (els.registerBtn) {
    els.registerBtn.style.display = state.branding.registrationEnabled ? 'inline-flex' : 'none';
  }
}

function applyBrandingFromInputs() {
  handleBrandingInput();
  persistSettings();
  (async () => {
    try {
      await saveBrandingToServer();
      await loadAdminUsers();
      await loadBrandingFromServer();
      applyBranding();
      showNotification('已应用图床个性化设置', 'success');
    } catch (err) {
      console.error(err);
      showNotification(err.message || '应用失败', 'error');
    }
  })();
}

function setSettingsEnabled(isAuth) {
  const inputs = [
    els.compressToWebp,
    els.webpQuality,
    els.autoWatermark,
    els.autoCopyLink,
    els.autoDelete,
    els.deleteDays,
    els.brandNameInput,
    els.brandSubtitleInput,
    els.brandIconInput,
    els.allowRegisterInput,
    els.applyBrandingBtn
  ].filter(Boolean);
  const isAdmin = isAdminUser();
  inputs.forEach((el) => {
    el.disabled = !(isAuth && isAdmin);
  });
}

async function loadBrandingFromServer() {
  try {
    const res = await fetch('/api/settings/branding', { credentials: 'include' });
    if (!res.ok) throw new Error('branding fetch failed');
    const data = await res.json();
  state.branding = {
    name: data.name || 'Nodeimage',
    subtitle: data.subtitle || 'NodeSeek专用图床·克隆版',
    icon: data.icon || '',
    footer: data.footer || 'Modified from <a href="https://www.nodeimage.com/" target="_blank" rel="noopener noreferrer">NodeImage</a>',
    registrationEnabled: !!data.registrationEnabled
  };
  } catch (err) {
    console.error(err);
  }
}

async function saveBrandingToServer() {
  const payload = {
    name: state.branding.name || 'Nodeimage',
    subtitle: state.branding.subtitle || 'NodeSeek专用图床·克隆版',
    icon: state.branding.icon || '',
    footer: state.branding.footer || 'Modified from <a href="https://www.nodeimage.com/" target="_blank" rel="noopener noreferrer">NodeImage</a>',
    registrationEnabled: !!state.branding.registrationEnabled
  };
  const res = await fetch('/api/settings/branding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    credentials: 'include'
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.message || '保存失败');
  }
  return res.json();
}

async function loadAdminUsers() {
  if (!isAdminUser() || !els.usersList) return;
  try {
    const res = await fetch('/api/admin/users', { credentials: 'include' });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || '加载用户失败');
    renderUsersList(data.users || []);
  } catch (err) {
    console.error(err);
    if (els.usersList) els.usersList.innerHTML = `<div class="text-muted">${err.message}</div>`;
  }
}

function renderUsersList(users) {
  if (!els.usersList) return;
  if (!users.length) {
    els.usersList.innerHTML = '<div class="text-muted">暂无用户</div>';
    return;
  }
  els.usersList.innerHTML = '';
  users.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'user-row';
    const nameInput = document.createElement('input');
    nameInput.className = 'text-input';
    nameInput.value = u.username;
    nameInput.placeholder = '用户名';
    const passInput = document.createElement('input');
    passInput.className = 'text-input';
    passInput.type = 'password';
    passInput.placeholder = '新密码（留空则不改）';

    const btnSave = document.createElement('button');
    btnSave.className = 'tailwind-btn';
    btnSave.textContent = '保存';
    btnSave.addEventListener('click', async () => {
      const payload = { username: nameInput.value.trim() };
      if (passInput.value) payload.password = passInput.value;
      try {
        const res = await fetch(`/api/admin/users/${u.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'include'
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message || '保存失败');
        showNotification('已更新用户', 'success');
        loadAdminUsers();
      } catch (err) {
        showNotification(err.message || '保存失败', 'error');
      }
    });

    const btnDel = document.createElement('button');
    btnDel.className = 'tailwind-btn danger-btn';
    btnDel.textContent = '删除';
    btnDel.disabled = u.id === 'admin';
    btnDel.addEventListener('click', async () => {
      if (u.id === 'admin') return;
      try {
        const res = await fetch(`/api/admin/users/${u.id}`, {
          method: 'DELETE',
          credentials: 'include'
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message || '删除失败');
        showNotification('已删除用户', 'success');
        loadAdminUsers();
      } catch (err) {
        showNotification(err.message || '删除失败', 'error');
      }
    });

    row.appendChild(nameInput);
    row.appendChild(passInput);
    row.appendChild(btnSave);
    row.appendChild(btnDel);
    els.usersList.appendChild(row);
  });
}
