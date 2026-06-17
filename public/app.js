(function () {
  const ACCENT_PRESETS = [
    [59, 130, 246],
    [34, 197, 94],
    [245, 158, 11],
    [239, 68, 68],
    [168, 85, 247],
    [236, 72, 153],
    [20, 184, 166],
    [244, 244, 245],
  ];

  const GENERATING_STATUSES = new Set(['collecting', 'writing', 'rendering', 'verifying']);
  const POST_STATUS_OPTIONS = [
    { value: 'draft', label: '초안' },
    { value: 'done', label: '완성' },
    { value: 'published', label: '발행됨' },
  ];
  const STAGE_LABELS = {
    collecting: '수집',
    writing: '집필',
    rendering: '렌더',
    verifying: '검수',
  };

  const root = document.getElementById('app');
  const toastRoot = document.getElementById('toast-root');

  const state = {
    loading: true,
    route: parseRoute(location.pathname),
    settings: null,
    posts: [],
    sources: [],
    currentPost: null,
    dashboard: {
      input: '',
      direction: '',
      creating: false,
      filter: 'all',
      selectedToneId: '',
      tonePopoverOpen: false,
      highlightPostId: '',
    },
    editor: {
      mode: 'slide',
      selectedSlideId: '',
      captionOpen: false,
      imagePickerOpen: false,
      tonePopoverOpen: false,
      renderBusy: false,
      exportBusy: false,
      rewriteBusy: false,
      toneBusy: false,
      queue: null,
      renderFailures: {},
      imageLoadError: false,
      bodyFallbackText: '',
      dragSlideId: '',
      dragOverSlideId: '',
      dragInsertPosition: '',
      cliUnavailable: false,
      exportError: '',
      drafts: {},
      directionDrafts: {},
      redirectBusy: false,
      appendBusy: false,
      evidenceExpanded: {},
      pendingFocusId: '',
      selectedOverlayId: '',
      undoStack: [],
      redoStack: [],
    },
    sourcesView: {
      addInput: '',
      query: '',
      tag: '',
      registering: false,
      expanded: {},
      tagDrafts: {},
      notesDrafts: {},
      manualTrace: null,
      lastTrace: null,
      cliUnavailable: false,
      anglePanel: createEmptyAnglePanelState(),
    },
    threadsView: {
      input: '',
      count: '',
      intensity: 'standard',
      generating: false,
      result: null,
      meta: null,
      error: '',
      cliUnavailable: false,
    },
    settingsModal: {
      open: false,
      draft: null,
      cliTest: null,
    },
    exportResult: null,
    toasts: [],
    saveTimers: {},
    lastStatuses: {},
  };

  init().catch((error) => {
    console.error(error);
    state.loading = false;
    pushToast({
      kind: 'error',
      message: error.message || '초기 데이터를 불러오지 못했습니다.',
    });
    renderApp();
  });

  async function init() {
    bindEvents();
    await refreshBootstrap();
    startPoller();
    renderApp();
  }

  function bindEvents() {
    document.addEventListener('click', onClick);
    document.addEventListener('pointerdown', onOverlayPointerDown);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('dragstart', onDragstart);
    document.addEventListener('dragover', onDragover);
    document.addEventListener('drop', onDrop);
    document.addEventListener('dragend', onDragend);
    document.addEventListener('error', onImageError, true);
    window.addEventListener('popstate', async () => {
      state.route = parseRoute(location.pathname);
      await syncRouteData();
      renderApp();
    });
  }

  async function refreshBootstrap() {
    state.loading = true;
    renderApp();
    const [settingsData, postsData, sourcesData] = await Promise.all([
      api('GET', '/api/settings'),
      api('GET', '/api/posts'),
      api('GET', '/api/sources'),
    ]);
    state.settings = settingsData.settings;
    state.posts = postsData.posts || [];
    state.sources = sourcesData.sources || [];
    if (!state.dashboard.selectedToneId) {
      state.dashboard.selectedToneId = state.settings.defaultTone || firstToneId();
    }
    if (!state.settingsModal.draft) {
      state.settingsModal.draft = cloneSettingsDraft(state.settings);
    }
    await syncRouteData();
    state.loading = false;
  }

  async function syncRouteData() {
    if (state.route.name === 'editor' && state.route.postId) {
      await loadPost(state.route.postId);
      return;
    }
    state.currentPost = null;
  }

  async function loadPost(postId) {
    const response = await api('GET', `/api/posts/${encodeURIComponent(postId)}`);
    state.currentPost = hydratePost(response.post);
    state.editor.cliUnavailable = false;
    state.editor.exportError = '';
    state.editor.undoStack = [];
    state.editor.redoStack = [];
    state.editor.selectedOverlayId = '';
    ensureEditorDraft(state.currentPost);
    if (!state.editor.selectedSlideId || !findSlide(state.currentPost, state.editor.selectedSlideId)) {
      state.editor.selectedSlideId = state.currentPost.slides[0] ? state.currentPost.slides[0].id : '';
    }
  }

  function startPoller() {
    window.setInterval(async () => {
      if (!needsPolling()) {
        return;
      }
      try {
        const postsData = await api('GET', '/api/posts');
        const previous = indexById(state.posts);
        state.posts = postsData.posts || [];
        notifyStatusTransitions(previous, indexById(state.posts));
        if (state.currentPost && needsPostPolling(state.currentPost)) {
          const postData = await api('GET', `/api/posts/${encodeURIComponent(state.currentPost.id)}`);
          state.currentPost = hydratePost(postData.post);
          ensureEditorDraft(state.currentPost);
        }
        renderApp();
      } catch (error) {
        console.error(error);
      }
    }, 1500);
  }

  function needsPolling() {
    if (state.exportResult) {
      return false;
    }
    if (state.posts.some(needsPostPolling)) {
      return true;
    }
    return Boolean(state.currentPost && needsPostPolling(state.currentPost));
  }

  function needsPostPolling(post) {
    return Boolean(post && GENERATING_STATUSES.has(post.status));
  }

  function notifyStatusTransitions(previous, next) {
    Object.keys(next).forEach((postId) => {
      const prev = previous[postId];
      const curr = next[postId];
      if (!prev || !curr) {
        return;
      }
      if (GENERATING_STATUSES.has(prev.status) && !GENERATING_STATUSES.has(curr.status)) {
        if (curr.status === 'draft' || curr.status === 'done' || curr.status === 'published') {
          sendDesktopNotification(curr.title || '포스트', '생성이 완료되었습니다.');
        } else if (curr.status === 'error') {
          sendDesktopNotification(curr.title || '포스트', curr.error || '생성 중 오류가 발생했습니다.');
        }
      }
    });
  }

  async function onClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target) {
      return;
    }
    const action = target.dataset.action;
    try {
      switch (action) {
        case 'navigate':
          event.preventDefault();
          await navigate(target.dataset.path);
          break;
        case 'open-settings':
          state.settingsModal.open = true;
          state.settingsModal.draft = cloneSettingsDraft(state.settings);
          renderApp();
          break;
        case 'close-settings':
          state.settingsModal.open = false;
          renderApp();
          break;
        case 'toggle-dashboard-tone':
          state.dashboard.tonePopoverOpen = !state.dashboard.tonePopoverOpen;
          renderApp();
          break;
        case 'select-dashboard-tone':
          state.dashboard.selectedToneId = target.dataset.toneId || firstToneId();
          state.dashboard.tonePopoverOpen = false;
          renderApp();
          break;
        case 'create-post':
          await handleCreatePost();
          break;
        case 'set-thread-intensity':
          state.threadsView.intensity = target.dataset.intensity || 'standard';
          renderApp();
          break;
        case 'generate-thread':
          await handleGenerateThread();
          break;
        case 'copy-thread-post':
          await handleCopyThreadPost(target.dataset);
          break;
        case 'copy-thread-all':
          await handleCopyThreadAll();
          break;
        case 'set-dashboard-filter':
          state.dashboard.filter = target.dataset.status || 'all';
          renderApp();
          break;
        case 'open-post':
          await navigate(`/post/${target.dataset.postId}`);
          break;
        case 'retry-generate':
          await retryGenerate(target.dataset.stage || '');
          break;
        case 'editor-back':
          await navigate('/');
          break;
        case 'set-editor-mode':
          state.editor.mode = target.dataset.mode || 'slide';
          renderApp();
          break;
        case 'toggle-caption':
          state.editor.captionOpen = !state.editor.captionOpen;
          renderApp();
          break;
        case 'select-slide':
          state.editor.selectedSlideId = target.dataset.slideId || '';
          state.editor.mode = 'slide';
          renderApp();
          break;
        case 'render-slide':
          await renderCurrentSlide();
          break;
        case 'redirect-regenerate':
          await redirectAndRegenerate();
          break;
        case 'append-slides':
          await appendSlidesFromDirection();
          break;
        case 'font-size-auto': {
          const key = target.dataset.sizeKey === 'subtitleSize' ? 'subtitleSize' : 'bodySize';
          updateSelectedSlideText({ [key]: null });
          await renderCurrentSlide();
          break;
        }
        case 'rewrite-slide':
          await rewriteCurrentSlide();
          break;
        case 'toggle-image-picker':
          state.editor.imagePickerOpen = !state.editor.imagePickerOpen;
          renderApp();
          break;
        case 'select-candidate':
          await selectImageCandidate(target.dataset.localPath || '');
          break;
        case 'delete-slide':
          await deleteSlide(target.dataset.slideId || '');
          break;
        case 'add-slide':
          await addSlide();
          break;
        case 'set-accent':
          await setAccent(target.dataset.rgb || '');
          break;
        case 'add-overlay':
          addOverlay();
          break;
        case 'delete-overlay':
          deleteOverlay(target.dataset.overlayId || state.editor.selectedOverlayId);
          break;
        case 'set-overlay-color':
          if (state.editor.selectedOverlayId) {
            updateOverlay(state.editor.selectedOverlayId, { color: target.dataset.color || '#ffffff' });
            liveRenderSelectedSlide();
          }
          break;
        case 'toggle-tone-popover':
          state.editor.tonePopoverOpen = !state.editor.tonePopoverOpen;
          renderApp();
          break;
        case 'apply-tone-rewrite':
          await rewriteAllSlides(target.dataset.toneId || '');
          break;
        case 'set-post-status':
          await patchCurrentPost({ status: target.dataset.status || 'draft' }, { immediate: true });
          break;
        case 'export-post':
          await exportPost();
          break;
        case 'close-export':
          state.exportResult = null;
          renderApp();
          break;
        case 'copy-caption':
          await copyCaptionToClipboard();
          break;
        case 'delete-post':
          await deleteCurrentPost();
          break;
        case 'undo-toast':
          await undoToast(target.dataset.toastId || '');
          break;
        case 'dismiss-toast':
          dismissToast(target.dataset.toastId || '');
          break;
        case 'manual-draft':
          await createManualDraft();
          break;
        case 'render-failed-slide':
          await renderCurrentSlide();
          break;
        case 'open-image-picker':
          state.editor.imagePickerOpen = true;
          renderApp();
          break;
        case 'register-source':
          await registerSource();
          break;
        case 'dismiss-trace-analysis':
          state.sourcesView.lastTrace = null;
          state.sourcesView.anglePanel = createEmptyAnglePanelState();
          renderApp();
          break;
        case 'open-existing-trace-post':
          await openExistingTracePost();
          break;
        case 'open-trace-angle-panel':
          await handleTracePostCta();
          break;
        case 'retry-angles':
          await requestTraceAngles();
          break;
        case 'toggle-angle-reroll':
          state.sourcesView.anglePanel.rerollOpen = !state.sourcesView.anglePanel.rerollOpen;
          if (!state.sourcesView.anglePanel.rerollOpen) {
            state.sourcesView.anglePanel.selectedHints = [];
          }
          renderApp();
          break;
        case 'toggle-angle-hint':
          toggleAngleHint(target.dataset.hint || '');
          renderApp();
          break;
        case 'submit-angle-reroll':
          await requestTraceAngles({
            hints: state.sourcesView.anglePanel.selectedHints,
            negativeTitles: state.sourcesView.anglePanel.previousTitles,
          });
          break;
        case 'toggle-manual-angle':
          state.sourcesView.anglePanel.manualOpen = !state.sourcesView.anglePanel.manualOpen;
          renderApp();
          break;
        case 'create-angle-post':
          await createPostFromAngleIndex(target.dataset.angleIndex || '');
          break;
        case 'create-manual-angle-post':
          await createManualAnglePost();
          break;
        case 'toggle-source-expand':
          toggleSourceExpand(target.dataset.sourceId || '');
          break;
        case 'remove-source-tag':
          await removeSourceTag(target.dataset.sourceId || '', target.dataset.tag || '');
          break;
        case 'add-source-tag':
          await addSourceTag(target.dataset.sourceId || '');
          break;
        case 'save-source-notes':
          await saveSourceNotes(target.dataset.sourceId || '');
          break;
        case 'delete-source':
          await deleteSource(target.dataset.sourceId || '');
          break;
        case 'set-source-tag-filter':
          state.sourcesView.tag = target.dataset.tag || '';
          renderApp();
          break;
        case 'clear-source-tag-filter':
          state.sourcesView.tag = '';
          renderApp();
          break;
        case 'save-manual-source':
          await saveManualSource();
          break;
        case 'toggle-evidence':
          toggleEvidence(target.dataset.slideId || '');
          renderApp();
          break;
        case 'focus-slide-edit':
          focusSlideEdit(target.dataset.slideId || '');
          renderApp();
          break;
        case 'exclude-slide':
          await excludeSlide(target.dataset.slideId || '');
          break;
        case 'save-settings':
          await saveSettings();
          break;
        case 'test-cli':
          await testClaudeConnection();
          break;
        case 'set-default-accent':
          ensureSettingsDraft();
          state.settingsModal.draft.defaultAccent = parseRgbText(target.dataset.rgb || '');
          renderApp();
          break;
        case 'toggle-tone-preset-edit':
          toggleTonePresetEdit(target.dataset.toneId || '');
          renderApp();
          break;
        case 'add-tone-preset':
          addTonePresetDraft();
          renderApp();
          break;
        case 'delete-tone-preset':
          deleteTonePresetDraft(target.dataset.toneId || '');
          renderApp();
          break;
        case 'set-default-tone':
          setDefaultToneDraft(target.dataset.toneId || '');
          renderApp();
          break;
        default:
          break;
      }
    } catch (error) {
      console.error(error);
      pushToast({
        kind: 'error',
        message: error.message || '요청 처리 중 오류가 발생했습니다.',
      });
      renderApp();
    }
  }

  function onInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.matches('[data-bind="dashboard-input"]')) {
      state.dashboard.input = target.value;
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="dashboard-direction"]')) {
      state.dashboard.direction = target.value;
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="thread-input"]')) {
      state.threadsView.input = target.value;
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="thread-count"]')) {
      const raw = target.value.trim();
      const parsed = Number.parseInt(raw, 10);
      state.threadsView.count = raw && Number.isFinite(parsed) ? Math.max(4, Math.min(20, parsed)) : '';
      return;
    }

    if (target.matches('[data-bind="editor-title"]')) {
      if (!state.currentPost) {
        return;
      }
      state.currentPost.title = target.value;
      queuePostSave();
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="cover-headline"]')) {
      updateSelectedSlideText({ headline: target.value }, resolveBoundSlideId(target));
      return;
    }

    if (target.matches('[data-bind="cover-kicker"]')) {
      updateSelectedSlideText({ kicker: target.value }, resolveBoundSlideId(target));
      return;
    }

    if (target.matches('[data-bind="cover-kickerbg"]')) {
      const parsed = Number.parseInt(target.value, 10);
      const value = Number.isFinite(parsed) ? parsed : null;
      updateSelectedSlideText({ kickerBg: value }, resolveBoundSlideId(target), { silent: true });
      const field = target.closest('.field');
      const label = field ? field.querySelector('.help-inline') : null;
      if (label) {
        label.textContent = `${value === null ? 88 : value}%`;
      }
      liveRenderSelectedSlide();
      return;
    }

    if (target.matches('[data-bind="body-subtitle"]')) {
      updateSelectedSlideText({ subtitle: target.value }, resolveBoundSlideId(target));
      return;
    }

    if (target.matches('[data-bind="body-paragraphs"]')) {
      updateSelectedSlideText({ paragraphs: splitParagraphBlocks(target.value) }, resolveBoundSlideId(target));
      return;
    }

    if (target.matches('[data-bind="body-linespacing"]')) {
      const parsed = Number.parseFloat(target.value);
      const value = Number.isFinite(parsed) ? parsed : null;
      // 드래그 중 전체 리렌더는 슬라이더 DOM을 교체해 드래그를 끊는다 — 상태/라벨만 갱신
      updateSelectedSlideText({ lineSpacing: value }, resolveBoundSlideId(target), { silent: true });
      const field = target.closest('.field');
      const label = field ? field.querySelector('.help-inline') : null;
      if (label) {
        label.textContent = `${(value === null ? 1.4 : value).toFixed(2)}배`;
      }
      liveRenderSelectedSlide();
      return;
    }

    if (target.matches('[data-bind="body-fontsize"]')) {
      const key = target.dataset.sizeKey === 'subtitleSize' ? 'subtitleSize' : 'bodySize';
      const parsed = Number.parseInt(target.value, 10);
      const value = Number.isFinite(parsed) ? parsed : null;
      updateSelectedSlideText({ [key]: value }, resolveBoundSlideId(target), { silent: true });
      const field = target.closest('.field');
      const label = field ? field.querySelector('.help-inline') : null;
      if (label && value !== null) {
        label.textContent = `${value}px`;
      }
      liveRenderSelectedSlide();
      return;
    }

    if (target.matches('[data-bind="body-source"]')) {
      updateSelectedSlideText({ source: target.value }, resolveBoundSlideId(target));
      return;
    }

    if (target.matches('[data-bind="overlay-text"]')) {
      if (state.editor.selectedOverlayId) {
        updateOverlay(state.editor.selectedOverlayId, { text: target.value });
      }
      return;
    }
    if (target.matches('[data-bind="overlay-size"]')) {
      const size = Number(target.value);
      if (state.editor.selectedOverlayId && Number.isFinite(size)) {
        updateOverlay(state.editor.selectedOverlayId, { size }, { silent: true });
        const el = document.querySelector(`.overlay-text[data-overlay-id="${state.editor.selectedOverlayId}"]`);
        if (el) {
          el.style.fontSize = `${(size / 10.8).toFixed(3)}cqw`;
        }
        const label = target.closest('.field').querySelector('.help-inline');
        if (label) {
          label.textContent = size;
        }
      }
      return;
    }
    if (target.matches('[data-bind="ending-headline"]')) {
      updateSelectedSlideText({ headline: target.value, closing: target.value }, resolveBoundSlideId(target));
      return;
    }

    if (target.matches('[data-bind="editor-direction"]')) {
      if (state.currentPost) {
        const wasEmpty = !resolveDirectionDraft(state.currentPost).trim();
        state.editor.directionDrafts[state.currentPost.id] = target.value;
        // 버튼 disabled 토글이 필요한 경계(빈↔비빈)에서만 리렌더 — 타이핑 중 포커스 유지
        if (wasEmpty !== !target.value.trim()) {
          renderApp({ preserveFocus: true });
        }
      }
      return;
    }

    if (target.matches('[data-bind="caption-body"]')) {
      ensureEditorDraft(state.currentPost);
      state.editor.drafts[state.currentPost.id].caption = target.value;
      queuePostSave();
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="caption-tags"]')) {
      ensureEditorDraft(state.currentPost);
      state.editor.drafts[state.currentPost.id].hashtags = target.value;
      queuePostSave();
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="body-fallback"]')) {
      state.editor.bodyFallbackText = target.value;
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="source-add-input"]')) {
      state.sourcesView.addInput = target.value;
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="source-search"]')) {
      state.sourcesView.query = target.value;
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="source-tag-draft"]')) {
      state.sourcesView.tagDrafts[target.dataset.sourceId || ''] = target.value;
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="source-notes"]')) {
      state.sourcesView.notesDrafts[target.dataset.sourceId || ''] = target.value;
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="manual-source-name"]')) {
      state.sourcesView.manualTrace.name = target.value;
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="manual-source-url"]')) {
      state.sourcesView.manualTrace.url = target.value;
      if (!state.sourcesView.manualTrace.domain) {
        state.sourcesView.manualTrace.domain = safeDomain(target.value);
      }
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="manual-source-domain"]')) {
      state.sourcesView.manualTrace.domain = target.value;
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="manual-source-tags"]')) {
      state.sourcesView.manualTrace.tags = target.value;
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="angle-direction"]')) {
      state.sourcesView.anglePanel.direction = target.value;
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="angle-manual-title"]')) {
      state.sourcesView.anglePanel.manualTitle = target.value;
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="angle-manual-hook"]')) {
      state.sourcesView.anglePanel.manualHook = target.value;
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="settings-api-key"]')) {
      // 키는 즉시 localStorage에만 저장(서버 저장 버튼과 무관). 재렌더는 포커스 유지.
      setStoredApiKey(target.value);
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="settings-brand"]')) {
      ensureSettingsDraft();
      state.settingsModal.draft.brand = target.value;
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="settings-tone-id"]')) {
      updateTonePresetDraft(target.dataset.toneId || '', { id: target.value });
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="settings-tone-name"]')) {
      updateTonePresetDraft(target.dataset.toneId || '', { name: target.value });
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="settings-tone-description"]')) {
      updateTonePresetDraft(target.dataset.toneId || '', { description: target.value });
      renderApp({ preserveFocus: true });
      return;
    }

    if (target.matches('[data-bind="settings-tone-prompt-suffix"]')) {
      updateTonePresetDraft(target.dataset.toneId || '', { promptSuffix: target.value });
      renderApp({ preserveFocus: true });
      return;
    }
  }

  async function onChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.matches('[data-bind="post-status-select"]')) {
      await patchCurrentPost({ status: target.value }, { immediate: true });
      return;
    }

    if (target.matches('[data-bind="image-upload"]')) {
      const input = target;
      const file = input.files && input.files[0];
      if (!file) {
        return;
      }
      await uploadImage(file);
      input.value = '';
      return;
    }

    if (target.matches('[data-bind="overlay-size"]')) {
      await autoRenderAfterRangeChange();
      return;
    }
    if (target.matches('[data-bind="overlay-text"]')) {
      liveRenderSelectedSlide();
      return;
    }
    if (target.matches('[data-bind="body-linespacing"]')
      || target.matches('[data-bind="body-fontsize"]')
      || target.matches('[data-bind="cover-kickerbg"]')) {
      await autoRenderAfterRangeChange();
      return;
    }
  }

  let rangeRenderBusy = false;
  let rangeRenderAgain = false;
  let liveRenderBusy = false;
  let liveRenderAgain = false;

  // 드래그 중 실시간 미리보기 — 풀 renderApp 없이 이미지 src만 교체 (DOM 교체 = 드래그 끊김)
  async function liveRenderSelectedSlide() {
    if (liveRenderBusy) {
      liveRenderAgain = true;
      return;
    }
    if (!state.currentPost) {
      return;
    }
    liveRenderBusy = true;
    try {
      do {
        liveRenderAgain = false;
        const slide = getSelectedSlide();
        if (!slide) {
          break;
        }
        await flushPostSave();
        const result = await api('POST', `/api/posts/${encodeURIComponent(state.currentPost.id)}/render`, {
          slideId: slide.id,
        });
        state.currentPost = hydratePost(result.post);
        ensureEditorDraft(state.currentPost);
        const updated = state.currentPost.slides.find((item) => item.id === slide.id);
        if (updated && updated.imagePath) {
          const src = withCacheBust(updated.imagePath, state.currentPost.updatedAt);
          const img = document.querySelector('.js-preview-image');
          if (img) {
            img.src = src;
          }
          const thumbImg = document.querySelector(`.thumb[data-slide-id="${slide.id}"] .thumb__image, [data-slide-id="${slide.id}"] .thumb__image`);
          if (thumbImg) {
            thumbImg.src = src;
          }
        }
      } while (liveRenderAgain);
    } catch (error) {
      // 라이브 미리보기 실패는 조용히 — release 시 정식 렌더가 다시 시도한다
    } finally {
      liveRenderBusy = false;
    }
  }

  async function autoRenderAfterRangeChange() {
    if (rangeRenderBusy) {
      rangeRenderAgain = true;
      return;
    }
    rangeRenderBusy = true;
    try {
      do {
        rangeRenderAgain = false;
        try {
          await renderCurrentSlide();
        } catch (error) {
          // 실패는 renderCurrentSlide가 renderFailures에 기록 — 루프만 끊는다
        }
      } while (rangeRenderAgain);
    } finally {
      rangeRenderBusy = false;
    }
  }

  async function onKeydown(event) {
    if (event.key === 'Escape') {
      if (state.exportResult) {
        state.exportResult = null;
        renderApp();
        return;
      }
      if (state.settingsModal.open) {
        state.settingsModal.open = false;
        renderApp();
        return;
      }
      if (state.editor.imagePickerOpen) {
        state.editor.imagePickerOpen = false;
        renderApp();
        return;
      }
    }

    if (event.key === 'Enter' && event.metaKey && state.route.name === 'dashboard') {
      await handleCreatePost();
      return;
    }

    if (state.route.name !== 'editor' || !state.currentPost) {
      return;
    }

    // 되돌리기/다시실행 (event.code로 IME·레이아웃 독립). 맥: Cmd+Z / Cmd+Shift+Z, 윈도: Ctrl+Z / Ctrl+Y
    if ((event.metaKey || event.ctrlKey) && (event.code === 'KeyZ' || event.key === 'z' || event.key === 'Z' || event.key === 'ㅋ')) {
      event.preventDefault();
      if (event.shiftKey) {
        await performRedo();
      } else {
        await performUndo();
      }
      return;
    }
    if (event.ctrlKey && !event.metaKey && (event.code === 'KeyY' || event.key === 'y' || event.key === 'Y')) {
      event.preventDefault();
      await performRedo();
      return;
    }

    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      moveSlideSelection(-1);
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      moveSlideSelection(1);
    }
  }

  function onImageError(event) {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) {
      return;
    }
    if (target.matches('.js-preview-image')) {
      state.editor.imageLoadError = true;
      renderApp();
    }
  }

  function onDragstart(event) {
    const thumb = event.target instanceof Element
      ? event.target.closest('.thumb[data-drag-slide-id]')
      : null;
    if (!(thumb instanceof HTMLElement)) {
      return;
    }
    const slideId = thumb.dataset.dragSlideId || '';
    if (!slideId) {
      return;
    }
    state.editor.dragSlideId = slideId;
    state.editor.dragOverSlideId = '';
    state.editor.dragInsertPosition = '';
    thumb.classList.add('is-dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', slideId);
    }
    clearThumbDropIndicator();
  }

  function onDragover(event) {
    if (!state.currentPost || !state.editor.dragSlideId) {
      return;
    }
    const thumb = event.target instanceof Element
      ? event.target.closest('.thumb[data-drag-slide-id]')
      : null;
    if (!(thumb instanceof HTMLElement)) {
      return;
    }
    const slideId = thumb.dataset.dragSlideId || '';
    if (!slideId) {
      return;
    }
    event.preventDefault();
    const position = dragInsertPositionForEvent(event, thumb);
    state.editor.dragOverSlideId = slideId;
    state.editor.dragInsertPosition = position;
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    applyThumbDropIndicator(thumb, position, slideId === state.editor.dragSlideId);
  }

  async function onDrop(event) {
    if (!state.currentPost || !state.editor.dragSlideId) {
      return;
    }
    const thumb = event.target instanceof Element
      ? event.target.closest('.thumb[data-drag-slide-id]')
      : null;
    if (!(thumb instanceof HTMLElement)) {
      clearDragState();
      return;
    }
    event.preventDefault();
    const targetSlideId = thumb.dataset.dragSlideId || '';
    const position = state.editor.dragOverSlideId === targetSlideId && state.editor.dragInsertPosition
      ? state.editor.dragInsertPosition
      : dragInsertPositionForEvent(event, thumb);
    try {
      await reorderSlides(state.editor.dragSlideId, targetSlideId, position);
    } finally {
      clearDragState();
    }
  }

  function onDragend() {
    clearDragState();
  }

  async function navigate(path) {
    if (path === location.pathname) {
      return;
    }
    history.pushState({}, '', path);
    state.route = parseRoute(path);
    await syncRouteData();
    renderApp();
  }

  async function handleGenerateThread() {
    const view = state.threadsView;
    const input = view.input.trim();
    if (!input || view.generating) {
      return;
    }

    view.generating = true;
    view.error = '';
    view.cliUnavailable = false;
    renderApp();

    try {
      const payload = { input, intensity: view.intensity };
      if (Number.isFinite(Number(view.count)) && Number(view.count) > 0) {
        payload.count = Number(view.count);
      }
      const response = await api('POST', '/api/threads/generate', payload);
      view.result = response.thread;
      view.meta = response.meta || null;
      if (!view.result || !Array.isArray(view.result.posts) || view.result.posts.length === 0) {
        view.error = '생성 결과가 비어 있습니다. 다시 시도해주세요.';
      } else {
        pushToast({ kind: 'success', message: `스레드 ${view.result.posts.length}개 본문 생성 완료` });
      }
    } catch (error) {
      view.cliUnavailable = error && error.code === 'cli_unavailable';
      view.error = error.message || '스레드 생성에 실패했습니다.';
      pushToast({ kind: 'error', message: view.error });
    } finally {
      view.generating = false;
      renderApp();
    }
  }

  async function handleCopyThreadPost(dataset) {
    const result = state.threadsView.result;
    if (!result) {
      return;
    }
    let text = '';
    if (dataset.threadPart === 'lead') {
      text = result.lead || '';
    } else if (dataset.threadPart === 'closing') {
      text = result.closing || '';
    } else {
      const index = Number.parseInt(dataset.threadIndex, 10);
      const post = Array.isArray(result.posts) ? result.posts[index] : null;
      text = post ? post.text : '';
    }
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      pushToast({ kind: 'success', message: '복사했습니다' });
    } catch (error) {
      pushToast({ kind: 'error', message: '복사에 실패했습니다' });
    }
  }

  async function handleCopyThreadAll() {
    const result = state.threadsView.result;
    if (!result) {
      return;
    }
    try {
      await navigator.clipboard.writeText(threadPlainText(result));
      pushToast({ kind: 'success', message: '전체 스레드를 복사했습니다' });
    } catch (error) {
      pushToast({ kind: 'error', message: '복사에 실패했습니다' });
    }
  }

  async function handleCreatePost() {
    const input = state.dashboard.input.trim();
    if (!input) {
      return;
    }

    const detection = detectInput(input);
    if (detection.apiInputType === 'threads' || detection.apiInputType === 'url') {
      await createMagazineFromUrlDirect(input, state.dashboard.direction);
      return;
    }
    const payload = {
      inputType: detection.apiInputType,
      input,
      title: detection.apiInputType === 'topic' ? input.slice(0, 80) : '',
      status: 'draft',
      tone: state.dashboard.selectedToneId || state.settings.defaultTone || firstToneId(),
      accent: normalizeAccentArray(state.settings.defaultAccent),
      caption: '',
    };

    if (Notification && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    const created = await api('POST', '/api/posts', payload);
    const post = created.post;
    await api('POST', `/api/posts/${encodeURIComponent(post.id)}/generate`, {});
    state.dashboard.input = '';
    await refreshPostsOnly();
    await navigate(`/post/${post.id}`);
  }

  async function refreshPostsOnly() {
    const postsData = await api('GET', '/api/posts');
    state.posts = postsData.posts || [];
  }

  async function sendInputToSourceAnalysis(input) {
    state.sourcesView.addInput = input;
    state.dashboard.input = '';
    await navigate('/sources');
    pushToast({
      kind: 'warning',
      message: 'URL은 분석을 거쳐 만듭니다.',
    });
    await registerSource();
  }

  // URL + 방향을 받아 분석→앵글 자동선택→집필→렌더까지 한 번에 태운다(앵글 수동선택 생략).
  async function createMagazineFromUrlDirect(url, direction) {
    const trimmedUrl = String(url || '').trim();
    if (!trimmedUrl) {
      return;
    }
    const existing = findExistingUrlPost(trimmedUrl);
    if (existing) {
      state.dashboard.input = '';
      state.dashboard.direction = '';
      await navigate(`/post/${existing.id}`);
      return;
    }

    state.dashboard.creating = true;
    renderApp();
    const dir = String(direction || '').trim();
    try {
      const trace = await api('POST', '/api/sources/trace', { url: trimmedUrl, save: true });
      if (!trace.items || !trace.items.length) {
        // 콘텐츠를 분해하지 못하면 수동 소스 분석 흐름으로 폴백.
        pushToast({ kind: 'warning', message: '콘텐츠를 분해하지 못해 소스 분석 화면으로 보냅니다.' });
        state.dashboard.creating = false;
        await sendInputToSourceAnalysis(trimmedUrl);
        return;
      }

      const anglesResp = await api('POST', '/api/angles', {
        url: trimmedUrl,
        title: trace.extractedTitle || '',
        summary: trace.summary || '',
        body: trace.extractedBody || '',
        items: trace.items,
        hints: dir ? [dir] : undefined,
      });
      const angle = (anglesResp.angles || [])[0];
      if (!angle) {
        pushToast({ kind: 'warning', message: '앵글을 만들지 못해 소스 분석 화면으로 보냅니다.' });
        state.dashboard.creating = false;
        await sendInputToSourceAnalysis(trimmedUrl);
        return;
      }

      const created = await api('POST', '/api/posts', {
        inputType: 'url',
        input: trimmedUrl,
        title: trace.extractedTitle || '',
        body: trace.extractedBody || '',
        angle: { title: angle.title, hook: angle.hook, tone: angle.tone },
        traceItems: anglesResp.items || trace.items,
        direction: dir || null,
      });
      const post = created.post;
      await api('POST', `/api/posts/${encodeURIComponent(post.id)}/generate`, {});
      state.dashboard.input = '';
      state.dashboard.direction = '';
      await refreshPostsOnly();
      pushToast({ kind: 'success', message: '잡지 생성 시작' });
      await navigate(`/post/${post.id}`);
    } catch (error) {
      pushToast({ kind: 'error', message: (error && error.message) || '생성에 실패했습니다.' });
    } finally {
      state.dashboard.creating = false;
      renderApp();
    }
  }

  async function handleTracePostCta() {
    const existingPost = findExistingUrlPost(state.sourcesView.lastTrace && state.sourcesView.lastTrace.url);
    if (existingPost) {
      await navigate(`/post/${existingPost.id}`);
      return;
    }
    state.sourcesView.anglePanel.open = true;
    if (!state.sourcesView.anglePanel.angles.length && !state.sourcesView.anglePanel.loading) {
      await requestTraceAngles();
      return;
    }
    renderApp();
  }

  async function openExistingTracePost() {
    const existingPost = findExistingUrlPost(state.sourcesView.lastTrace && state.sourcesView.lastTrace.url);
    if (!existingPost) {
      return;
    }
    await navigate(`/post/${existingPost.id}`);
  }

  async function requestTraceAngles(options) {
    const trace = state.sourcesView.lastTrace;
    if (!trace) {
      return;
    }
    state.sourcesView.anglePanel.open = true;
    state.sourcesView.anglePanel.loading = true;
    state.sourcesView.anglePanel.error = '';
    renderApp();
    try {
      const response = await api('POST', '/api/angles', {
        url: trace.url,
        title: trace.extractedTitle || '',
        summary: trace.summary || '',
        body: trace.extractedBody || '',
        items: trace.items || [],
        hints: options && Array.isArray(options.hints) && options.hints.length ? options.hints : undefined,
        negativeTitles: options && Array.isArray(options.negativeTitles) && options.negativeTitles.length
          ? options.negativeTitles
          : undefined,
      });
      state.sourcesView.lastTrace = {
        ...state.sourcesView.lastTrace,
        items: response.items || trace.items || [],
      };
      state.sourcesView.anglePanel.angles = response.angles || [];
      state.sourcesView.anglePanel.loading = false;
      state.sourcesView.anglePanel.error = '';
      state.sourcesView.anglePanel.requestCount += 1;
      state.sourcesView.anglePanel.previousTitles = (response.angles || []).map((angle) => angle.title).filter(Boolean);
      state.sourcesView.anglePanel.rerollOpen = false;
      state.sourcesView.anglePanel.selectedHints = [];
    } catch (error) {
      state.sourcesView.anglePanel.loading = false;
      state.sourcesView.anglePanel.error = error.message || '앵글 후보를 불러오지 못했습니다.';
    }
    renderApp();
  }

  function toggleAngleHint(hint) {
    if (!hint) {
      return;
    }
    const next = new Set(state.sourcesView.anglePanel.selectedHints);
    if (next.has(hint)) {
      next.delete(hint);
    } else {
      next.add(hint);
    }
    state.sourcesView.anglePanel.selectedHints = Array.from(next);
  }

  async function createPostFromAngleIndex(indexValue) {
    const index = Number(indexValue);
    if (!Number.isInteger(index)) {
      return;
    }
    const angle = state.sourcesView.anglePanel.angles[index];
    if (!angle) {
      return;
    }
    await createTraceBasedPost({
      title: angle.title,
      hook: angle.hook,
      tone: angle.tone,
    });
  }

  async function createManualAnglePost() {
    const title = state.sourcesView.anglePanel.manualTitle.trim();
    const hook = state.sourcesView.anglePanel.manualHook.trim();
    if (!title || !hook) {
      return;
    }
    await createTraceBasedPost({ title, hook });
  }

  async function createTraceBasedPost(angle) {
    const trace = state.sourcesView.lastTrace;
    if (!trace) {
      return;
    }
    const existingPost = findExistingUrlPost(trace.url);
    if (existingPost) {
      await navigate(`/post/${existingPost.id}`);
      return;
    }
    state.sourcesView.anglePanel.creating = true;
    renderApp();
    try {
      const created = await api('POST', '/api/posts', {
        inputType: 'url',
        input: trace.url,
        title: trace.extractedTitle || '',
        body: trace.extractedBody || '',
        angle,
        traceItems: trace.items || [],
        direction: (state.sourcesView.anglePanel.direction || '').trim() || null,
      });
      const post = created.post;
      await api('POST', `/api/posts/${encodeURIComponent(post.id)}/generate`, {});
      await refreshPostsOnly();
      highlightDashboardPost(post.id);
      await navigate('/');
      pushToast({
        kind: 'success',
        message: '포스트 생성 시작',
      });
    } finally {
      state.sourcesView.anglePanel.creating = false;
      renderApp();
    }
  }

  let lastUndoPushAt = 0;

  function pushUndoSnapshot() {
    // 변경 직전 슬라이드 상태를 스냅샷(딥클론). 빠른 연속 편집(타이핑)은 400ms로 합쳐 과적재 방지.
    if (!state.currentPost) {
      return;
    }
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (now - lastUndoPushAt < 400 && state.editor.undoStack.length) {
      return;
    }
    lastUndoPushAt = now;
    state.editor.undoStack.push(clone(state.currentPost.slides));
    if (state.editor.undoStack.length > 80) {
      state.editor.undoStack.shift();
    }
    // 새 편집이 들어오면 redo 분기는 무효 (표준 동작)
    state.editor.redoStack = [];
  }

  async function applyHistorySlides(slides) {
    state.currentPost.slides = slides;
    if (!findSlide(state.currentPost, state.editor.selectedSlideId)) {
      state.editor.selectedSlideId = slides[0] ? slides[0].id : '';
    }
    state.editor.selectedOverlayId = '';
    renderApp({ preserveFocus: true });
    queuePostSave();
    // 되돌린/다시실행한 슬라이드 이미지 재렌더 (텍스트/위치가 바뀌었을 수 있음)
    await liveRenderSelectedSlide();
  }

  async function performUndo() {
    if (!state.currentPost || !state.editor.undoStack.length) {
      pushToast({ kind: 'info', message: '되돌릴 변경이 없습니다' });
      return;
    }
    state.editor.redoStack.push(clone(state.currentPost.slides));
    await applyHistorySlides(state.editor.undoStack.pop());
  }

  async function performRedo() {
    if (!state.currentPost || !state.editor.redoStack.length) {
      pushToast({ kind: 'info', message: '다시 실행할 변경이 없습니다' });
      return;
    }
    state.editor.undoStack.push(clone(state.currentPost.slides));
    await applyHistorySlides(state.editor.redoStack.pop());
  }

  function updateSelectedSlideText(patch, slideId, options = {}) {
    const post = state.currentPost;
    if (!post) {
      return;
    }
    const targetSlideId = typeof slideId === 'string' && slideId
      ? slideId
      : state.editor.selectedSlideId;
    const slideIndex = post.slides.findIndex((item) => item.id === targetSlideId);
    if (slideIndex === -1) {
      return;
    }
    pushUndoSnapshot();
    const slide = post.slides[slideIndex];
    const nextText = {
      ...slide.text,
      ...patch,
    };
    post.slides[slideIndex] = {
      ...slide,
      text: nextText,
      dirty: true,
    };
    queuePostSave();
    if (!options.silent) {
      renderApp({ preserveFocus: true });
    }
  }

  function resolveBoundSlideId(target) {
    const container = target.closest('[data-slide-id]');
    return container && container.dataset.slideId ? container.dataset.slideId : state.editor.selectedSlideId;
  }

  function dragInsertPositionForEvent(event, thumb) {
    const rect = thumb.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
  }

  function clearThumbDropIndicator() {
    document.querySelectorAll('.thumb.is-drop-before, .thumb.is-drop-after').forEach((node) => {
      node.classList.remove('is-drop-before', 'is-drop-after');
    });
  }

  function applyThumbDropIndicator(thumb, position, isDraggedThumb) {
    clearThumbDropIndicator();
    if (isDraggedThumb) {
      return;
    }
    thumb.classList.add(position === 'before' ? 'is-drop-before' : 'is-drop-after');
  }

  function clearDragState() {
    state.editor.dragSlideId = '';
    state.editor.dragOverSlideId = '';
    state.editor.dragInsertPosition = '';
    document.querySelectorAll('.thumb.is-dragging').forEach((node) => {
      node.classList.remove('is-dragging');
    });
    clearThumbDropIndicator();
  }

  async function reorderSlides(dragSlideId, targetSlideId, position) {
    if (!state.currentPost || !dragSlideId || !targetSlideId || !position) {
      return;
    }
    const slides = state.currentPost.slides.slice();
    const fromIndex = slides.findIndex((slide) => slide.id === dragSlideId);
    const targetIndex = slides.findIndex((slide) => slide.id === targetSlideId);
    if (fromIndex === -1 || targetIndex === -1) {
      return;
    }

    const insertIndexRaw = targetIndex + (position === 'after' ? 1 : 0);
    if (fromIndex === targetIndex || (fromIndex + 1 === insertIndexRaw && position === 'after')) {
      return;
    }

    const [moved] = slides.splice(fromIndex, 1);
    let insertIndex = insertIndexRaw;
    if (fromIndex < insertIndex) {
      insertIndex -= 1;
    }
    slides.splice(insertIndex, 0, moved);
    state.currentPost.slides = normalizeClientSlides(slides);
    await patchCurrentPost({}, { immediate: true, silent: true });
    renderApp();
  }

  function queuePostSave() {
    if (!state.currentPost) {
      return;
    }
    const postId = state.currentPost.id;
    window.clearTimeout(state.saveTimers[postId]);
    state.saveTimers[postId] = window.setTimeout(async () => {
      try {
        await patchCurrentPost({}, { immediate: true, silent: true });
      } catch (error) {
        pushToast({
          kind: 'error',
          message: error.message || '자동 저장에 실패했습니다.',
        });
        renderApp();
      }
    }, 1000);
  }

  async function flushPostSave() {
    if (!state.currentPost) {
      return;
    }
    const postId = state.currentPost.id;
    if (state.saveTimers[postId]) {
      window.clearTimeout(state.saveTimers[postId]);
      delete state.saveTimers[postId];
    }
    await patchCurrentPost({}, { immediate: true, silent: true });
  }

  async function patchCurrentPost(extraPatch, options) {
    if (!state.currentPost) {
      return;
    }
    const patch = buildPostPatch(state.currentPost, extraPatch || {});
    const response = await api('PATCH', `/api/posts/${encodeURIComponent(state.currentPost.id)}`, patch);
    state.currentPost = hydratePost(response.post);
    ensureEditorDraft(state.currentPost);
    await refreshPostsOnly();
    if (!options || !options.silent) {
      renderApp();
    }
  }

  function buildPostPatch(post, extraPatch) {
    const draft = ensureEditorDraft(post);
    const base = {
      title: post.title,
      status: post.status,
      accent: normalizeAccentArray(post.accent),
      caption: joinCaptionAndHashtags(draft.caption, draft.hashtags),
      spec: {
        slides: serializeSlides(post.slides),
      },
    };
    return Object.assign(base, extraPatch);
  }

  async function retryGenerate(stage) {
    if (!state.currentPost) {
      return;
    }
    const post = state.currentPost;
    const fromStage = stage || post.resumeStage || post.failedStage || 'collecting';
    await api('POST', `/api/posts/${encodeURIComponent(post.id)}/generate`, { fromStage });
    state.editor.renderFailures = {};
    await loadPost(post.id);
    await refreshPostsOnly();
    renderApp();
  }

  async function renderCurrentSlide() {
    if (!state.currentPost) {
      return;
    }
    const slide = getSelectedSlide();
    if (!slide) {
      return;
    }
    state.editor.renderBusy = true;
    renderApp();
    try {
      await flushPostSave();
      const result = await api('POST', `/api/posts/${encodeURIComponent(state.currentPost.id)}/render`, {
        slideId: slide.id,
      });
      state.currentPost = hydratePost(result.post);
      state.editor.renderFailures = {};
      state.editor.imageLoadError = false;
      ensureEditorDraft(state.currentPost);
      await refreshPostsOnly();
    } catch (error) {
      state.editor.renderFailures[slide.id] = error.message || `슬라이드 렌더 실패`;
      throw error;
    } finally {
      state.editor.renderBusy = false;
      renderApp();
    }
  }

  async function rewriteCurrentSlide() {
    if (!state.currentPost || state.editor.rewriteBusy) {
      return;
    }
    state.editor.cliUnavailable = false;
    const post = state.currentPost;
    const slide = getSelectedSlide();
    const index = slide ? post.slides.findIndex((item) => item.id === slide.id) : -1;
    if (!slide || index === -1) {
      return;
    }

    state.editor.rewriteBusy = true;
    renderApp();
    await flushPostSave();

    const snapshot = {
      slides: clone(post.slides),
      caption: ensureEditorDraft(post).caption,
      hashtags: ensureEditorDraft(post).hashtags,
    };

    try {
      await api('POST', `/api/posts/${encodeURIComponent(post.id)}/generate`, { fromStage: 'writing' });
      const rewritten = await waitForTerminalPost(post.id);
      const nextSlides = clone(snapshot.slides);
      const candidate = rewritten.slides[index];
      if (candidate) {
        nextSlides[index] = {
          ...nextSlides[index],
          type: nextSlides[index].type,
          text: {
            ...nextSlides[index].text,
            ...candidate.text,
          },
          dirty: true,
        };
      }

      state.currentPost.slides = normalizeClientSlides(nextSlides);
      await patchCurrentPost({}, { immediate: true, silent: true });
      pushUndoToast('AI 재작성 전 텍스트로 되돌릴 수 있습니다.', async () => {
        state.currentPost.slides = normalizeClientSlides(clone(snapshot.slides));
        ensureEditorDraft(state.currentPost).caption = snapshot.caption;
        ensureEditorDraft(state.currentPost).hashtags = snapshot.hashtags;
        await patchCurrentPost({}, { immediate: true, silent: true });
        renderApp();
      });
    } catch (error) {
      state.editor.cliUnavailable = error && error.code === 'cli_unavailable';
      throw error;
    } finally {
      state.editor.rewriteBusy = false;
      renderApp();
    }
  }

  function resolveDirectionDraft(post) {
    if (!post) {
      return '';
    }
    const draft = state.editor.directionDrafts[post.id];
    return draft !== undefined ? draft : (post.direction || '');
  }

  async function redirectAndRegenerate() {
    const post = state.currentPost;
    if (!post || state.editor.redirectBusy || state.editor.toneBusy) {
      return;
    }
    const direction = resolveDirectionDraft(post).trim();
    if (!direction) {
      return;
    }
    state.editor.redirectBusy = true;
    renderApp();
    try {
      await patchCurrentPost({ direction }, { immediate: true, silent: true });
      await rewriteAllSlides('', { quiet: true });
      // 새 글을 이미지에 바로 반영 (전체 렌더 ~2초)
      const rendered = await api('POST', `/api/posts/${encodeURIComponent(post.id)}/render`, {});
      state.currentPost = hydratePost(rendered.post);
      ensureEditorDraft(state.currentPost);
      pushToast({ kind: 'success', message: '방향 반영 재생성 완료 — 마음에 안 들면 문장 고쳐서 다시 누르면 됩니다.' });
    } finally {
      state.editor.redirectBusy = false;
      renderApp();
    }
  }

  async function appendSlidesFromDirection() {
    const post = state.currentPost;
    if (!post || state.editor.appendBusy || state.editor.redirectBusy || state.editor.toneBusy) {
      return;
    }
    const instruction = resolveDirectionDraft(post).trim();
    if (!instruction) {
      return;
    }
    state.editor.appendBusy = true;
    renderApp();
    try {
      await patchCurrentPost({}, { immediate: true, silent: true });
      const beforeCount = post.slides.length;
      await api('POST', `/api/posts/${encodeURIComponent(post.id)}/append-slides`, { instruction });
      const updated = await waitForTerminalPost(post.id);
      state.currentPost = updated;
      ensureEditorDraft(state.currentPost);
      const added = state.currentPost.slides.length - beforeCount;
      pushToast({
        kind: added > 0 ? 'success' : 'error',
        message: added > 0
          ? `슬라이드 ${added}장 추가 완료 — 필요 없으면 썸네일 ×로 삭제하면 됩니다.`
          : '추가된 슬라이드가 없습니다. 지시를 바꿔 다시 시도해보세요.',
      });
    } catch (error) {
      pushToast({ kind: 'error', message: error.message || '슬라이드 추가에 실패했습니다.' });
    } finally {
      state.editor.appendBusy = false;
      renderApp();
    }
  }

  async function rewriteAllSlides(toneId, options = {}) {
    if (!state.currentPost || state.editor.toneBusy) {
      return;
    }
    const post = state.currentPost;
    state.editor.cliUnavailable = false;
    state.editor.toneBusy = true;
    state.editor.tonePopoverOpen = false;
    renderApp();

    const snapshot = {
      slides: clone(post.slides),
      caption: ensureEditorDraft(post).caption,
      hashtags: ensureEditorDraft(post).hashtags,
    };

    try {
      await api('POST', `/api/posts/${encodeURIComponent(post.id)}/generate`, { fromStage: 'writing' });
      const rewritten = await waitForTerminalPost(post.id);
      const nextSlides = clone(snapshot.slides).map((slide, index) => {
        const candidate = rewritten.slides[index];
        if (!candidate || candidate.type !== slide.type) {
          return {
            ...slide,
            dirty: true,
          };
        }
        return {
          ...slide,
          text: {
            ...slide.text,
            ...candidate.text,
          },
          dirty: true,
        };
      });
      state.currentPost.slides = normalizeClientSlides(nextSlides);
      ensureEditorDraft(state.currentPost).caption = extractCaptionDraft(rewritten.caption).caption;
      ensureEditorDraft(state.currentPost).hashtags = extractCaptionDraft(rewritten.caption).hashtags;
      state.dashboard.selectedToneId = toneId || state.dashboard.selectedToneId;
      await patchCurrentPost({}, { immediate: true, silent: true });
      pushUndoToast('전체 AI 재작성 전 텍스트로 되돌릴 수 있습니다.', async () => {
        state.currentPost.slides = normalizeClientSlides(clone(snapshot.slides));
        ensureEditorDraft(state.currentPost).caption = snapshot.caption;
        ensureEditorDraft(state.currentPost).hashtags = snapshot.hashtags;
        await patchCurrentPost({}, { immediate: true, silent: true });
        renderApp();
      });
      if (!options.quiet) {
        pushToast({
          kind: 'warning',
          message: '현재 서버 API에는 톤 필드 변경 엔드포인트가 없어 전체 AI 재작성으로 근사했습니다.',
        });
      }
    } catch (error) {
      state.editor.cliUnavailable = error && error.code === 'cli_unavailable';
      throw error;
    } finally {
      state.editor.toneBusy = false;
      renderApp();
    }
  }

  async function waitForTerminalPost(postId) {
    for (;;) {
      const response = await api('GET', `/api/posts/${encodeURIComponent(postId)}`);
      if (!GENERATING_STATUSES.has(response.post.status)) {
        if (response.post.status === 'error') {
          state.currentPost = hydratePost(response.post);
          ensureEditorDraft(state.currentPost);
          const error = new Error(response.post.error || 'AI 재작성에 실패했습니다.');
          if (response.post.error === 'Claude CLI에 연결할 수 없습니다') {
            error.code = 'cli_unavailable';
          }
          throw error;
        }
        return hydratePost(response.post);
      }
      await delay(1500);
    }
  }

  async function setAccent(rgbText) {
    if (!state.currentPost) {
      return;
    }
    const accent = parseRgbText(rgbText);
    state.currentPost.accent = accent;
    state.currentPost.slides = state.currentPost.slides.map((slide) => ({
      ...slide,
      dirty: true,
    }));
    await patchCurrentPost({}, { immediate: true, silent: true });
    await renderCurrentSlide();
    queueBackgroundRender();
  }

  function queueBackgroundRender() {
    if (!state.currentPost) {
      return;
    }
    const currentSlideId = state.editor.selectedSlideId;
    const queue = state.currentPost.slides
      .filter((slide) => slide.id !== currentSlideId)
      .map((slide) => slide.id);
    state.editor.queue = {
      total: queue.length,
      done: 0,
    };
    renderApp();
    (async () => {
      for (const slideId of queue) {
        try {
          const result = await api('POST', `/api/posts/${encodeURIComponent(state.currentPost.id)}/render`, {
            slideId,
          });
          state.currentPost = hydratePost(result.post);
          ensureEditorDraft(state.currentPost);
          state.editor.queue.done += 1;
          renderApp();
        } catch (error) {
          state.editor.renderFailures[slideId] = error.message || '렌더 실패';
        }
      }
      await refreshPostsOnly();
      state.editor.queue = null;
      renderApp();
    })().catch((error) => {
      console.error(error);
      state.editor.queue = null;
      renderApp();
    });
  }

  async function exportPost() {
    if (!state.currentPost || state.editor.exportBusy) {
      return;
    }
    state.editor.exportError = '';
    state.editor.exportBusy = true;
    renderApp();
    try {
      await flushPostSave();
      const response = await api('POST', `/api/posts/${encodeURIComponent(state.currentPost.id)}/export`, {});
      state.exportResult = response;
    } catch (error) {
      state.editor.exportError = error.message || 'Export에 실패했습니다.';
      renderApp();
    } finally {
      state.editor.exportBusy = false;
      renderApp();
    }
  }

  async function copyCaptionToClipboard() {
    if (!state.currentPost) {
      return;
    }
    const draft = ensureEditorDraft(state.currentPost);
    const text = joinCaptionAndHashtags(draft.caption, draft.hashtags);
    await navigator.clipboard.writeText(text);
    pushToast({
      kind: 'success',
      message: '캡션을 클립보드에 복사했습니다.',
    });
    renderApp();
  }

  async function deleteCurrentPost() {
    if (!state.currentPost) {
      return;
    }
    const confirmed = window.confirm('이 포스트를 삭제할까요?');
    if (!confirmed) {
      return;
    }
    await api('DELETE', `/api/posts/${encodeURIComponent(state.currentPost.id)}`);
    await refreshPostsOnly();
    await navigate('/');
  }

  async function deleteSlide(slideId) {
    if (!state.currentPost) {
      return;
    }
    if (state.currentPost.slides.length <= 2) {
      pushToast({
        kind: 'warning',
        message: '슬라이드는 최소 2장 이상 유지해야 합니다.',
      });
      renderApp();
      return;
    }
    const nextSlides = state.currentPost.slides.filter((slide) => slide.id !== slideId);
    state.currentPost.slides = normalizeClientSlides(nextSlides);
    if (!findSlide(state.currentPost, state.editor.selectedSlideId)) {
      state.editor.selectedSlideId = state.currentPost.slides[0] ? state.currentPost.slides[0].id : '';
    }
    await patchCurrentPost({}, { immediate: true, silent: true });
    renderApp();
  }

  function focusSlideEdit(slideId) {
    if (!state.currentPost) {
      return;
    }
    const slide = findSlide(state.currentPost, slideId);
    if (!slide) {
      return;
    }
    state.editor.mode = 'slide';
    state.editor.selectedSlideId = slideId;
    state.editor.pendingFocusId = focusIdForSlide(slide);
  }

  async function excludeSlide(slideId) {
    if (!state.currentPost) {
      return;
    }
    const slide = findSlide(state.currentPost, slideId);
    if (!slide) {
      return;
    }
    if (slide.type === 'cover' || slide.type === 'ending') {
      pushToast({
        kind: 'warning',
        message: '커버와 엔딩 슬라이드는 제외할 수 없습니다.',
      });
      renderApp();
      return;
    }
    await flushPostSave();
    await deleteSlide(slideId);
    const renderResult = await api('POST', `/api/posts/${encodeURIComponent(state.currentPost.id)}/render`, {});
    state.currentPost = hydratePost(renderResult.post);
    ensureEditorDraft(state.currentPost);
    await refreshPostsOnly();
    pushToast({
      kind: 'success',
      message: '슬라이드를 제외하고 다시 렌더링했습니다.',
    });
    renderApp();
  }

  async function addSlide() {
    if (!state.currentPost) {
      return;
    }
    const slides = clone(state.currentPost.slides);
    const selectedIndex = slides.findIndex((slide) => slide.id === state.editor.selectedSlideId);
    const insertAt = (() => {
      const endingIndex = slides.findIndex((slide) => slide.type === 'ending');
      if (endingIndex !== -1 && (selectedIndex === -1 || selectedIndex >= endingIndex)) {
        return endingIndex;
      }
      return selectedIndex === -1 ? slides.length : selectedIndex + 1;
    })();
    const newSlide = makeLocalSlide('body');
    slides.splice(insertAt, 0, newSlide);
    state.currentPost.slides = normalizeClientSlides(slides);
    state.editor.selectedSlideId = newSlide.id;
    await patchCurrentPost({}, { immediate: true, silent: true });
    renderApp();
  }

  async function selectImageCandidate(localPath) {
    if (!state.currentPost) {
      return;
    }
    const slide = getSelectedSlide();
    if (!slide || !localPath) {
      return;
    }
    slide.photo = localPath;
    slide.dirty = true;
    await patchCurrentPost({}, { immediate: true, silent: true });
    state.editor.imagePickerOpen = false;
    await renderCurrentSlide();
  }

  async function uploadImage(file) {
    if (!state.currentPost) {
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      throw new Error('이미지 크기가 10MB를 초과합니다');
    }
    const slide = getSelectedSlide();
    const data = await readFileAsDataUrl(file);
    const response = await api('POST', `/api/posts/${encodeURIComponent(state.currentPost.id)}/assets`, {
      data,
      filename: file.name,
      slideId: slide ? slide.id : null,
    });
    state.currentPost = hydratePost(response.post);
    ensureEditorDraft(state.currentPost);
    state.editor.imagePickerOpen = false;
    await renderCurrentSlide();
  }

  async function createManualDraft() {
    if (!state.currentPost) {
      return;
    }
    const text = state.editor.bodyFallbackText.trim();
    if (!text) {
      throw new Error('본문을 붙여넣어야 합니다.');
    }
    const paragraphs = splitParagraphBlocks(text);
    const headline = linesFromText(text, 2, 12).join('\n') || '직접 입력 초안';
    const subtitle = linesFromText(text, 2, 18).join('\n') || '핵심 요약';
    const bodyText = paragraphs.length ? paragraphs : [text.slice(0, 140)];
    const nextSlides = normalizeClientSlides([
      {
        id: makeId('slide'),
        type: 'cover',
        text: {
          headline,
          kicker: '본문 직접 붙여넣기',
          subtitle: null,
          paragraphs: [],
          closing: null,
        },
        photo: firstAvailablePhoto(state.currentPost),
        imagePath: state.currentPost.slides[0] ? state.currentPost.slides[0].imagePath : null,
        dirty: true,
        overflow: false,
      },
      {
        id: makeId('slide'),
        type: 'body',
        text: {
          headline: null,
          kicker: null,
          subtitle,
          paragraphs: bodyText.slice(0, 3),
          closing: null,
        },
        photo: firstAvailablePhoto(state.currentPost),
        imagePath: null,
        dirty: true,
        overflow: false,
      },
      {
        id: makeId('slide'),
        type: 'ending',
        text: {
          headline: '핵심만\n빠르게 정리',
          kicker: null,
          subtitle: null,
          paragraphs: [],
          closing: '핵심만\n빠르게 정리',
        },
        photo: null,
        imagePath: null,
        dirty: true,
        overflow: false,
      },
    ]);
    state.currentPost.title = state.currentPost.title || headline.replace(/\n/g, ' ');
    state.currentPost.status = 'draft';
    state.currentPost.error = '';
    state.currentPost.slides = nextSlides;
    ensureEditorDraft(state.currentPost).caption = text.slice(0, 400);
    ensureEditorDraft(state.currentPost).hashtags = '';
    state.editor.bodyFallbackText = '';
    state.editor.selectedSlideId = nextSlides[0].id;
    await patchCurrentPost({}, { immediate: true, silent: true });
    renderApp();
  }

  async function registerSource() {
    const url = state.sourcesView.addInput.trim();
    if (!url) {
      return;
    }
    state.sourcesView.registering = true;
    state.sourcesView.manualTrace = null;
    state.sourcesView.cliUnavailable = false;
    state.sourcesView.anglePanel = createEmptyAnglePanelState();
    renderApp();
    try {
      const result = await api('POST', '/api/sources/trace', { url, save: true });
      state.sourcesView.lastTrace = {
        url,
        extractedTitle: result.extractedTitle || '',
        extractedBody: result.extractedBody || '',
        summary: result.summary || '',
        items: result.items || [],
        outboundLinks: result.outboundLinks || [],
        savedCount: (result.saved || []).length,
      };
      if (!result.saved || !result.saved.length) {
        state.sourcesView.manualTrace = {
          name: result.extractedTitle || '',
          url,
          domain: safeDomain(url),
          tags: '',
          type: 'media',
        };
        pushToast({
          kind: 'warning',
          message: '원본 소스를 찾지 못해 직접 입력 폼으로 전환했습니다.',
        });
      } else {
        state.sourcesView.addInput = '';
        const sourcesData = await api('GET', '/api/sources');
        state.sources = sourcesData.sources || [];
      }
    } catch (error) {
      state.sourcesView.cliUnavailable = error && error.code === 'cli_unavailable';
      state.sourcesView.manualTrace = {
        name: '',
        url,
        domain: safeDomain(url),
        tags: '',
        type: 'media',
      };
      state.sourcesView.lastTrace = null;
      pushToast({
        kind: 'error',
        message: error.message || '원본 소스를 찾을 수 없습니다.',
      });
    } finally {
      state.sourcesView.registering = false;
      renderApp();
    }
  }

  function toggleSourceExpand(sourceId) {
    state.sourcesView.expanded[sourceId] = !state.sourcesView.expanded[sourceId];
    renderApp();
  }

  async function addSourceTag(sourceId) {
    const source = state.sources.find((item) => item.id === sourceId);
    const value = (state.sourcesView.tagDrafts[sourceId] || '').trim();
    if (!source || !value) {
      return;
    }
    const nextTags = uniq([].concat(source.topics || [], value));
    const result = await api('PATCH', `/api/sources/${encodeURIComponent(sourceId)}`, {
      topics: nextTags,
    });
    replaceSource(result.source);
    state.sourcesView.tagDrafts[sourceId] = '';
    renderApp();
  }

  async function removeSourceTag(sourceId, tag) {
    const source = state.sources.find((item) => item.id === sourceId);
    if (!source) {
      return;
    }
    const nextTags = (source.topics || []).filter((item) => item !== tag);
    const result = await api('PATCH', `/api/sources/${encodeURIComponent(sourceId)}`, {
      topics: nextTags,
    });
    replaceSource(result.source);
    renderApp();
  }

  async function saveSourceNotes(sourceId) {
    const source = state.sources.find((item) => item.id === sourceId);
    if (!source) {
      return;
    }
    const notes = state.sourcesView.notesDrafts[sourceId] !== undefined
      ? state.sourcesView.notesDrafts[sourceId]
      : source.notes;
    const result = await api('PATCH', `/api/sources/${encodeURIComponent(sourceId)}`, {
      notes,
    });
    replaceSource(result.source);
    renderApp();
  }

  async function deleteSource(sourceId) {
    const confirmed = window.confirm('이 소스를 삭제할까요?');
    if (!confirmed) {
      return;
    }
    await api('DELETE', `/api/sources/${encodeURIComponent(sourceId)}`);
    state.sources = state.sources.filter((item) => item.id !== sourceId);
    renderApp();
  }

  async function saveManualSource() {
    const draft = state.sourcesView.manualTrace;
    if (!draft) {
      return;
    }
    const payload = {
      name: draft.name.trim(),
      domain: (draft.domain || safeDomain(draft.url)).trim(),
      url: draft.url.trim(),
      type: draft.type || 'media',
      topics: splitTags(draft.tags),
      addedFrom: draft.url.trim(),
      notes: '',
    };
    const result = await api('POST', '/api/sources', payload);
    state.sources.unshift(result.source);
    state.sourcesView.manualTrace = null;
    state.sourcesView.addInput = '';
    renderApp();
  }

  async function saveSettings() {
    ensureSettingsDraft();
    const draft = state.settingsModal.draft;
    const result = await api('PUT', '/api/settings', {
      brand: draft.brand.trim(),
      defaultAccent: normalizeAccentArray(draft.defaultAccent),
      defaultTone: draft.defaultTone,
      tonePresets: draft.tonePresets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        description: preset.description,
        promptSuffix: preset.promptSuffix,
      })),
      theme: state.settings.theme || 'editorial-dark',
    });
    state.settings = result.settings;
    state.settingsModal.draft = cloneSettingsDraft(state.settings);
    state.dashboard.selectedToneId = state.settings.defaultTone || firstToneId();
    pushToast({
      kind: 'success',
      message: '설정을 저장했습니다.',
    });
    renderApp();
  }

  async function testClaudeConnection() {
    state.settingsModal.cliTest = {
      status: 'pending',
      message: 'Claude 연결 확인 중...',
    };
    renderApp();
    try {
      await api('POST', '/api/sources/trace', {
        url: 'https://example.com',
        save: false,
      });
      state.settingsModal.cliTest = {
        status: 'success',
        message: 'Claude 경로와 호출 파이프라인이 응답했습니다.',
      };
    } catch (error) {
      state.settingsModal.cliTest = {
        status: 'error',
        message: error.message || 'Claude CLI에 연결할 수 없습니다.',
      };
    }
    renderApp();
  }

  async function undoToast(toastId) {
    const toast = state.toasts.find((item) => item.id === toastId);
    if (!toast || typeof toast.onUndo !== 'function') {
      return;
    }
    await toast.onUndo();
    dismissToast(toastId);
  }

  function dismissToast(toastId) {
    state.toasts = state.toasts.filter((item) => item.id !== toastId);
    renderToasts();
  }

  function pushUndoToast(message, onUndo) {
    pushToast({
      kind: 'warning',
      message,
      undoLabel: '되돌리기',
      onUndo,
      timeout: 12000,
    });
  }

  function pushToast(toast) {
    const next = {
      id: makeId('toast'),
      kind: toast.kind || 'neutral',
      message: toast.message || '',
      undoLabel: toast.undoLabel || '',
      onUndo: toast.onUndo || null,
    };
    state.toasts = [next].concat(state.toasts).slice(0, 4);
    renderToasts();
    if (toast.timeout !== 0) {
      window.setTimeout(() => dismissToast(next.id), toast.timeout || 5000);
    }
  }

  function moveSlideSelection(delta) {
    if (!state.currentPost || !state.currentPost.slides.length) {
      return;
    }
    const currentIndex = state.currentPost.slides.findIndex((slide) => slide.id === state.editor.selectedSlideId);
    const nextIndex = Math.max(0, Math.min(state.currentPost.slides.length - 1, currentIndex + delta));
    state.editor.selectedSlideId = state.currentPost.slides[nextIndex].id;
    renderApp();
  }

  function renderApp(options) {
    const preserve = options && options.preserveFocus;
    const focus = preserve ? captureFocus() : null;
    root.innerHTML = [
      renderMobileLock(),
      renderShell(),
      state.settingsModal.open ? renderSettingsModal() : '',
      state.exportResult ? renderExportOverlay() : '',
    ].join('');
    renderToasts();
    if (focus) {
      restoreFocus(focus);
      return;
    }
    if (state.editor.pendingFocusId) {
      const next = document.querySelector(`[data-focus-id="${CSS.escape(state.editor.pendingFocusId)}"]`);
      state.editor.pendingFocusId = '';
      if (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) {
        next.focus();
        if (next instanceof HTMLTextAreaElement || next instanceof HTMLInputElement) {
          next.setSelectionRange(next.value.length, next.value.length);
        }
      }
    }
  }

  function renderShell() {
    if (state.loading) {
      return `<div class="app-shell">${renderLoadingScreen()}</div>`;
    }
    if (state.route.name === 'editor') {
      return renderEditorScreen();
    }
    const content =
      state.route.name === 'sources'
        ? renderSourcesScreen()
        : state.route.name === 'threads'
          ? renderThreadsScreen()
          : renderDashboardScreen();
    return `<div class="app-shell app-shell--framed">${renderSidebar()}${content}</div>`;
  }

  function renderLoadingScreen() {
    return `
      <div class="screen dashboard dashboard--empty">
        <div class="empty-state">
          <div class="spinner"></div>
          <div>데이터를 불러오는 중...</div>
        </div>
      </div>
    `;
  }

  function renderMobileLock() {
    return `
      <div class="mobile-lock">
        <div class="mobile-lock__card">
          <h2>Desktop 1280px+</h2>
          <p>이 앱은 데스크톱 전용 SPA로 설계되었습니다.</p>
        </div>
      </div>
    `;
  }

  function renderSidebar() {
    const current = state.route.name;
    return `
      <aside class="sidebar">
        <div class="sidebar__logo" aria-hidden="true"></div>
        <nav class="sidebar__nav">
          <button class="sidebar__button ${current === 'dashboard' ? 'is-active' : ''}" data-action="navigate" data-path="/" aria-label="대시보드">
            <span class="sidebar__icon">▦</span>
          </button>
          <button class="sidebar__button ${current === 'sources' ? 'is-active' : ''}" data-action="navigate" data-path="/sources" aria-label="소스">
            <span class="sidebar__icon">⌘</span>
          </button>
          <button class="sidebar__button ${current === 'threads' ? 'is-active' : ''}" data-action="navigate" data-path="/threads" aria-label="스레드 텍스트">
            <span class="sidebar__icon">🧵</span>
          </button>
          <button class="sidebar__button" data-action="open-settings" aria-label="설정">
            <span class="sidebar__icon">⚙</span>
          </button>
        </nav>
      </aside>
    `;
  }

  function renderDashboardScreen() {
    const posts = sortedPosts(state.posts);
    const filteredPosts = posts.filter((post) => state.dashboard.filter === 'all' || post.status === state.dashboard.filter);
    const runningPosts = posts.filter((post) => GENERATING_STATUSES.has(post.status));
    const empty = posts.length === 0;
    const detection = detectInput(state.dashboard.input.trim());
    return `
      <main class="screen dashboard ${empty ? 'dashboard--empty' : ''}">
        <div class="dashboard__stack ${empty ? 'dashboard__stack--empty' : ''}">
          ${renderQuickLauncher(detection)}
          ${runningPosts.length ? `<section class="jobs">${runningPosts.map(renderJobCard).join('')}</section>` : ''}
          ${empty ? `
            <div class="empty-state">
              <div>첫 번째 포스트를 만들어보세요</div>
              <div>URL은 소스 분석을 거쳐 만들고, 주제 입력은 바로 생성합니다.</div>
            </div>
          ` : renderArchive(filteredPosts, posts)}
        </div>
      </main>
    `;
  }

  function renderQuickLauncher(detection) {
    const tones = state.settings.tonePresets || [];
    const selected = tones.find((item) => item.id === state.dashboard.selectedToneId) || tones[0];
    const urlMode = detection.apiInputType === 'url' || detection.apiInputType === 'threads';
    return `
      <section class="quick-launcher">
        <div class="quick-launcher__title">Quick Launcher</div>
        <div class="quick-launcher__row">
          <input
            class="quick-launcher__field"
            type="text"
            placeholder="뉴스 URL, 인스타 URL, 또는 주제를 입력"
            value="${attr(state.dashboard.input)}"
            data-bind="dashboard-input"
            data-focus-id="dashboard-input"
          />
          <button class="quick-launcher__button" data-action="create-post" ${state.dashboard.input.trim() && !state.dashboard.creating ? '' : 'disabled'}>${state.dashboard.creating ? '생성 중…' : '생성'}</button>
        </div>
        ${urlMode ? `
          <div class="quick-launcher__row">
            <textarea
              class="quick-launcher__field quick-launcher__field--direction"
              rows="2"
              placeholder="편집 방향·각도 (선택) — 예: 해외 진출 스토리로 / 더 쉽게 풀어서 / 협업 사례 강조"
              data-bind="dashboard-direction"
              data-focus-id="dashboard-direction"
            >${h(state.dashboard.direction)}</textarea>
          </div>
        ` : ''}
        ${getStoredApiKey() ? '' : `
          <div class="warning-inline">⚠️ Anthropic API 키가 없습니다 — <button class="link-button" data-action="open-settings">설정에서 키 입력</button> 후 생성하세요. (생성은 본인 키=본인 토큰으로 청구)</div>
        `}
        <div class="quick-launcher__meta">
          ${detection.badge ? detection.badge : ''}
          ${detection.warning ? `<div class="warning-inline">${h(detection.warning)}</div>` : ''}
        </div>
        <div class="quick-launcher__meta">
          <div class="tone-chip">
            <button class="chip-button" data-action="toggle-dashboard-tone">
              <span>톤</span>
              <strong>${h(selected ? selected.name : '감성 매거진')}</strong>
            </button>
          ${state.dashboard.tonePopoverOpen ? `
              <div class="popover">
                <div class="popover__list">
                  ${tones.map((tone) => `
                    <button class="popover__item" data-action="select-dashboard-tone" data-tone-id="${attr(tone.id)}">
                      <p class="popover__title">${h(tone.name)}</p>
                      <p class="popover__desc">${h(tone.description || '')}</p>
                    </button>
                  `).join('')}
                </div>
              </div>
            ` : ''}
          </div>
          <div class="help-inline">${h(urlMode ? 'URL + 방향을 넣고 생성하면 분석·앵글·집필·렌더까지 바로 진행합니다.' : '주제 입력은 생성 즉시 에디터로 이동합니다.')}</div>
        </div>
      </section>
    `;
  }

  function renderJobCard(post) {
    const job = post.job || {};
    const activeStage = post.status;
    const started = job.startedAt ? formatElapsed(job.startedAt) : '';
    const stages = post.angle ? ['collecting', 'writing', 'rendering', 'verifying'] : ['collecting', 'writing', 'rendering'];
    const activeIndex = stages.indexOf(activeStage);
    return `
      <article class="card job-card ${state.dashboard.highlightPostId === post.id ? 'is-highlighted' : ''}" data-action="open-post" data-post-id="${attr(post.id)}">
        <div class="job-card__top">
          <h3 class="job-card__title">${h(post.title || fallbackTitle(post))}</h3>
          <div class="job-card__elapsed">${h(started)}</div>
        </div>
        <div class="stepper">
          ${stages.map((stage) => {
            const stageIndex = stages.indexOf(stage);
            const className = activeIndex > stageIndex ? 'is-done' : activeStage === stage ? 'is-active' : '';
            return `
              <div class="stepper__item ${className}">
                <div class="stepper__dot"></div>
                <span>${h(STAGE_LABELS[stage])}</span>
              </div>
            `;
          }).join('')}
        </div>
        <div class="help-inline">${h(job.progress || '생성 중...')}</div>
      </article>
    `;
  }

  function renderArchive(filteredPosts, allPosts) {
    const counts = {
      all: allPosts.length,
      draft: allPosts.filter((post) => post.status === 'draft').length,
      done: allPosts.filter((post) => post.status === 'done').length,
      published: allPosts.filter((post) => post.status === 'published').length,
    };
    return `
      <section class="archive">
        <div class="archive__header">
          <div class="archive__title">
            <h2>포스트</h2>
            <span class="badge badge--neutral">${counts.all}</span>
          </div>
          <div class="tabs">
            ${renderArchiveTab('all', '전체', counts.all)}
            ${renderArchiveTab('draft', '초안', counts.draft)}
            ${renderArchiveTab('done', '완성', counts.done)}
            ${renderArchiveTab('published', '발행됨', counts.published)}
          </div>
        </div>
        ${filteredPosts.length ? `
          <div class="posts-grid">
            ${filteredPosts.map(renderPostCard).join('')}
          </div>
        ` : `
          <div class="empty-state">
            <div>선택한 상태의 포스트가 없습니다.</div>
          </div>
        `}
      </section>
    `;
  }

  function renderArchiveTab(value, label, count) {
    return `
      <button class="tab ${state.dashboard.filter === value ? 'is-active' : ''}" data-action="set-dashboard-filter" data-status="${value}">
        ${h(label)} ${count}
      </button>
    `;
  }

  function renderPostCard(post) {
    const statusMeta = statusBadge(post.status);
    const verifyWarnings = verifyWarningCount(post);
    return `
      <article class="card post-card ${state.dashboard.highlightPostId === post.id ? 'is-highlighted' : ''}" data-action="open-post" data-post-id="${attr(post.id)}">
        <div class="post-card__thumb">
          ${post.coverImage ? `<img src="${attr(withCacheBust(post.coverImage, post.updatedAt))}" alt="" />` : ''}
        </div>
        <div class="post-card__body">
          <h3 class="post-card__title">${h(post.title || fallbackTitle(post))}</h3>
          <div class="post-card__meta">
            <span>${h(formatDate(post.updatedAt))}</span>
            <span class="post-card__status">
              <span class="badge ${statusMeta.className}">${h(statusMeta.label)}</span>
              ${(post.status === 'draft' || post.status === 'done') && verifyWarnings ? `<span class="badge badge--warning">⚠️ 검수 경고 ${verifyWarnings}</span>` : ''}
            </span>
          </div>
        </div>
      </article>
    `;
  }

  function renderEditorScreen() {
    const post = state.currentPost;
    if (!post) {
      return `
        <div class="editor">
          <div class="toolbar"></div>
          <div class="empty-state">포스트를 찾을 수 없습니다.</div>
        </div>
      `;
    }
    const selected = getSelectedSlide();
    const draft = ensureEditorDraft(post);
    const banners = renderEditorInlineBanners(post);
    return `
      <div class="editor">
        ${renderToolbar(post)}
        <div class="editor__main">
          <section class="preview-panel">
            <div class="preview-stage">
              ${renderPreviewStage(post, selected)}
              ${banners ? `<div class="preview-stage__banner-wrap">${banners}</div>` : ''}
            </div>
            ${renderFilmstrip(post, selected)}
          </section>
          <section class="editor-panel">
            <div class="editor-panel__top">
            <div class="mode-switch">
                <button class="mode-switch__button ${state.editor.mode === 'slide' ? 'is-active' : ''}" data-action="set-editor-mode" data-mode="slide">슬라이드 편집</button>
                <button class="mode-switch__button ${state.editor.mode === 'all' ? 'is-active' : ''}" data-action="set-editor-mode" data-mode="all">전체 보기</button>
              </div>
              ${state.editor.mode === 'slide' ? renderSlideFields(post, selected) : renderAllSlidesEditor(post)}
            </div>
            <div class="editor-panel__body">
              ${state.editor.mode === 'slide' ? renderSlideEditorBody(post, selected) : renderAllSlidesBody(post)}
            </div>
            <div class="editor-direction">
              <label class="field__label">
                <span>🧭 방향 재설정 · 슬라이드 추가</span>
                <span class="help-inline">한두 문장 → 전체 재생성 또는 새 슬라이드 추가 (이미지 유지)</span>
              </label>
              <textarea class="field__textarea field__textarea--small" data-bind="editor-direction" data-focus-id="editor-direction" placeholder="예: 더 쉽게 풀어 다시 써줘 / IPO 연설 실제 발언 슬라이드 추가해줘">${h(resolveDirectionDraft(post))}</textarea>
              <div class="editor-actions">
                <button class="button button--small" data-action="redirect-regenerate" ${state.editor.redirectBusy || state.editor.appendBusy || !resolveDirectionDraft(post).trim() ? 'disabled' : ''}>${state.editor.redirectBusy ? '재생성 중...' : '방향 반영해서 재생성'}</button>
                <button class="button button--small" data-action="append-slides" ${state.editor.redirectBusy || state.editor.appendBusy || !resolveDirectionDraft(post).trim() ? 'disabled' : ''}>${state.editor.appendBusy ? '추가 집필 중...' : '이 지시로 슬라이드 추가'}</button>
              </div>
            </div>
            <div class="accordion">
              <button class="accordion__toggle" data-action="toggle-caption">캡션 & 해시태그 ${state.editor.captionOpen ? '▲' : '▼'}</button>
              ${state.editor.captionOpen ? `
                <div class="field">
                  <label class="field__label"><span>캡션</span></label>
                  <textarea class="field__textarea field__textarea--small" data-bind="caption-body" data-focus-id="caption-body">${h(draft.caption)}</textarea>
                </div>
                <div class="field">
                  <label class="field__label"><span>해시태그</span></label>
                  <input class="field__input" type="text" data-bind="caption-tags" data-focus-id="caption-tags" value="${attr(draft.hashtags)}" />
                </div>
              ` : ''}
            </div>
          </section>
        </div>
      </div>
    `;
  }

  function renderToolbar(post) {
    return `
      <header class="toolbar">
        <div class="toolbar__left">
          <button class="icon-button" data-action="editor-back" aria-label="뒤로">←</button>
          <input class="toolbar__title-input" data-bind="editor-title" data-focus-id="editor-title" value="${attr(post.title || '')}" />
        </div>
        <div class="toolbar__center">
          <select class="toolbar__status" data-bind="post-status-select">
            ${POST_STATUS_OPTIONS.map((item) => `
              <option value="${item.value}" ${post.status === item.value ? 'selected' : ''}>${h(item.label)}</option>
            `).join('')}
          </select>
          ${statusPill(post)}
        </div>
        <div class="toolbar__right">
          <div class="tone-chip">
            <button class="button button--ghost button--small" data-action="toggle-tone-popover">${state.editor.toneBusy ? '톤 변경 중...' : '톤 변경'}</button>
            ${state.editor.tonePopoverOpen ? `
              <div class="popover popover--right">
                <div class="popover__list">
                  ${(state.settings.tonePresets || []).map((tone) => `
                    <button class="popover__item" data-action="apply-tone-rewrite" data-tone-id="${attr(tone.id)}">
                      <p class="popover__title">${h(tone.name)}</p>
                      <p class="popover__desc">${h(tone.description || '')}</p>
                    </button>
                  `).join('')}
                </div>
                <p class="popover__desc">서버에 톤 전용 변경 엔드포인트가 없어 전체 AI 재작성으로 근사합니다.</p>
              </div>
            ` : ''}
          </div>
          <button class="button button--small" data-action="export-post">${state.editor.exportBusy ? 'Export 중...' : 'Export'}</button>
          <button class="button button--danger button--small" data-action="delete-post">삭제</button>
        </div>
      </header>
    `;
  }

  function renderPreviewStage(post, slide) {
    if (!slide && GENERATING_STATUSES.has(post.status)) {
      return `
        <div class="skeleton"></div>
      `;
    }
    if (!slide) {
      return `<div class="empty-state">슬라이드가 없습니다.</div>`;
    }
    const imagePath = slide.imagePath ? withCacheBust(slide.imagePath, post.updatedAt) : '';
    const renderError = state.editor.renderFailures[slide.id] || '';
    const stageBusy = GENERATING_STATUSES.has(post.status);
    return `
      <div class="preview-shell">
        <div class="preview-card ${renderError || state.editor.imageLoadError ? 'has-error' : ''}">
          ${imagePath ? `<img class="preview-card__image js-preview-image" src="${attr(imagePath)}" alt="" />` : `<div class="preview-card__empty">${h(stageBusy ? '생성 중...' : '렌더된 이미지 없음')}</div>`}
          ${slide.dirty ? `
          <div class="preview-card__overlay is-dirty">
            <span class="badge badge--accent preview-chip">변경사항 있음 — 렌더 필요</span>
          </div>` : ''}
          ${renderOverlayLayer(slide)}
          <div class="preview-card__hover">
            <button class="button button--small" data-action="toggle-image-picker">이미지 교체</button>
          </div>
          ${(state.editor.renderBusy || (stageBusy && post.status === 'rendering')) ? `
            <div class="preview-card__hover" style="opacity:1;background:rgba(0,0,0,0.38);">
              <div class="spinner"></div>
            </div>
          ` : ''}
        </div>
        ${state.editor.imagePickerOpen ? renderImagePicker(post, slide) : ''}
        ${renderError ? renderBanner(renderError, [
          { label: '재시도', action: 'render-failed-slide' },
        ]) : ''}
        ${state.editor.imageLoadError ? renderBanner('이미지를 불러올 수 없습니다', [
          { label: '다른 이미지 선택', action: 'open-image-picker' },
        ]) : ''}
      </div>
    `;
  }

  function renderNativeTextProxy(slide) {
    // 슬라이드 본래 텍스트(엔딩 헤드라인 / 본문 소제목+문단 블록)를 드래그로 옮기는 투명 핸들.
    // 평소 투명(베이크 텍스트가 보임=고스트 방지), hover 시 점선, 드래그 시 보임.
    const t = slide.text || {};
    if (slide.type === 'ending') {
      const headline = (t.headline || '').trim();
      if (!headline) return '';
      const p = t.headlinePos;
      const x = p && Number.isFinite(p.xPct) ? p.xPct : 0.5;
      const y = p && Number.isFinite(p.yPct) ? p.yPct : 0.5;
      return `<div class="overlay-text overlay-text--native" data-native-field="headlinePos"
        style="left:${(x * 100).toFixed(3)}%; top:${(y * 100).toFixed(3)}%; font-size:${(72 / 10.8).toFixed(3)}cqw; font-weight:800;" title="드래그해서 위치 이동">${h(t.headline)}</div>`;
    }
    if (slide.type === 'body') {
      const subtitle = (t.subtitle || '').trim();
      if (!subtitle) return '';
      const p = t.bodyPos;
      // 본문 텍스트 블록 기본 좌상단(다크 뉴스형): x=70/1080, y=(0.56H+56)/H
      const x = p && Number.isFinite(p.xPct) ? p.xPct : (70 / 1080);
      const y = p && Number.isFinite(p.yPct) ? p.yPct : ((1350 * 0.56 + 56) / 1350);
      return `<div class="overlay-text overlay-text--native overlay-text--block" data-native-field="bodyPos"
        style="left:${(x * 100).toFixed(3)}%; top:${(y * 100).toFixed(3)}%; font-size:${(54 / 10.8).toFixed(3)}cqw; font-weight:800;" title="드래그해서 텍스트 블록 이동">${h(t.subtitle)}</div>`;
    }
    return '';
  }

  function renderOverlayLayer(slide) {
    const overlays = (slide.text && Array.isArray(slide.text.overlays)) ? slide.text.overlays : [];
    const nativeProxy = renderNativeTextProxy(slide);
    if (!overlays.length && !nativeProxy) {
      return '<div class="overlay-layer"></div>';
    }
    const selectedId = state.editor.selectedOverlayId;
    return `<div class="overlay-layer">
      ${nativeProxy}
      ${overlays.map((o) => {
        const selected = o.id === selectedId;
        const weight = o.weight === 'regular' ? 500 : 800;
        // font-size: o.size 는 1080폭 캔버스 기준 px → 컨테이너 폭 비례(cqw)로 변환해 프리뷰 크기에 자동 정합.
        // 폰트는 PIL(Apple SD Gothic Neo)과 동일 패밀리라 베이크된 텍스트와 거의 정확히 겹친다(이중표시 최소화).
        return `<div class="overlay-text ${selected ? 'is-selected' : ''}" data-overlay-id="${attr(o.id)}"
          style="left:${(o.xPct * 100).toFixed(3)}%; top:${(o.yPct * 100).toFixed(3)}%; font-size:${(o.size / 10.8).toFixed(3)}cqw; color:${attr(o.color)}; font-weight:${weight};">
          ${selected ? `<button class="overlay-text__del" data-action="delete-overlay" data-overlay-id="${attr(o.id)}" title="삭제">×</button>` : ''}${h(o.text)}</div>`;
      }).join('')}
    </div>`;
  }


  function renderFilmstrip(post, selected) {
    const queue = state.editor.queue;
    const progress = queue && queue.total ? Math.min(100, Math.round((queue.done / queue.total) * 100)) : 0;
    return `
      <div class="strip">
        ${queue ? `<div class="strip__progress" style="width:${progress}%"></div>` : ''}
        ${post.slides.map((slide) => `
          <div
            class="thumb ${selected && selected.id === slide.id ? 'is-active' : ''} ${slide.verifyFailed ? 'has-verify-failure' : ''}"
            draggable="true"
            data-drag-slide-id="${attr(slide.id)}"
          >
            <button class="thumb__button" data-action="select-slide" data-slide-id="${attr(slide.id)}">
              ${slide.imagePath ? `<img class="thumb__image" src="${attr(withCacheBust(slide.imagePath, post.updatedAt))}" alt="" />` : `<div class="thumb__placeholder">${h(slide.type.toUpperCase())}</div>`}
            </button>
            ${slide.overflow ? `<span class="badge badge--error thumb__alert">!</span>` : ''}
            ${slide.verifyFailed ? `<span class="badge badge--error thumb__verify">⚠️</span>` : ''}
            <button class="thumb__delete" data-action="delete-slide" data-slide-id="${attr(slide.id)}" ${post.slides.length <= 2 ? 'disabled' : ''}>×</button>
          </div>
        `).join('')}
        <div class="thumb thumb--add">
          <button data-action="add-slide">＋</button>
        </div>
      </div>
    `;
  }

  function renderSlideFields(post, slide) {
    if (!slide) {
      return '';
    }
    const evidenceItems = slideEvidenceItems(post, slide);
    return `
      <div class="slide-panel-meta">
        <div class="chip-row">
          <div class="badge badge--neutral">${h(slide.type.toUpperCase())}</div>
          ${slide.verifyFailed ? `<div class="badge badge--error">⚠️ 검수 실패</div>` : ''}
          ${post.angle ? `
            <button class="chip-button" data-action="toggle-evidence" data-slide-id="${attr(slide.id)}">
              🔗 근거 ${evidenceItems.length} ${state.editor.evidenceExpanded[slide.id] ? '▴' : '▾'}
            </button>
          ` : ''}
          ${post.angle && slide.type === 'body' && !evidenceItems.length ? `<div class="badge badge--warning">⚠️ 근거 없음</div>` : ''}
        </div>
        ${slide.verifyFailed ? renderVerifyFailureCard(post, slide) : ''}
      </div>
    `;
  }

  function renderSlideEditorBody(post, slide) {
    if (!slide) {
      return `<div class="empty-state">슬라이드를 선택하세요.</div>`;
    }
    const dirtyDisabled = slide.dirty ? '' : 'disabled';
    const counter = slideCounter(slide);
    const warning = slideOverflowHint(slide);
    const evidenceItems = slideEvidenceItems(post, slide);
    const evidenceExpanded = Boolean(state.editor.evidenceExpanded[slide.id]);
    return `
      <div class="section">
        ${slide.type === 'cover' ? renderCoverFields(slide) : ''}
        ${slide.type === 'body' ? renderBodyFields(slide, counter, warning) : ''}
        ${slide.type === 'ending' ? renderEndingFields(slide) : ''}
        ${post.angle && evidenceExpanded ? `
          <div class="field">
            <div class="field__label"><span>근거</span></div>
            <div class="evidence-panel">${renderEvidenceList(evidenceItems)}</div>
          </div>
        ` : ''}
        <div class="editor-actions">
          <button class="button" data-action="render-slide" ${dirtyDisabled}>${state.editor.renderBusy ? '렌더 중...' : '렌더'}</button>
          <button class="button button--ghost" data-action="rewrite-slide">${state.editor.rewriteBusy ? 'AI 재작성 중...' : 'AI 재작성'}</button>
        </div>
        ${renderOverlayControls(slide)}
        <div class="field">
          <label class="field__label"><span>포인트색</span></label>
          <div class="accent-picker">
            ${ACCENT_PRESETS.map((accent) => {
              const active = rgbText(accent) === rgbText(state.currentPost.accent);
              return `
                <button class="accent-dot ${active ? 'is-active' : ''}" data-action="set-accent" data-rgb="${rgbText(accent)}">
                  <span style="background:${rgbCss(accent)}"></span>
                </button>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    `;
  }

  const OVERLAY_COLORS = ['#ffffff', '#111317', '#e5b456', '#3b82f6', '#22c55e', '#ef4444'];

  function renderOverlayControls(slide) {
    const overlays = (slide.text && Array.isArray(slide.text.overlays)) ? slide.text.overlays : [];
    const selected = overlays.find((o) => o.id === state.editor.selectedOverlayId);
    return `
      <div class="field">
        <label class="field__label">
          <span>텍스트 추가</span>
          <span class="help-inline">미리보기에서 드래그로 위치 조정</span>
        </label>
        <button class="button button--small" data-action="add-overlay">+ 텍스트 박스 추가</button>
      </div>
      ${selected ? `
      <div class="field overlay-edit">
        <label class="field__label"><span>선택한 텍스트</span></label>
        <textarea class="field__textarea field__textarea--small" data-bind="overlay-text" data-focus-id="overlay-text" placeholder="텍스트 입력 (줄바꿈 가능)">${h(selected.text)}</textarea>
        <label class="field__label"><span>크기</span><span class="help-inline">${selected.size}</span></label>
        <input class="field__range" type="range" min="16" max="180" step="2" data-bind="overlay-size" data-focus-id="overlay-size" value="${selected.size}" />
        <label class="field__label"><span>색</span></label>
        <div class="accent-picker">
          ${OVERLAY_COLORS.map((c) => `
            <button class="accent-dot ${c === selected.color ? 'is-active' : ''}" data-action="set-overlay-color" data-color="${attr(c)}">
              <span style="background:${attr(c)}; ${c === '#ffffff' ? 'border:1px solid #888;' : ''}"></span>
            </button>`).join('')}
        </div>
        <button class="button button--small button--ghost" data-action="delete-overlay" data-overlay-id="${attr(selected.id)}">선택 텍스트 삭제</button>
      </div>` : ''}
    `;
  }

  function renderCoverFields(slide) {
    const kbg = Number.isFinite(slide.text.kickerBg) ? slide.text.kickerBg : null;
    const kbgValue = kbg === null ? 88 : kbg;
    const hasKicker = Boolean((slide.text.kicker || '').trim());
    return `
      <div class="field">
        <label class="field__label"><span>제목</span></label>
        <textarea class="field__textarea field__textarea--small" data-bind="cover-headline" data-focus-id="cover-headline">${h(slide.text.headline || '')}</textarea>
      </div>
      <div class="field">
        <label class="field__label"><span>부제</span></label>
        <input class="field__input" type="text" data-bind="cover-kicker" data-focus-id="cover-kicker" value="${attr(slide.text.kicker || '')}" />
      </div>
      ${hasKicker ? `
      <div class="field">
        <label class="field__label">
          <span>부제 배경 불투명도</span>
          <span class="help-inline">${kbgValue}%</span>
        </label>
        <input class="field__range" type="range" min="0" max="100" step="1" data-bind="cover-kickerbg" data-focus-id="cover-kickerbg" value="${kbgValue}" />
      </div>` : ''}
    `;
  }

  function renderBodyFields(slide, counter, warning) {
    return `
      <div class="field">
        <label class="field__label"><span>소제목</span></label>
        <textarea class="field__textarea field__textarea--small" data-bind="body-subtitle" data-focus-id="body-subtitle">${h(slide.text.subtitle || '')}</textarea>
      </div>
      <div class="field">
        <label class="field__label">
          <span>본문</span>
          <span class="help-inline">강조 [단어] / 밑줄 _줄_</span>
        </label>
        <textarea class="field__textarea" data-bind="body-paragraphs" data-focus-id="body-paragraphs">${h(joinParagraphBlocks(slide.text.paragraphs || []))}</textarea>
        <div class="field__meta">
          <span>${counter}자</span>
          <span class="${warning ? 'is-warning' : ''}">${warning || '약식 글자수 가이드 내입니다.'}</span>
        </div>
      </div>
      <div class="field">
        <label class="field__label">
          <span>본문 간격</span>
          <span class="help-inline">${(Number.isFinite(slide.text.lineSpacing) ? slide.text.lineSpacing : 1.4).toFixed(2)}배</span>
        </label>
        <input class="field__range" type="range" min="1.2" max="1.8" step="0.05" data-bind="body-linespacing" data-focus-id="body-linespacing" value="${Number.isFinite(slide.text.lineSpacing) ? slide.text.lineSpacing : 1.4}" />
      </div>
      ${renderFontSizeField(slide, 'subtitle', '소제목 크기')}
      ${renderFontSizeField(slide, 'body', '본문 크기')}
      <div class="field">
        <label class="field__label">
          <span>출처</span>
          <span class="help-inline">슬라이드 하단에 작게 표기 (신뢰도)</span>
        </label>
        <input class="field__input" type="text" data-bind="body-source" data-focus-id="body-source" placeholder="예: SpaceX 공식 발표 · 2026" value="${attr(slide.text.source || '')}" />
      </div>
    `;
  }

  function bodyFontDefaults() {
    // renderer.js resolveRenderTheme와 동일 매핑 — light 레이아웃은 텍스트 존이 좁아 기본 폰트가 한 단계 작다
    const format = state.currentPost ? state.currentPost.format : null;
    const light = ['quote', 'profile', 'detective', 'listicle'].includes(format);
    return light ? { subtitle: 46, body: 36 } : { subtitle: 54, body: 40 };
  }

  function renderFontSizeField(slide, kind, title) {
    const key = kind === 'subtitle' ? 'subtitleSize' : 'bodySize';
    const manual = Number.isFinite(slide.text[key]) ? slide.text[key] : null;
    const fallback = bodyFontDefaults()[kind === 'subtitle' ? 'subtitle' : 'body'];
    const value = manual === null ? fallback : manual;
    return `
      <div class="field">
        <label class="field__label">
          <span>${title}</span>
          <span class="help-inline">
            ${manual === null ? `자동 (${fallback}px 기준)` : `${manual}px`}
            ${manual === null ? '' : `<button class="field__reset" data-action="font-size-auto" data-size-key="${key}">자동으로</button>`}
          </span>
        </label>
        <input class="field__range" type="range" min="24" max="72" step="1" data-bind="body-fontsize" data-size-key="${key}" data-focus-id="body-fontsize-${key}" value="${value}" />
      </div>
    `;
  }

  function renderEndingFields(slide) {
    return `
      <div class="field">
        <label class="field__label"><span>마무리 문구</span></label>
        <input class="field__input" type="text" data-bind="ending-headline" data-focus-id="ending-headline" value="${attr(slide.text.headline || slide.text.closing || '')}" />
      </div>
    `;
  }

  function renderAllSlidesEditor(post) {
    return `
      <div class="help-inline">전체 흐름을 한 번에 보면서 수정할 수 있습니다. 번호를 누르면 해당 슬라이드로 이동합니다.</div>
    `;
  }

  function renderAllSlidesBody(post) {
    return `
      <div class="list-editor">
        ${post.slides.map((slide, index) => `
          <div class="list-editor__slide ${slide.verifyFailed ? 'has-verify-failure' : ''}" data-slide-id="${attr(slide.id)}">
            <div class="field__label">
              <span class="chip-row">
                <span class="badge badge--neutral">${h(slide.type.toUpperCase())}</span>
                ${slide.verifyFailed ? `<span class="badge badge--error">⚠️ 검수 실패</span>` : ''}
                ${post.angle && slide.type === 'body' && !slideEvidenceItems(post, slide).length ? `<span class="badge badge--warning">⚠️ 근거 없음</span>` : ''}
              </span>
              <button class="slide-jump" data-action="select-slide" data-slide-id="${attr(slide.id)}">${index + 1}</button>
            </div>
            ${slide.verifyFailed ? renderVerifyFailureCard(post, slide) : ''}
            ${renderAllSlideInlineFields(slide, index)}
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderAllSlideInlineFields(slide, index) {
    if (slide.type === 'cover') {
      return `
        <textarea class="field__textarea field__textarea--small" data-bind="cover-headline" data-focus-id="cover-headline-${index}">${h(slide.text.headline || '')}</textarea>
        <input class="field__input" type="text" data-bind="cover-kicker" data-focus-id="cover-kicker-${index}" value="${attr(slide.text.kicker || '')}" />
      `;
    }
    if (slide.type === 'ending') {
      return `
        <input class="field__input" type="text" data-bind="ending-headline" data-focus-id="ending-headline-${index}" value="${attr(slide.text.headline || slide.text.closing || '')}" />
      `;
    }
    return `
      <textarea class="field__textarea field__textarea--small" data-bind="body-subtitle" data-focus-id="body-subtitle-${index}">${h(slide.text.subtitle || '')}</textarea>
      <textarea class="field__textarea" data-bind="body-paragraphs" data-focus-id="body-paragraphs-${index}">${h(joinParagraphBlocks(slide.text.paragraphs || []))}</textarea>
    `;
  }

  function renderImagePicker(post, slide) {
    const candidates = (post.imageCandidates || []);
    return `
      <div class="image-picker">
        <div>
          <strong>이미지 교체</strong>
        </div>
        <div class="image-grid">
          ${candidates.map((candidate) => {
            const src = candidate.localPath ? withCacheBust(toAssetPath(post.id, candidate.localPath), post.updatedAt) : candidate.url;
            const active = candidate.localPath && slide.photo === candidate.localPath;
            return `
              <button class="image-grid__item ${active ? 'is-active' : ''}" data-action="select-candidate" data-local-path="${attr(candidate.localPath || '')}" ${candidate.localPath ? '' : 'disabled'}>
                ${src ? `<img src="${attr(src)}" alt="" />` : '<span></span>'}
              </button>
            `;
          }).join('')}
        </div>
        <div class="upload-box">
          <div class="help-inline">로컬 업로드는 base64 JSON으로 서버에 전송됩니다. 10MB 이하만 허용됩니다.</div>
          <input type="file" accept="image/*" data-bind="image-upload" />
        </div>
      </div>
    `;
  }

  function renderThreadsScreen() {
    const view = state.threadsView;
    const intensities = [
      { id: 'calm', label: '차분', hint: '어그로 최소·분석 중심' },
      { id: 'standard', label: '표준', hint: 'DNA 훅 공식 그대로' },
      { id: 'spicy', label: '센캐', hint: '훅·위협 최대(사실 유지)' },
    ];
    const canGenerate = view.input.trim() && !view.generating;

    return `
      <main class="screen threads-screen">
        <div class="threads-stack">
          <section class="card thread-composer">
            <div class="thread-composer__head">
              <h2>🧵 스레드 텍스트</h2>
              <p class="thread-composer__sub">주제 · 링크(스레드/인스타/X/유튜브/기사) · 붙여넣은 글 아무거나 넣으면, 후킹부터 전개·체류까지 바이럴 스레드 화법으로 써줍니다.</p>
            </div>
            <textarea
              class="thread-composer__input"
              rows="5"
              placeholder="예) 엔비디아 젠슨 황 방한과 AI 팩토리\n또는 https://www.threads.com/@.../post/...\n또는 분석하고 싶은 기사·글 통째로 붙여넣기"
              data-bind="thread-input"
              data-focus-id="thread-input"
            >${h(view.input)}</textarea>
            <div class="thread-composer__controls">
              <div class="thread-intensity">
                ${intensities.map((item) => `
                  <button
                    class="thread-intensity__btn ${view.intensity === item.id ? 'is-active' : ''}"
                    data-action="set-thread-intensity"
                    data-intensity="${item.id}"
                    title="${attr(item.hint)}"
                  >${h(item.label)}</button>
                `).join('')}
              </div>
              <label class="thread-count">
                <span>본문 수</span>
                <input
                  class="thread-count__input"
                  type="number"
                  min="4"
                  max="20"
                  placeholder="자동"
                  value="${attr(String(view.count))}"
                  data-bind="thread-count"
                />
              </label>
              <button class="btn btn--primary thread-composer__go" data-action="generate-thread" ${canGenerate ? '' : 'disabled'}>
                ${view.generating ? '생성 중…' : '스레드 생성'}
              </button>
            </div>
            ${view.cliUnavailable ? `<div class="warning-inline">Claude CLI에 연결할 수 없습니다. 설정의 CLI 경로를 확인하세요.</div>` : ''}
            ${view.error && !view.cliUnavailable ? `<div class="warning-inline">${h(view.error)}</div>` : ''}
          </section>

          ${view.generating ? `
            <section class="card thread-loading">
              <div class="spinner"></div>
              <div>훅을 짓고 사슬을 엮는 중… (최대 1~2분)</div>
            </section>
          ` : ''}

          ${view.result ? renderThreadResult(view.result, view.meta) : (!view.generating ? renderThreadEmpty() : '')}
        </div>
      </main>
    `;
  }

  function renderThreadEmpty() {
    return `
      <section class="card thread-empty">
        <div class="thread-empty__title">아직 생성된 스레드가 없습니다</div>
        <div class="thread-empty__body">위에 소재를 넣고 <strong>스레드 생성</strong>을 누르면, 리드 훅 → 번호 매긴 본문 사슬 → 더보기 유도까지 한 번에 만들어집니다.<br/>각 포스트는 복사해서 Threads에 순서대로 올리면 됩니다.</div>
      </section>
    `;
  }

  function renderThreadResult(result, meta) {
    const posts = Array.isArray(result.posts) ? result.posts : [];
    const intensityLabel = meta && meta.intensity === 'calm' ? '차분' : meta && meta.intensity === 'spicy' ? '센캐' : '표준';
    return `
      <section class="thread-result">
        <div class="thread-result__bar">
          <div class="thread-result__meta">${posts.length}개 본문 · ${h(intensityLabel)}${meta && meta.extractedTitle ? ` · 소재: ${h(meta.extractedTitle)}` : ''}</div>
          <button class="btn btn--ghost" data-action="copy-thread-all">전체 복사</button>
        </div>

        ${result.lead ? `
          <article class="thread-post thread-post--lead">
            <div class="thread-post__tag">리드 · 훅</div>
            <div class="thread-post__text">${formatThreadText(result.lead)}</div>
            <button class="thread-post__copy" data-action="copy-thread-post" data-thread-part="lead">복사</button>
            ${result.imageHint ? `<div class="thread-post__hint">🖼️ 이미지: ${h(result.imageHint)}</div>` : ''}
          </article>
        ` : ''}

        ${posts.map((post, index) => `
          <article class="thread-post">
            <div class="thread-post__tag">${post.n} / ${posts.length}</div>
            <div class="thread-post__text">${formatThreadText(post.text)}</div>
            <button class="thread-post__copy" data-action="copy-thread-post" data-thread-index="${index}">복사</button>
          </article>
        `).join('')}

        ${result.closing ? `
          <article class="thread-post thread-post--closing">
            <div class="thread-post__tag">마무리 · 더보기</div>
            <div class="thread-post__text">${formatThreadText(result.closing)}</div>
            <button class="thread-post__copy" data-action="copy-thread-post" data-thread-part="closing">복사</button>
          </article>
        ` : ''}
      </section>
    `;
  }

  function formatThreadText(value) {
    return h(String(value || '')).replace(/\n/g, '<br/>');
  }

  function threadPlainText(result) {
    const parts = [];
    if (result.lead) {
      parts.push(result.lead);
    }
    (Array.isArray(result.posts) ? result.posts : []).forEach((post) => parts.push(post.text));
    if (result.closing) {
      parts.push(result.closing);
    }
    return parts.join('\n\n———\n\n');
  }

  function renderSourcesScreen() {
    const filteredSources = filterSources(state.sources);
    return `
      <main class="screen sources">
        <section class="card source-add">
          <div class="sources-toolbar__title">
            <h2>소스 레지스트리</h2>
          </div>
          <div class="source-add__row">
            <input
              class="field__input"
              type="text"
              placeholder="인스타 · 스레드 · X · 유튜브 · 블로그 · 기사 URL"
              data-bind="source-add-input"
              data-focus-id="source-add-input"
              value="${attr(state.sourcesView.addInput)}"
            />
            <button class="button" data-action="register-source">${state.sourcesView.registering ? '등록 중...' : '등록'}</button>
          </div>
          ${state.sourcesView.registering ? renderBanner('원본 소스 역추적 진행 중...', []) : ''}
          ${state.sourcesView.cliUnavailable ? renderBanner('Claude CLI에 연결할 수 없습니다', [
            { label: '설정 열기', action: 'open-settings' },
          ]) : ''}
          ${state.sourcesView.manualTrace ? renderManualSourceForm() : ''}
        </section>
        ${renderTraceAnalysis()}
        <section class="sources-toolbar">
          <div class="sources-toolbar__title">
            <h2>소스 ${state.sources.length}개</h2>
          </div>
          <div class="sources-toolbar__filters">
            <div class="tabs">
              ${renderSourceTagTabs()}
            </div>
            <input class="sources-toolbar__search" type="text" placeholder="검색" data-bind="source-search" data-focus-id="source-search" value="${attr(state.sourcesView.query)}" />
          </div>
        </section>
        ${filteredSources.length ? `
          <section class="sources-list">
            ${filteredSources.map(renderSourceCard).join('')}
          </section>
        ` : `
          <div class="empty-state">
            <div>벤치마크할 인스타 계정이나 뉴스 소스를 등록하세요</div>
            <div>AI가 원본 매체와 스타일 태그를 추적해 저장합니다.</div>
          </div>
        `}
      </main>
    `;
  }

  function renderTraceAnalysis() {
    const trace = state.sourcesView.lastTrace;
    if (!trace) {
      return '';
    }
    const KIND_LABELS = { image: '이미지', video: '영상', claim: '주장', data: '자료' };
    const HOW_LABELS = { 'direct-link': '포스트 내 직접 링크', 'web-search': '웹 검색으로 확인', estimate: '추정' };
    const items = trace.items || [];
    const existingPost = findExistingUrlPost(trace.url);
    const estimateCount = items.filter((item) => traceItemConfidence(item) < 0.7).length;
    return `
      <section class="card trace-analysis">
        <div class="trace-analysis__header">
          <h2>콘텐츠 분석</h2>
          <button class="button button--small button--ghost" data-action="dismiss-trace-analysis">닫기</button>
        </div>
        <div class="trace-analysis__meta">${h(trace.url)} · 등록된 소스 ${trace.savedCount}개</div>
        ${trace.summary ? `<p class="trace-analysis__summary">${h(trace.summary)}</p>` : ''}
        ${items.length ? `
          <ul class="trace-items">
            ${items.map((item) => `
              <li class="trace-item">
                <span class="badge trace-item__kind trace-item__kind--${attr(item.kind)}">${KIND_LABELS[item.kind] || '주장'}</span>
                <div class="trace-item__body">
                  <div class="trace-item__desc">${h(item.desc)}</div>
                  <div class="trace-item__origin">
                    ${item.origin && item.origin.name ? `→ ${h(item.origin.name)}` : '→ 원본 미확인'}
                    ${item.origin && item.origin.url ? ` <a href="${attr(item.origin.url)}" target="_blank" rel="noopener">${h(item.origin.domain || '원본 링크')}</a>` : ''}
                    ${item.origin ? ` <span class="trace-item__how">(${HOW_LABELS[item.origin.how] || '추정'} · ${Math.round((item.origin.confidence || 0) * 100)}%)</span>` : ''}
                  </div>
                </div>
              </li>
            `).join('')}
          </ul>
        ` : `<div class="trace-analysis__empty">콘텐츠 항목을 분해하지 못했습니다 — 등록 후보만 저장됐습니다.</div>`}
        ${(trace.outboundLinks || []).length ? `
          <div class="trace-analysis__links">포스트 내 링크: ${trace.outboundLinks.map((link) => `<a href="${attr(link)}" target="_blank" rel="noopener">${h(safeDomain(link))}</a>`).join(' · ')}</div>
        ` : ''}
        <div class="trace-cta">
          <div class="trace-cta__meta">
            <strong>분석에서 바로 포스트로 연결</strong>
            <span>인벤토리 ${items.length}개 · 추정 항목 ${estimateCount}개</span>
          </div>
          ${existingPost ? `
            <button class="button button--ghost" data-action="open-existing-trace-post">🔗 만든 포스트 보기</button>
          ` : `
            <button class="button button--primary" data-action="open-trace-angle-panel" ${items.length ? '' : 'disabled'}>📌 이 분석으로 포스트 만들기</button>
          `}
        </div>
        ${!existingPost && !items.length ? `<div class="help-inline">인벤토리 항목이 0개라 앵글 후보를 만들 수 없습니다. 소스를 더 확인해보세요.</div>` : ''}
        ${renderAnglePanel()}
      </section>
    `;
  }

  function renderAnglePanel() {
    const trace = state.sourcesView.lastTrace;
    const panel = state.sourcesView.anglePanel;
    if (!trace || !panel.open) {
      return '';
    }
    const hintOptions = [
      '📊 더 데이터 중심',
      '💬 더 감정·스토리',
      '🔢 더 짧게',
      '🎯 다른 주제축',
    ];
    return `
      <section class="trace-angles">
        <div class="trace-angles__header">
          <div>
            <h3>앵글 후보</h3>
            <p>분석한 인벤토리로 바로 매거진 구조를 제안합니다.</p>
          </div>
          <div class="trace-angles__actions">
            <button class="button button--small button--ghost" data-action="toggle-angle-reroll">🔄 다시 제안</button>
            <button class="button button--small button--ghost" data-action="toggle-manual-angle">✏️ 직접 입력</button>
          </div>
        </div>
        <div class="field trace-direction">
          <label class="field__label">
            <span>🧭 방향 지시 (선택)</span>
            <span class="help-inline">비우면 앵글 그대로 진행 — 맥락·흐름·타겟을 한 줄로</span>
          </label>
          <input class="field__input" type="text" data-bind="angle-direction" data-focus-id="angle-direction" placeholder="예: 초보 투자자 눈높이로, 머스크 리스크를 중심축으로 풀어줘" value="${attr(panel.direction || '')}" />
        </div>
        ${panel.requestCount >= 2 ? `<div class="banner banner--warning"><p class="banner__message">💡 인벤토리가 약하면 앵글이 비슷해집니다 — 소스를 추가해보세요</p></div>` : ''}
        ${panel.rerollOpen ? `
          <div class="trace-angles__reroll">
            <div class="trace-angles__hints">
              ${hintOptions.map((hint) => `
                <button class="trace-hint-chip ${panel.selectedHints.includes(hint) ? 'is-active' : ''}" data-action="toggle-angle-hint" data-hint="${attr(hint)}">${h(hint)}</button>
              `).join('')}
            </div>
            <button class="button button--small" data-action="submit-angle-reroll" ${panel.selectedHints.length ? '' : 'disabled'}>이 방향으로 다시 제안</button>
          </div>
        ` : ''}
        ${panel.manualOpen ? `
          <div class="trace-manual-angle">
            <input class="field__input" type="text" placeholder="직접 정한 제목" value="${attr(panel.manualTitle)}" data-bind="angle-manual-title" data-focus-id="angle-manual-title" />
            <input class="field__input" type="text" placeholder="훅 또는 한 줄 방향" value="${attr(panel.manualHook)}" data-bind="angle-manual-hook" data-focus-id="angle-manual-hook" />
            <button class="button button--small" data-action="create-manual-angle-post" ${panel.manualTitle.trim() && panel.manualHook.trim() ? '' : 'disabled'}>${panel.creating ? '생성 중...' : '생성'}</button>
          </div>
        ` : ''}
        ${panel.loading ? `
          <div class="trace-angles__loading">
            <div class="trace-angle-grid">
              ${Array.from({ length: 3 }).map(() => `
                <div class="trace-angle-skeleton">
                  <div class="trace-angle-skeleton__line trace-angle-skeleton__line--short"></div>
                  <div class="trace-angle-skeleton__line trace-angle-skeleton__line--title"></div>
                  <div class="trace-angle-skeleton__line"></div>
                  <div class="trace-angle-skeleton__line"></div>
                </div>
              `).join('')}
            </div>
            <div class="help-inline">AI가 앵글 후보를 만드는 중… (30~90초)</div>
          </div>
        ` : ''}
        ${panel.error ? renderBanner(panel.error, [
          { label: '다시 시도', action: 'retry-angles' },
        ]) : ''}
        ${!panel.loading && !panel.error && !panel.angles.length ? `
          <div class="trace-angles__empty">아직 추천된 앵글이 없습니다. 다시 제안하거나 직접 입력으로 시작할 수 있습니다.</div>
        ` : ''}
        ${!panel.loading && !panel.error && panel.angles.length ? `
          <div class="trace-angle-grid">
            ${panel.angles.map((angle, index) => renderAngleCard(angle, index)).join('')}
          </div>
        ` : ''}
      </section>
    `;
  }

  function renderAngleCard(angle, index) {
    const toneMeta = angleToneMeta(angle.tone);
    return `
      <article class="card trace-angle-card">
        <div class="trace-angle-card__top">
          <span class="badge ${toneMeta.className}">${h(toneMeta.label)}</span>
          <span class="help-inline">${h((angle.postType || '').toUpperCase())}</span>
        </div>
        <h4 class="trace-angle-card__title">${h(angle.title || '')}</h4>
        <blockquote class="trace-angle-card__hook">${h(angle.hook || '')}</blockquote>
        <div class="trace-angle-card__map">
          ${(angle.structure || []).map((role) => `<span class="trace-structure-dot trace-structure-dot--${attr(role)}">■</span>`).join('')}
        </div>
        ${Number(angle.estimateCount || 0) >= 2 ? `<div class="badge badge--warning">⚠️ 추정 항목 ${Number(angle.estimateCount || 0)}개</div>` : '<div></div>'}
        <button class="button button--small" data-action="create-angle-post" data-angle-index="${index}" ${state.sourcesView.anglePanel.creating ? 'disabled' : ''}>이 앵글로 만들기</button>
      </article>
    `;
  }

  function renderSourceTagTabs() {
    const tags = uniq(state.sources.flatMap((source) => source.topics || []));
    return [
      `<button class="tab ${state.sourcesView.tag ? '' : 'is-active'}" data-action="clear-source-tag-filter">전체</button>`,
    ].concat(tags.map((tag) => `
      <button class="tab ${state.sourcesView.tag === tag ? 'is-active' : ''}" data-action="set-source-tag-filter" data-tag="${attr(tag)}">${h(tag)}</button>
    `)).join('');
  }

  function renderSourceCard(source) {
    const expanded = Boolean(state.sourcesView.expanded[source.id]);
    const notesDraft = state.sourcesView.notesDrafts[source.id] !== undefined
      ? state.sourcesView.notesDrafts[source.id]
      : source.notes || '';
    const tagDraft = state.sourcesView.tagDrafts[source.id] || '';
    return `
      <article class="card source-card">
        <div class="source-card__header">
          <div>
            ${source.domain ? `<img class="source-card__favicon" src="https://www.google.com/s2/favicons?sz=64&domain=${attr(source.domain)}" alt="" />` : '<div class="source-card__favicon"></div>'}
          </div>
          <div>
            <h3 class="source-card__title">${h(source.name || source.domain)}</h3>
            <div class="source-card__domain">${h(source.domain || '')}</div>
            <div class="chip-row">
              ${(source.topics || []).map((tag) => `
                <span class="tag-chip">
                  ${h(tag)}
                  <button data-action="remove-source-tag" data-source-id="${attr(source.id)}" data-tag="${attr(tag)}">×</button>
                </span>
              `).join('')}
            </div>
          </div>
          <div>
            <button class="button button--ghost button--tiny" data-action="toggle-source-expand" data-source-id="${attr(source.id)}">${expanded ? '접기' : '열기'}</button>
          </div>
        </div>
        <button class="source-card__delete" data-action="delete-source" data-source-id="${attr(source.id)}">×</button>
        ${expanded ? `
          <div class="source-card__expand">
            <div class="source-card__meta">
              ${source.url ? `<a href="${attr(source.url)}" target="_blank" rel="noreferrer">원본 URL 열기</a>` : ''}
              <div>역추적 경로: ${h(source.addedFrom || 'manual')}</div>
              <div>등록일: ${h(formatDate(source.createdAt))}</div>
            </div>
            <div class="inline-form">
              <input type="text" data-bind="source-tag-draft" data-source-id="${attr(source.id)}" data-focus-id="source-tag-${attr(source.id)}" value="${attr(tagDraft)}" placeholder="스타일 태그 추가" />
              <button class="button button--small button--ghost" data-action="add-source-tag" data-source-id="${attr(source.id)}">태그 추가</button>
            </div>
            <div class="field">
              <label class="field__label"><span>메모</span></label>
              <textarea class="field__textarea field__textarea--small" data-bind="source-notes" data-source-id="${attr(source.id)}" data-focus-id="source-notes-${attr(source.id)}">${h(notesDraft)}</textarea>
              <div class="editor-actions">
                <button class="button button--small button--ghost" data-action="save-source-notes" data-source-id="${attr(source.id)}">메모 저장</button>
              </div>
            </div>
          </div>
        ` : ''}
      </article>
    `;
  }

  function renderManualSourceForm() {
    const draft = state.sourcesView.manualTrace;
    return `
      <div class="banner">
        <p class="banner__message">원본 소스를 찾을 수 없습니다</p>
        <div class="field">
          <input class="field__input" type="text" placeholder="매체명" data-bind="manual-source-name" data-focus-id="manual-source-name" value="${attr(draft.name || '')}" />
          <input class="field__input" type="text" placeholder="원본 URL" data-bind="manual-source-url" data-focus-id="manual-source-url" value="${attr(draft.url || '')}" />
          <input class="field__input" type="text" placeholder="도메인" data-bind="manual-source-domain" data-focus-id="manual-source-domain" value="${attr(draft.domain || '')}" />
          <input class="field__input" type="text" placeholder="스타일 태그 (쉼표 구분)" data-bind="manual-source-tags" data-focus-id="manual-source-tags" value="${attr(draft.tags || '')}" />
        </div>
        <div class="banner__actions">
          <button class="button button--small" data-action="save-manual-source">직접 입력으로 등록</button>
        </div>
      </div>
    `;
  }

  function renderSettingsModal() {
    const draft = ensureSettingsDraft();
    const current = state.settings;
    return `
      <div class="modal-layer">
        <div class="modal">
          <div class="modal__header">
            <h2>설정</h2>
            <button class="icon-button" data-action="close-settings">×</button>
          </div>
          <div class="modal__body">
            <section class="settings-section">
              <h3 class="settings-section__title">Anthropic API 키</h3>
              <div class="field">
                <label class="field__label"><span>내 API 키 (sk-ant-…)</span></label>
                <input class="field__input field__mono" type="password" autocomplete="off" placeholder="sk-ant-..." data-bind="settings-api-key" data-focus-id="settings-api-key" value="${attr(getStoredApiKey())}" />
                <div class="help-inline">${getStoredApiKey() ? '✅ 이 브라우저에 저장됨 — 생성은 이 키(=내 토큰)로 청구됩니다.' : '키가 없으면 생성이 안 됩니다. console.anthropic.com에서 발급한 키를 넣으세요.'} 키는 이 브라우저에만 저장되고 서버에 보관·기록하지 않습니다.</div>
              </div>
            </section>
            <section class="settings-section">
              <h3 class="settings-section__title">브랜드</h3>
              <div class="field">
                <label class="field__label"><span>워터마크 텍스트</span></label>
                <input class="field__input" type="text" data-bind="settings-brand" data-focus-id="settings-brand" value="${attr(draft.brand)}" />
              </div>
              <div class="field">
                <label class="field__label"><span>기본 포인트색</span></label>
                <div class="accent-picker">
                  ${ACCENT_PRESETS.map((accent) => {
                    const active = rgbText(accent) === rgbText(draft.defaultAccent);
                    return `
                      <button class="accent-dot ${active ? 'is-active' : ''}" data-action="set-default-accent" data-rgb="${rgbText(accent)}">
                        <span style="background:${rgbCss(accent)}"></span>
                      </button>
                    `;
                  }).join('')}
                </div>
                <div class="help-inline">기본 포인트색은 아래 저장 버튼으로 서버에 반영됩니다.</div>
              </div>
            </section>
            <section class="settings-section">
              <h3 class="settings-section__title">톤 프리셋 관리</h3>
              <div class="preset-list">
                ${(draft.tonePresets || []).map((preset) => `
                  <div class="preset-item">
                    <div class="preset-item__top">
                      <div>
                        <p class="preset-item__name">${h(preset.name)}</p>
                        <p class="preset-item__desc">${h(preset.description || '')}</p>
                      </div>
                      ${draft.defaultTone === preset.id ? '<span class="badge badge--accent">기본</span>' : ''}
                    </div>
                    <div class="preset-item__controls">
                      <button class="button button--ghost button--tiny" data-action="toggle-tone-preset-edit" data-tone-id="${attr(preset.id)}">${draft.editingToneId === preset.id ? '접기' : '편집'}</button>
                      <button class="button button--ghost button--tiny" data-action="delete-tone-preset" data-tone-id="${attr(preset.id)}" ${draft.tonePresets.length <= 1 ? 'disabled' : ''}>삭제</button>
                      <button class="button button--ghost button--tiny" data-action="set-default-tone" data-tone-id="${attr(preset.id)}" ${draft.defaultTone === preset.id ? 'disabled' : ''}>기본 지정</button>
                    </div>
                    ${draft.editingToneId === preset.id ? `
                      <div class="field">
                        <label class="field__label"><span>ID</span></label>
                        <input class="field__input field__mono" type="text" data-bind="settings-tone-id" data-tone-id="${attr(preset.id)}" data-focus-id="settings-tone-id-${attr(preset.id)}" value="${attr(preset.id)}" />
                      </div>
                      <div class="field">
                        <label class="field__label"><span>이름</span></label>
                        <input class="field__input" type="text" data-bind="settings-tone-name" data-tone-id="${attr(preset.id)}" data-focus-id="settings-tone-name-${attr(preset.id)}" value="${attr(preset.name)}" />
                      </div>
                      <div class="field">
                        <label class="field__label"><span>설명</span></label>
                        <input class="field__input" type="text" data-bind="settings-tone-description" data-tone-id="${attr(preset.id)}" data-focus-id="settings-tone-description-${attr(preset.id)}" value="${attr(preset.description || '')}" />
                      </div>
                      <div class="field">
                        <label class="field__label"><span>프롬프트 suffix</span></label>
                        <textarea class="field__textarea field__textarea--small" data-bind="settings-tone-prompt-suffix" data-tone-id="${attr(preset.id)}" data-focus-id="settings-tone-prompt-suffix-${attr(preset.id)}">${h(preset.promptSuffix || '')}</textarea>
                      </div>
                    ` : ''}
                  </div>
                `).join('')}
                <button class="button button--ghost button--small" data-action="add-tone-preset">+ 프리셋 추가</button>
              </div>
            </section>
            <section class="settings-section">
              <h3 class="settings-section__title">경로</h3>
              <div class="field">
                <label class="field__label"><span>make_card.py</span></label>
                <input class="field__input field__mono" type="text" value="${attr(current.makeCardPath || '(자동 감지)')}" readonly />
              </div>
              <div class="field">
                <label class="field__label"><span>Export 기본 폴더</span></label>
                <input class="field__input field__mono" type="text" value="${attr(current.exportPath || '(포스트별 export 디렉터리)')}" readonly />
              </div>
            </section>
            <section class="settings-section">
              <h3 class="settings-section__title">Claude CLI</h3>
              <div class="field">
                <label class="field__label"><span>경로</span></label>
                <input class="field__input field__mono" type="text" value="${attr(current.claudePath || '(미설정)')}" readonly />
              </div>
              <div class="editor-actions">
                <button class="button button--small button--ghost" data-action="test-cli">연결 테스트</button>
                ${state.settingsModal.cliTest ? `
                  <span class="badge ${state.settingsModal.cliTest.status === 'success' ? 'badge--success' : state.settingsModal.cliTest.status === 'error' ? 'badge--error' : 'badge--neutral'}">${h(state.settingsModal.cliTest.message)}</span>
                ` : ''}
              </div>
            </section>
          </div>
          <div class="modal__footer">
            <button class="button button--ghost button--small" data-action="close-settings">닫기</button>
            <button class="button button--small" data-action="save-settings">저장</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderExportOverlay() {
    const result = state.exportResult;
    return `
      <div class="export-overlay">
        <div class="export-card">
          <div>
            <h2>Export 완료</h2>
            <p>Finder에서 폴더가 열렸습니다. 같은 와이파이의 폰에서 QR을 스캔해 이미지를 저장할 수 있습니다.</p>
          </div>
          <div class="export-card__path">${h(result.dir)}</div>
          <div class="export-card__qr">
            <img src="${attr(result.qrSvg)}" alt="QR code" />
          </div>
          <div class="help-inline">공유 URL: <a href="${attr(result.url)}" target="_blank" rel="noreferrer">${h(result.url)}</a></div>
          <div class="help-inline">만료: ${h(result.expiresAt)}</div>
          <div class="editor-actions">
            <button class="button button--small" data-action="copy-caption">캡션 복사</button>
            <button class="button button--ghost button--small" data-action="close-export">닫기</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderEditorInlineBanners(post) {
    const banners = [];
    const generationBanner = renderPostErrorBanner(post);
    if (generationBanner) {
      banners.push(generationBanner);
    }
    if (state.editor.cliUnavailable && !isCliUnavailablePostError(post)) {
      banners.push(renderBanner('Claude CLI에 연결할 수 없습니다', [
        { label: '설정 열기', action: 'open-settings' },
      ]));
    }
    if (state.editor.exportError) {
      banners.push(renderBanner(state.editor.exportError, [
        { label: '재시도', action: 'export-post' },
      ]));
    }
    return banners.join('');
  }

  function renderPostErrorBanner(post) {
    if (post.status !== 'error') {
      return '';
    }
    if (isCliUnavailablePostError(post)) {
      return renderBanner('Claude CLI에 연결할 수 없습니다', [
        { label: '설정 열기', action: 'open-settings' },
      ]);
    }
    if (post.failedStage === 'collecting') {
      return `
        ${renderBanner(post.error || '이 URL에서 본문을 가져올 수 없습니다', [
          { label: '재시도', action: 'retry-generate', stage: 'collecting' },
        ], `
          <div class="field">
            <label class="field__label"><span>본문 직접 붙여넣기</span></label>
            <textarea class="field__textarea" data-bind="body-fallback" data-focus-id="body-fallback">${h(state.editor.bodyFallbackText)}</textarea>
          </div>
          <div class="banner__actions">
            <button class="button button--small" data-action="manual-draft">수동 초안 만들기</button>
          </div>
        `)}
      `;
    }
    if (post.failedStage === 'writing') {
      return renderBanner(post.error || 'AI 응답 타임아웃 (60초 초과)', [
        { label: '재시도', action: 'retry-generate', stage: 'writing' },
      ]);
    }
    if (post.failedStage === 'rendering') {
      return renderBanner(post.error || '슬라이드 이미지 생성 실패', [
        { label: '재시도', action: 'retry-generate', stage: 'rendering' },
      ]);
    }
    return renderBanner(post.error || '오류가 발생했습니다.', [
      { label: '재시도', action: 'retry-generate', stage: post.resumeStage || 'collecting' },
    ]);
  }

  function isCliUnavailablePostError(post) {
    return Boolean(post && post.status === 'error' && post.error === 'Claude CLI에 연결할 수 없습니다');
  }

  function renderBanner(message, actions, extraHtml) {
    return `
      <div class="banner">
        <p class="banner__message">${h(message)}</p>
        ${actions && actions.length ? `
          <div class="banner__actions">
            ${actions.map((action) => `
              <button class="button button--small button--ghost" data-action="${action.action}" ${action.stage ? `data-stage="${attr(action.stage)}"` : ''}>${h(action.label)}</button>
            `).join('')}
          </div>
        ` : ''}
        ${extraHtml || ''}
      </div>
    `;
  }

  function renderToasts() {
    toastRoot.innerHTML = state.toasts.map((toast) => `
      <div class="toast">
        <p class="toast__message">${h(toast.message)}</p>
        <div class="toast__actions">
          ${toast.undoLabel ? `<button class="button button--small button--ghost" data-action="undo-toast" data-toast-id="${attr(toast.id)}">${h(toast.undoLabel)}</button>` : ''}
          <button class="button button--small button--ghost" data-action="dismiss-toast" data-toast-id="${attr(toast.id)}">닫기</button>
        </div>
      </div>
    `).join('');
  }

  function parseRoute(pathname) {
    if (pathname === '/sources') {
      return { name: 'sources' };
    }
    if (pathname === '/threads') {
      return { name: 'threads' };
    }
    const match = pathname.match(/^\/post\/([^/]+)$/);
    if (match) {
      return { name: 'editor', postId: decodeURIComponent(match[1]) };
    }
    return { name: 'dashboard' };
  }

  const API_KEY_STORAGE = 'carousel-anthropic-key';

  function getStoredApiKey() {
    try {
      return (window.localStorage.getItem(API_KEY_STORAGE) || '').trim();
    } catch (error) {
      return '';
    }
  }

  function setStoredApiKey(value) {
    try {
      const trimmed = (value || '').trim();
      if (trimmed) {
        window.localStorage.setItem(API_KEY_STORAGE, trimmed);
      } else {
        window.localStorage.removeItem(API_KEY_STORAGE);
      }
    } catch (error) {
      /* localStorage 불가 환경은 무시 */
    }
  }

  async function api(method, url, body) {
    const headers = {};
    if (body) {
      headers['Content-Type'] = 'application/json';
    }
    // 사용자 Anthropic API 키 — 브라우저에만 저장, 요청 헤더로만 전송.
    const apiKey = getStoredApiKey();
    if (apiKey) {
      headers['x-anthropic-key'] = apiKey;
    }
    const response = await fetch(url, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message = data && data.error && data.error.message ? data.error.message : `HTTP ${response.status}`;
      const error = new Error(message);
      if (data && data.error && data.error.code) {
        error.code = data.error.code;
      }
      throw error;
    }
    return data;
  }

  function detectInput(value) {
    if (!value) {
      return {
        apiInputType: 'topic',
        badge: '',
        warning: '',
      };
    }
    if (/^https?:\/\//i.test(value)) {
      try {
        const parsed = new URL(value);
        if (/instagram\.com/i.test(parsed.hostname)) {
          return {
            apiInputType: 'url',
            badge: `<span class="badge badge--purple">📸 인스타 포스트</span>`,
            warning: 'URL은 분석을 거쳐 만듭니다',
          };
        }
        if (/threads\.(com|net)/i.test(parsed.hostname)) {
          return {
            apiInputType: 'threads',
            badge: `<span class="badge badge--purple">🧵 스레드 포스트 — 생성 대신 소스 분석으로 이동합니다</span>`,
            warning: 'URL은 분석을 거쳐 만듭니다',
          };
        }
        if (/(^|\.)(twitter\.com|x\.com)$/i.test(parsed.hostname)) {
          return {
            apiInputType: 'threads',
            badge: `<span class="badge badge--purple">𝕏 트윗 — 생성 대신 소스 분석으로 이동합니다</span>`,
            warning: 'URL은 분석을 거쳐 만듭니다',
          };
        }
        if (/(^|\.)(youtube\.com|youtu\.be)$/i.test(parsed.hostname)) {
          return {
            apiInputType: 'url',
            badge: `<span class="badge badge--accent">▶ 유튜브 영상</span>`,
            warning: 'URL은 분석을 거쳐 만듭니다',
          };
        }
        return {
          apiInputType: 'url',
          badge: `<span class="badge badge--accent">🔗 뉴스 URL</span>`,
          warning: 'URL은 분석을 거쳐 만듭니다',
        };
      } catch (error) {
        return {
          apiInputType: 'topic',
          badge: `<span class="badge badge--neutral">📝 주제 기반 생성</span>`,
          warning: 'URL을 열 수 없습니다 - 주제로 처리합니다',
        };
      }
    }
    return {
      apiInputType: 'topic',
      badge: `<span class="badge badge--neutral">📝 주제 기반 생성</span>`,
      warning: '',
    };
  }

  function ensureEditorDraft(post) {
    if (!post) {
      return { caption: '', hashtags: '' };
    }
    if (!state.editor.drafts[post.id]) {
      state.editor.drafts[post.id] = extractCaptionDraft(post.caption);
    }
    return state.editor.drafts[post.id];
  }

  function extractCaptionDraft(caption) {
    const value = typeof caption === 'string' ? caption : '';
    const parts = value.split(/\n{2,}/);
    const last = parts[parts.length - 1] || '';
    if (/^#/.test(last.trim())) {
      return {
        caption: parts.slice(0, -1).join('\n\n'),
        hashtags: last.trim(),
      };
    }
    return {
      caption: value,
      hashtags: '',
    };
  }

  function ensureSettingsDraft() {
    if (!state.settingsModal.draft) {
      state.settingsModal.draft = cloneSettingsDraft(state.settings);
    }
    return state.settingsModal.draft;
  }

  function cloneSettingsDraft(settings) {
    return {
      brand: settings.brand || '',
      defaultAccent: normalizeAccentArray(settings.defaultAccent),
      defaultTone: settings.defaultTone || firstToneId(),
      tonePresets: (settings.tonePresets || []).map((preset) => ({
        id: preset.id,
        name: preset.name,
        description: preset.description || '',
        promptSuffix: preset.promptSuffix || '',
      })),
      editingToneId: '',
    };
  }

  function toggleTonePresetEdit(toneId) {
    const draft = ensureSettingsDraft();
    draft.editingToneId = draft.editingToneId === toneId ? '' : toneId;
  }

  function addTonePresetDraft() {
    const draft = ensureSettingsDraft();
    const toneId = uniqueTonePresetId(draft.tonePresets);
    draft.tonePresets = draft.tonePresets.concat({
      id: toneId,
      name: '',
      description: '',
      promptSuffix: '',
    });
    draft.editingToneId = toneId;
  }

  function deleteTonePresetDraft(toneId) {
    const draft = ensureSettingsDraft();
    if (draft.tonePresets.length <= 1) {
      pushToast({
        kind: 'warning',
        message: '톤 프리셋은 최소 1개 이상 유지해야 합니다.',
      });
      return;
    }
    draft.tonePresets = draft.tonePresets.filter((preset) => preset.id !== toneId);
    if (draft.defaultTone === toneId) {
      draft.defaultTone = draft.tonePresets[0] ? draft.tonePresets[0].id : '';
    }
    if (draft.editingToneId === toneId) {
      draft.editingToneId = '';
    }
  }

  function setDefaultToneDraft(toneId) {
    const draft = ensureSettingsDraft();
    if (draft.tonePresets.some((preset) => preset.id === toneId)) {
      draft.defaultTone = toneId;
    }
  }

  function updateTonePresetDraft(toneId, patch) {
    const draft = ensureSettingsDraft();
    draft.tonePresets = draft.tonePresets.map((preset) => {
      if (preset.id !== toneId) {
        return preset;
      }
      return {
        ...preset,
        ...patch,
      };
    });
    if (draft.defaultTone === toneId && patch.id && patch.id !== toneId) {
      draft.defaultTone = patch.id;
    }
    if (draft.editingToneId === toneId && patch.id && patch.id !== toneId) {
      draft.editingToneId = patch.id;
    }
  }

  function uniqueTonePresetId(tonePresets) {
    const existing = new Set((tonePresets || []).map((preset) => preset.id));
    let index = 1;
    while (existing.has(`tone_${index}`)) {
      index += 1;
    }
    return `tone_${index}`;
  }

  function hasUnsafeSettingsFields(settings) {
    return Boolean(
      (settings.makeCardPath && settings.makeCardPath.trim()) ||
      (settings.exportPath && settings.exportPath.trim()) ||
      (settings.claudePath && settings.claudePath.trim()) ||
      customTonePresetSettings(settings)
    );
  }

  function customTonePresetSettings(settings) {
    const presets = settings.tonePresets || [];
    const defaultIds = ['magazine', 'newsletter', 'casual', 'provocative'];
    if (presets.length !== defaultIds.length) {
      return true;
    }
    if (settings.defaultTone && !defaultIds.includes(settings.defaultTone)) {
      return true;
    }
    return presets.some((preset, index) => preset.id !== defaultIds[index]);
  }

  function sortedPosts(posts) {
    return clone(posts).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  function hydratePost(post) {
    return clone(post);
  }

  function serializeSlides(slides) {
    return normalizeClientSlides(slides).map((slide, index) => {
      if (slide.type === 'body') {
        return {
          id: slide.id,
          type: slide.type,
          order: index,
          subtitle: slide.text.subtitle || '',
          paragraphs: slide.text.paragraphs || [],
          lineSpacing: Number.isFinite(slide.text.lineSpacing) ? slide.text.lineSpacing : null,
          source: slide.text.source || null,
          subtitleSize: Number.isFinite(slide.text.subtitleSize) ? slide.text.subtitleSize : null,
          bodySize: Number.isFinite(slide.text.bodySize) ? slide.text.bodySize : null,
          bodyPos: slide.text.bodyPos && Number.isFinite(slide.text.bodyPos.xPct) ? slide.text.bodyPos : null,
          overlays: Array.isArray(slide.text.overlays) ? slide.text.overlays : [],
          photo: slide.photo || null,
          imagePath: slide.imagePath || null,
          dirty: Boolean(slide.dirty),
        };
      }
      return {
        id: slide.id,
        type: slide.type,
        order: index,
        headline: slide.text.headline || '',
        kicker: slide.text.kicker || null,
        kickerBg: Number.isFinite(slide.text.kickerBg) ? slide.text.kickerBg : null,
        prebuilt: slide.text.prebuilt || null,
        closing: slide.text.closing || null,
        headlinePos: slide.text.headlinePos && Number.isFinite(slide.text.headlinePos.xPct) ? slide.text.headlinePos : null,
        overlays: Array.isArray(slide.text.overlays) ? slide.text.overlays : [],
        photo: slide.photo || null,
        imagePath: slide.imagePath || null,
        dirty: Boolean(slide.dirty),
      };
    });
  }

  function normalizeClientSlides(slides) {
    return clone(slides).map((slide, index, array) => {
      const normalized = {
        id: slide.id || makeId('slide'),
        type: slide.type || (index === 0 ? 'cover' : 'body'),
        order: index,
        photo: slide.photo || null,
        imagePath: slide.imagePath || null,
        dirty: Boolean(slide.dirty),
        overflow: Boolean(slide.overflow),
        text: {
          headline: slide.text && typeof slide.text.headline === 'string' ? slide.text.headline : '',
          kicker: slide.text && typeof slide.text.kicker === 'string' ? slide.text.kicker : null,
          kickerBg: slide.text && Number.isFinite(slide.text.kickerBg) ? slide.text.kickerBg : null,
          prebuilt: slide.text && typeof slide.text.prebuilt === 'string' ? slide.text.prebuilt : null,
          subtitle: slide.text && typeof slide.text.subtitle === 'string' ? slide.text.subtitle : '',
          paragraphs: slide.text && Array.isArray(slide.text.paragraphs) ? slide.text.paragraphs : [],
          closing: slide.text && typeof slide.text.closing === 'string' ? slide.text.closing : null,
          lineSpacing: slide.text && Number.isFinite(slide.text.lineSpacing) ? slide.text.lineSpacing : null,
          source: slide.text && typeof slide.text.source === 'string' ? slide.text.source : null,
          subtitleSize: slide.text && Number.isFinite(slide.text.subtitleSize) ? slide.text.subtitleSize : null,
          bodySize: slide.text && Number.isFinite(slide.text.bodySize) ? slide.text.bodySize : null,
          headlinePos: slide.text && slide.text.headlinePos && Number.isFinite(slide.text.headlinePos.xPct)
            ? { xPct: slide.text.headlinePos.xPct, yPct: slide.text.headlinePos.yPct }
            : null,
          bodyPos: slide.text && slide.text.bodyPos && Number.isFinite(slide.text.bodyPos.xPct)
            ? { xPct: slide.text.bodyPos.xPct, yPct: slide.text.bodyPos.yPct }
            : null,
          overlays: slide.text && Array.isArray(slide.text.overlays)
            ? slide.text.overlays.map((o) => ({ ...o }))
            : [],
        },
      };
      if (index === 0) {
        normalized.type = 'cover';
      } else if (index === array.length - 1 && array.length > 2 && slide.type === 'ending') {
        normalized.type = 'ending';
      }
      if (normalized.type === 'ending' && !normalized.text.headline) {
        normalized.text.headline = normalized.text.closing || '';
      }
      if (normalized.type === 'cover') {
        if (!normalized.text.headline && normalized.text.subtitle) {
          normalized.text.headline = normalized.text.subtitle;
        }
      }
      if (normalized.type === 'body') {
        normalized.text.headline = null;
        normalized.text.kicker = null;
        normalized.text.closing = null;
      }
      return normalized;
    });
  }

  function makeLocalSlide(type) {
    return {
      id: makeId('slide'),
      type,
      order: 0,
      photo: null,
      imagePath: null,
      dirty: true,
      overflow: false,
      text: type === 'body'
        ? {
            headline: null,
            kicker: null,
            subtitle: '',
            paragraphs: [''],
            closing: null,
          }
        : {
            headline: '',
            kicker: null,
            subtitle: null,
            paragraphs: [],
            closing: type === 'ending' ? '' : null,
          },
    };
  }

  function findSlide(post, slideId) {
    return post && post.slides ? post.slides.find((slide) => slide.id === slideId) : null;
  }

  function getSelectedSlide() {
    return findSlide(state.currentPost, state.editor.selectedSlideId);
  }

  // === 텍스트 오버레이 (자유 추가 + 드래그 배치) ===
  function getSlideOverlays(slide) {
    return slide && slide.text && Array.isArray(slide.text.overlays) ? slide.text.overlays : [];
  }

  function addOverlay() {
    const slide = getSelectedSlide();
    if (!slide) {
      return;
    }
    const id = makeId('ov');
    const existing = getSlideOverlays(slide);
    // 새 텍스트는 계단식으로 내려 배치 — 여러 개 추가해도 정중앙에 포개지지 않게
    const yPct = Math.min(0.82, 0.30 + (existing.length % 6) * 0.09);
    const overlays = [...existing, {
      id, text: '텍스트', xPct: 0.5, yPct, size: 56, color: '#ffffff', weight: 'bold',
    }];
    state.editor.selectedOverlayId = id;
    state.editor.pendingFocusId = 'overlay-text';
    updateSelectedSlideText({ overlays }, slide.id);
  }

  function updateOverlay(overlayId, patch, options = {}) {
    const slide = getSelectedSlide();
    if (!slide) {
      return;
    }
    const overlays = getSlideOverlays(slide).map((o) => (o.id === overlayId ? { ...o, ...patch } : o));
    updateSelectedSlideText({ overlays }, slide.id, options);
  }

  function deleteOverlay(overlayId) {
    const slide = getSelectedSlide();
    if (!slide) {
      return;
    }
    const overlays = getSlideOverlays(slide).filter((o) => o.id !== overlayId);
    if (state.editor.selectedOverlayId === overlayId) {
      state.editor.selectedOverlayId = '';
    }
    updateSelectedSlideText({ overlays }, slide.id);
    liveRenderSelectedSlide();
  }

  let overlayDrag = null;

  function onOverlayPointerDown(event) {
    const el = event.target.closest('.overlay-text');
    if (!el) {
      return;
    }
    // 삭제 버튼 클릭은 드래그가 아니라 onClick에 맡긴다
    if (event.target.closest('.overlay-text__del')) {
      return;
    }
    const card = el.closest('.preview-card');
    if (!card) {
      return;
    }
    const nativeField = el.dataset.nativeField || '';
    const isNative = Boolean(nativeField);
    const rect = card.getBoundingClientRect();
    // 그랩 오프셋: 잡은 지점과 요소 앵커(현재 left/top %)의 차 → 드래그 시 커서로 점프하지 않음
    const curX = (parseFloat(el.style.left) || 0) / 100;
    const curY = (parseFloat(el.style.top) || 0) / 100;
    const pointerX = (event.clientX - rect.left) / rect.width;
    const pointerY = (event.clientY - rect.top) / rect.height;
    let selectionChanged = false;
    if (isNative) {
      el.classList.add('is-dragging');
    } else {
      // 선택 갱신은 DOM 클래스만 직접 토글 (드래그 중 renderApp=DOM 재구성으로 캡처 엘리먼트 detach 방지).
      const overlayId = el.dataset.overlayId;
      selectionChanged = state.editor.selectedOverlayId !== overlayId;
      state.editor.selectedOverlayId = overlayId;
      if (selectionChanged) {
        card.querySelectorAll('.overlay-text.is-selected').forEach((n) => n.classList.remove('is-selected'));
        el.classList.add('is-selected');
      }
    }
    overlayDrag = {
      el,
      isNative,
      nativeField,
      overlayId: el.dataset.overlayId || '',
      rect,
      offsetX: pointerX - curX,
      offsetY: pointerY - curY,
      moved: false,
      selectionChanged,
    };
    try { el.setPointerCapture(event.pointerId); } catch (_) {}
    event.preventDefault();
    document.addEventListener('pointermove', onOverlayPointerMove);
    document.addEventListener('pointerup', onOverlayPointerUp);
    document.addEventListener('pointercancel', onOverlayPointerUp);
  }

  function onOverlayPointerMove(event) {
    if (!overlayDrag) {
      return;
    }
    const { rect, el, offsetX, offsetY } = overlayDrag;
    const xPct = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width - offsetX));
    const yPct = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height - offsetY));
    overlayDrag.xPct = xPct;
    overlayDrag.yPct = yPct;
    overlayDrag.moved = true;
    // 드래그 중에는 리렌더 없이 DOM만 직접 갱신(부드럽게)
    if (el && el.isConnected) {
      el.style.left = `${(xPct * 100).toFixed(3)}%`;
      el.style.top = `${(yPct * 100).toFixed(3)}%`;
      el.classList.add('is-dragging');
    }
  }

  function onOverlayPointerUp() {
    document.removeEventListener('pointermove', onOverlayPointerMove);
    document.removeEventListener('pointerup', onOverlayPointerUp);
    document.removeEventListener('pointercancel', onOverlayPointerUp);
    if (!overlayDrag) {
      return;
    }
    const drag = overlayDrag;
    overlayDrag = null;
    if (drag.isNative) {
      if (drag.moved && Number.isFinite(drag.xPct)) {
        const slide = getSelectedSlide();
        if (slide) {
          updateSelectedSlideText({ [drag.nativeField]: { xPct: drag.xPct, yPct: drag.yPct } }, slide.id, { silent: true });
          renderApp({ preserveFocus: true });
          liveRenderSelectedSlide();
        }
      }
      return;
    }
    if (drag.moved && Number.isFinite(drag.xPct)) {
      updateOverlay(drag.overlayId, { xPct: drag.xPct, yPct: drag.yPct }, { silent: true });
      renderApp({ preserveFocus: true });
      liveRenderSelectedSlide();
    } else if (drag.selectionChanged) {
      // 단순 선택(이동 없음): 패널에 선택 텍스트 컨트롤을 띄우기 위해 한 번 렌더
      renderApp({ preserveFocus: true });
    }
  }

  function splitParagraphBlocks(value) {
    return String(value || '')
      .split(/\n{2,}/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function joinParagraphBlocks(values) {
    return (values || []).join('\n\n');
  }

  function slideCounter(slide) {
    if (slide.type === 'body') {
      return (slide.text.subtitle || '').length + (slide.text.paragraphs || []).join('').length;
    }
    return (slide.text.headline || '').length + (slide.text.kicker || '').length;
  }

  function slideOverflowHint(slide) {
    const count = slideCounter(slide);
    if (slide.type === 'cover' && count > 44) {
      return '약 44자 초과 시 잘릴 수 있습니다';
    }
    if (slide.type === 'body' && count > 150) {
      return '약 150자 초과 시 잘릴 수 있습니다';
    }
    if (slide.type === 'ending' && count > 32) {
      return '약 32자 초과 시 잘릴 수 있습니다';
    }
    return '';
  }

  function firstAvailablePhoto(post) {
    const selected = post.imageCandidates.find((item) => item.selected && item.localPath);
    if (selected) {
      return selected.localPath;
    }
    const first = post.imageCandidates.find((item) => item.localPath);
    return first ? first.localPath : null;
  }

  function joinCaptionAndHashtags(caption, hashtags) {
    const cap = (caption || '').trim();
    const tags = (hashtags || '').trim();
    if (cap && tags) {
      return `${cap}\n\n${tags}`;
    }
    return cap || tags || '';
  }

  function indexById(items) {
    return (items || []).reduce((accumulator, item) => {
      accumulator[item.id] = item;
      return accumulator;
    }, {});
  }

  function filterSources(sources) {
    return sortedSources(sources).filter((source) => {
      const query = state.sourcesView.query.trim().toLowerCase();
      const tag = state.sourcesView.tag;
      if (query) {
        const haystack = [source.name, source.domain, source.notes, source.addedFrom]
          .concat(source.topics || [])
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(query)) {
          return false;
        }
      }
      if (tag && !(source.topics || []).includes(tag)) {
        return false;
      }
      return true;
    });
  }

  function sortedSources(sources) {
    return clone(sources).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  function replaceSource(source) {
    state.sources = state.sources.map((item) => item.id === source.id ? source : item);
  }

  function createEmptyAnglePanelState() {
    return {
      open: false,
      loading: false,
      error: '',
      angles: [],
      requestCount: 0,
      rerollOpen: false,
      selectedHints: [],
      previousTitles: [],
      manualOpen: false,
      manualTitle: '',
      manualHook: '',
      direction: '',
      creating: false,
    };
  }

  function findExistingUrlPost(input) {
    const value = String(input || '').trim();
    if (!value) {
      return null;
    }
    return sortedPosts(state.posts).find((post) => post.inputType === 'url' && String(post.input || '').trim() === value) || null;
  }

  function highlightDashboardPost(postId) {
    state.dashboard.highlightPostId = postId;
    if (highlightDashboardPost.timer) {
      window.clearTimeout(highlightDashboardPost.timer);
    }
    highlightDashboardPost.timer = window.setTimeout(() => {
      if (state.dashboard.highlightPostId === postId) {
        state.dashboard.highlightPostId = '';
        renderApp();
      }
    }, 6000);
  }

  function verifyWarningCount(post) {
    return Array.isArray(post && post.slides)
      ? post.slides.filter((slide) => slide.verifyFailed).length
      : 0;
  }

  function focusIdForSlide(slide) {
    if (!slide) {
      return '';
    }
    if (slide.type === 'cover') {
      return 'cover-headline';
    }
    if (slide.type === 'ending') {
      return 'ending-headline';
    }
    return 'body-subtitle';
  }

  function toggleEvidence(slideId) {
    if (!slideId) {
      return;
    }
    state.editor.evidenceExpanded[slideId] = !state.editor.evidenceExpanded[slideId];
  }

  function slideIndexFor(post, slide) {
    if (!post || !slide || !Array.isArray(post.slides)) {
      return -1;
    }
    return post.slides.findIndex((item) => item.id === slide.id);
  }

  function outlineItemForSlide(post, slide) {
    const slideIndex = slideIndexFor(post, slide);
    if (slideIndex === -1 || !Array.isArray(post && post.outline)) {
      return null;
    }
    return post.outline.find((item) => item.slideIndex === slideIndex) || post.outline[slideIndex] || null;
  }

  function verifyResultForSlide(post, slide) {
    const slideIndex = slideIndexFor(post, slide);
    if (slideIndex === -1 || !post || !post.verify || !Array.isArray(post.verify.results)) {
      return null;
    }
    return post.verify.results.find((item) => item.slideIndex === slideIndex) || null;
  }

  function renderVerifyFailureCard(post, slide) {
    const result = verifyResultForSlide(post, slide);
    const issues = result && Array.isArray(result.issues) && result.issues.length
      ? result.issues
      : ['검수에서 수정이 필요하다고 판단했습니다'];
    return `
      <div class="verify-alert">
        <div class="verify-alert__header">
          <span class="badge badge--error">⚠️ 검수 실패</span>
        </div>
        <ul class="verify-alert__issues">
          ${issues.map((issue) => `<li>${h(issue)}</li>`).join('')}
        </ul>
        <div class="verify-alert__actions">
          <button class="button button--small button--ghost" data-action="focus-slide-edit" data-slide-id="${attr(slide.id)}">✏️ 직접 수정</button>
          <button class="button button--small button--ghost" data-action="exclude-slide" data-slide-id="${attr(slide.id)}">🗑 이 슬라이드 제외</button>
        </div>
      </div>
    `;
  }

  function slideEvidenceItems(post, slide) {
    if (!post || !post.angle) {
      return [];
    }
    const outlineItem = outlineItemForSlide(post, slide);
    const itemRefs = Array.isArray(outlineItem && outlineItem.itemRefs) ? outlineItem.itemRefs : [];
    if (!itemRefs.length || !Array.isArray(post.traceItems)) {
      return [];
    }
    const byRef = new Map(post.traceItems.map((item) => [item.ref, item]));
    return itemRefs.map((ref) => byRef.get(ref)).filter(Boolean);
  }

  function renderEvidenceList(items) {
    if (!items.length) {
      return `<div class="help-inline">이 슬라이드에 연결된 근거가 없습니다.</div>`;
    }
    return `
      <div class="evidence-list">
        ${items.map((item) => `
          <a class="evidence-chip" href="${attr(item.origin && item.origin.url ? item.origin.url : '#')}" ${item.origin && item.origin.url ? 'target="_blank" rel="noopener"' : ''}>
            <span>${h(evidenceKindIcon(item.kind))}</span>
            <span>${h(item.origin && item.origin.name ? item.origin.name : '원본 미확인')}</span>
            <span class="evidence-chip__dot ${evidenceConfidenceClass(item)}"></span>
          </a>
        `).join('')}
      </div>
    `;
  }

  function evidenceKindIcon(kind) {
    if (kind === 'image') {
      return '🖼';
    }
    if (kind === 'video') {
      return '🎥';
    }
    if (kind === 'data') {
      return '📊';
    }
    return '💬';
  }

  function evidenceConfidenceClass(item) {
    const confidence = traceItemConfidence(item);
    if (confidence >= 0.85) {
      return 'is-high';
    }
    if (confidence >= 0.7) {
      return 'is-mid';
    }
    return 'is-low';
  }

  function traceItemConfidence(item) {
    return Number(item && item.origin && item.origin.confidence) || 0;
  }

  function angleToneMeta(tone) {
    if (tone === 'fact') {
      return { label: '📊 팩트형', className: 'badge--accent' };
    }
    if (tone === 'behind') {
      return { label: '🎬 비하인드형', className: 'badge--warning' };
    }
    return { label: '💬 공감형', className: 'badge--purple' };
  }

  function captureFocus() {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
      return null;
    }
    return {
      id: active.dataset.focusId || '',
      start: active.selectionStart,
      end: active.selectionEnd,
    };
  }

  function restoreFocus(snapshot) {
    if (!snapshot || !snapshot.id) {
      return;
    }
    const next = document.querySelector(`[data-focus-id="${CSS.escape(snapshot.id)}"]`);
    if (!(next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) {
      return;
    }
    next.focus();
    if (typeof snapshot.start === 'number' && typeof snapshot.end === 'number') {
      next.setSelectionRange(snapshot.start, snapshot.end);
    }
  }

  function statusBadge(status) {
    if (status === 'done') {
      return { label: '완성', className: 'badge--accent' };
    }
    if (status === 'published') {
      return { label: '발행됨', className: 'badge--success' };
    }
    if (status === 'error') {
      return { label: '오류', className: 'badge--error' };
    }
    if (status === 'verifying') {
      return { label: '검수 중', className: 'badge--warning' };
    }
    if (GENERATING_STATUSES.has(status)) {
      return { label: STAGE_LABELS[status], className: 'badge--warning' };
    }
    return { label: '초안', className: 'badge--draft' };
  }

  function statusPill(post) {
    const meta = statusBadge(post.status);
    return `<span class="badge ${meta.className}">${h(meta.label)}</span>`;
  }

  function fallbackTitle(post) {
    return post.inputType === 'url' ? '새 URL 포스트' : (post.input || '새 포스트').slice(0, 40);
  }

  function formatDate(value) {
    if (!value) {
      return '';
    }
    const date = new Date(value);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  function formatElapsed(value) {
    const diff = Math.max(0, Date.now() - new Date(value).getTime());
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes > 0) {
      return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
    }
    return `${seconds}s`;
  }

  function sendDesktopNotification(title, body) {
    if (!('Notification' in window)) {
      return;
    }
    if (Notification.permission !== 'granted') {
      return;
    }
    try {
      new Notification(title, { body });
    } catch (error) {
      console.error(error);
    }
  }

  function safeDomain(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, '');
    } catch (error) {
      return '';
    }
  }

  function firstToneId() {
    return state.settings && state.settings.tonePresets && state.settings.tonePresets[0]
      ? state.settings.tonePresets[0].id
      : 'magazine';
  }

  function formatMarkedText(text) {
    return h(String(text || ''))
      .replace(/\[([^\]]+)\]/g, '<mark>$1</mark>')
      .replace(/_([^_]+)_/g, '<u>$1</u>')
      .replace(/\n/g, '<br />');
  }

  function linesFromText(text, lineCount, lineWidth) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) {
      return [];
    }
    const words = clean.split(' ');
    const lines = [];
    let current = '';
    while (words.length && lines.length < lineCount) {
      const word = words.shift();
      if ((current + ' ' + word).trim().length <= lineWidth) {
        current = (current + ' ' + word).trim();
      } else {
        if (current) {
          lines.push(current);
        }
        current = word;
      }
    }
    if (current && lines.length < lineCount) {
      lines.push(current);
    }
    return lines;
  }

  function toAssetPath(postId, localPath) {
    return `/data/posts/${postId}/${localPath}`;
  }

  function withCacheBust(pathname, version) {
    const stamp = version ? new Date(version).getTime() : Date.now();
    return `${pathname}${pathname.includes('?') ? '&' : '?'}t=${stamp}`;
  }

  function makeId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  }

  function rgbText(rgb) {
    return normalizeAccentArray(rgb).join(',');
  }

  function parseRgbText(value) {
    return value.split(',').map((item) => Number(item));
  }

  function rgbCss(rgb) {
    const next = normalizeAccentArray(rgb);
    return `rgb(${next[0]}, ${next[1]}, ${next[2]})`;
  }

  function normalizeAccentArray(value) {
    return Array.isArray(value) ? value.map((item) => Number(item) || 0).slice(0, 3) : [59, 130, 246];
  }

  function splitTags(value) {
    return uniq(String(value || '').split(',').map((item) => item.trim()).filter(Boolean));
  }

  function uniq(values) {
    return Array.from(new Set(values));
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function h(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function attr(value) {
    return h(value);
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
})();
