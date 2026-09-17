'use strict';

const obsidian = require('obsidian');
const Plugin = obsidian.Plugin;
const PluginSettingTab = obsidian.PluginSettingTab;
const Setting = obsidian.Setting;
const Notice = obsidian.Notice;
const TFile = obsidian.TFile;
const MarkdownView = obsidian.MarkdownView;
const requestUrl = obsidian.requestUrl;
const normalizePath = obsidian.normalizePath;
const moment = obsidian.moment || (typeof window !== 'undefined' ? window.moment : null);

const DEFAULT_SETTINGS = {
  folder: '剪贴板',
  nameFormat: 'YYYY-MM-DD HH-mm',
  appendToToday: true,
  aiPluginId: 'ai-note-summary',
  summaryPrompt: '把下面这段内容整理成简洁、准确的中文要点总结，保留关键信息与数字，不编造、不扩写。',
  saveOriginal: true,
  imageFolder: '剪贴板/附件',
  imageHint: '把复制的图片粘贴到这一节',
  // 视觉模型：先识别图片成文字，再交给主模型（DeepSeek）总结
  visionEnabled: false,
  visionApiUrl: '',
  visionApiKey: '',
  visionModel: '',
  visionPrompt: '请描述这张图片的内容，尽量提取图中的文字和关键信息，用中文输出。',
  visionMaxImages: 6,
  visionMaxSide: 1568,
  primaryAction: 'clipboard',
  chunkEnabled: true,
  chunkThreshold: 12000,
  cleanupAfterSummary: false,
};

function pad(n) {
  return String(n).length < 2 ? '0' + n : String(n);
}

function formatDate(d, fmt) {
  if (moment) return moment(d).format(fmt);
  return String(fmt)
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/DD/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()));
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const bin = atob(String(b64).replace(/[\s]/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 靠文件头判断是不是图片，避免把普通文字误当成 base64
function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 12) return '';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'image/heic';
  return '';
}

// 有些应用"复制图片"时，剪贴板的文字里其实是 data URL / 裸 base64。
// 这里把它抠出来当图片处理，绝不把 base64 当正文发给模型。
function extractImagesFromText(raw) {
  let text = String(raw == null ? '' : raw);
  const images = [];
  const spans = [];

  const re = /data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+(?:\r?\n[A-Za-z0-9+/=]+)*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      const bytes = base64ToBytes(m[2]);
      const mime = sniffImageMime(bytes) || m[1];
      images.push({ mime: mime, bytes: bytes });
      spans.push([m.index, m.index + m[0].length]);
    } catch (e) {
      // 解不开就当作普通文字
    }
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    text = text.slice(0, spans[i][0]) + ' ' + text.slice(spans[i][1]);
  }
  text = text.trim();

  // 整段就是裸 base64（没有 data: 前缀）时，用文件头确认它确实是图片
  if (text.length > 200 && /^[A-Za-z0-9+/\r\n]+={0,2}$/.test(text)) {
    try {
      const bytes = base64ToBytes(text);
      const mime = sniffImageMime(bytes);
      if (mime) {
        images.push({ mime: mime, bytes: bytes });
        text = '';
      }
    } catch (e) {
      // 忽略
    }
  }

  return { text: text, images: images };
}

const SECTION_ORDER = ['## 🤖 AI 总结', '## 🖼️ 图片', '## 📄 原文'];

function stripFrontmatter(text) {
  return String(text == null ? '' : text).replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

// 从笔记正文里找出图片引用，正文里把它们替换成（图N），方便 AI 对上号
function extractNoteImageRefs(content) {
  let text = stripFrontmatter(content);
  const refs = [];
  const IMG = /\.(png|jpe?g|gif|webp|heic|heif|bmp|avif)$/i;

  text = text.replace(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, function (m, target, alias) {
    const t = String(target).trim();
    if (!IMG.test(t)) return m;
    refs.push({ target: t, alt: String(alias || '').trim() });
    return '（图' + refs.length + '）';
  });

  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (m, alt, target) {
    const raw = String(target).split('|')[0].split('#')[0].split('?')[0].trim();
    if (!IMG.test(raw)) return m;
    let t = raw;
    try { t = decodeURIComponent(raw); } catch (e) { /* 保持原样 */ }
    refs.push({ target: t, alt: String(alt || '').trim() });
    return '（图' + refs.length + '）';
  });

  return { text: text.trim(), refs: refs };
}

// 按空行切段，段落过长再硬切；用于长文本分段总结
function splitText(text, size) {
  const out = [];
  let buf = '';
  String(text == null ? '' : text).split(/\n{2,}/).forEach(function (p) {
    if (!p) return;
    if (p.length > size) {
      if (buf) { out.push(buf); buf = ''; }
      for (let i = 0; i < p.length; i += size) out.push(p.slice(i, i + size));
      return;
    }
    if (buf && buf.length + p.length + 2 > size) { out.push(buf); buf = ''; }
    buf = buf ? buf + '\n\n' + p : p;
  });
  if (buf) out.push(buf);
  return out;
}

// 把指定图片的引用从笔记里去掉（避免删了文件留下断链）
function stripImageEmbeds(content, paths) {
  const wanted = new Set();
  (paths || []).forEach(function (p) {
    const clean = String(p).replace(/\\/g, '/');
    wanted.add(clean);
    wanted.add(clean.replace(/\.md$/i, ''));
    wanted.add(clean.split('/').pop());
  });
  if (!wanted.size) return String(content == null ? '' : content);

  return String(content == null ? '' : content)
    .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\n?/g, function (m, target) {
      const t = String(target).trim().replace(/\\/g, '/');
      if (wanted.has(t) || wanted.has(t.split('/').pop())) return '';
      return m;
    })
    .replace(/\n{3,}/g, '\n\n');
}

// 把 lines 追加到指定小节末尾；找不到该节就在文末补一节。
// 只按「已知的小节标题」判断边界，所以正文里出现 ## 之类的标题也不会干扰。
function appendToSection(content, title, lines) {
  const all = String(content || '').split('\n');
  let start = -1;
  for (let i = 0; i < all.length; i++) {
    if (all[i].trim() === title) { start = i; break; }
  }

  if (start === -1) {
    const base = String(content || '').replace(/\s*$/, '');
    return base + '\n\n' + title + '\n' + lines.join('\n') + '\n';
  }

  const idx = SECTION_ORDER.indexOf(title);
  const nextTitles = idx >= 0 ? SECTION_ORDER.slice(idx + 1) : [];
  let end = all.length;
  for (let i = start + 1; i < all.length; i++) {
    if (nextTitles.indexOf(all[i].trim()) >= 0) { end = i; break; }
  }
  let insertAt = end;
  while (insertAt - 1 > start && all[insertAt - 1].trim() === '') insertAt--;

  const next = all.slice();
  next.splice(insertAt, 0, ...lines);
  return next.join('\n');
}

class ClipboardSummaryPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.addRibbonIcon('clipboard-pen', '生成 AI 总结笔记', this.run.bind(this));

    this.addCommand({
      id: 'clipboard-to-note',
      name: '剪贴板生成 AI 总结笔记',
      callback: () => this.runSource('clipboard'),
    });

    this.addCommand({
      id: 'active-note-to-summary',
      name: '当前笔记生成 AI 总结（含笔记里的图片）',
      callback: () => this.runSource('activeNote'),
    });

    this.addCommand({
      id: 'cleanup-last-images',
      name: '清除最近一次总结用到的图片',
      callback: () => this.cleanupLast(),
    });

    // 手机桌面图标 / 快捷指令可以直接用这个地址，无需打开命令面板
    this.registerObsidianProtocolHandler('clipboard', this.run.bind(this));

    this.addSettingTab(new ClipboardSummarySettingTab(this.app, this));
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async run() {
    const source = String(this.settings.primaryAction || 'clipboard') === 'activeNote' ? 'activeNote' : 'clipboard';
    return await this.runSource(source);
  }

  async runSource(source) {
    if (this._running) return;
    this._running = true;
    try {
      await this.createFromSource(source);
    } catch (e) {
      console.error('[clipboard-summary]', e);
      new Notice('生成失败：' + (e && e.message ? e.message : e));
    } finally {
      this._running = false;
    }
  }

  // ----- 读剪贴板（能读到多少算多少）-----

  async readClipboardText() {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        return String((await navigator.clipboard.readText()) || '').trim();
      }
    } catch (e) {
      // 手机系统可能禁止后台读取剪贴板
    }
    return '';
  }

  async readClipboardImages() {
    const out = [];
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.read === 'function') {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const types = item.types || [];
          for (const type of types) {
            if (type.indexOf('image/') === 0) {
              const blob = await item.getType(type);
              const bytes = new Uint8Array(await blob.arrayBuffer());
              out.push({ mime: type, bytes: bytes });
            }
          }
        }
      }
    } catch (e) {
      // 读不到图片就算了，下面会留一个手动粘贴的位置
    }
    return out;
  }

  // ----- 当前笔记作为输入源 -----

  mimeForPath(p) {
    const ext = String(p || '').split('.').pop().toLowerCase();
    const map = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
      gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', avif: 'image/avif',
    };
    return map[ext] || 'image/png';
  }

  resolveImageFile(linkpath, sourcePath) {
    try {
      const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
      if (dest instanceof TFile) return dest;
    } catch (e) {
      // 交给下面的兜底
    }
    const direct = this.app.vault.getAbstractFileByPath(normalizePath(linkpath));
    return direct instanceof TFile ? direct : null;
  }

  async readActiveNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') return null;
    const raw = await this.app.vault.cachedRead(file);
    const parsed = extractNoteImageRefs(raw);
    const images = [];
    for (const ref of parsed.refs) {
      const img = this.resolveImageFile(ref.target, file.path);
      if (!img) continue;
      try {
        const buf = await this.app.vault.readBinary(img);
        images.push({ mime: this.mimeForPath(img.path), bytes: new Uint8Array(buf), name: img.name, path: img.path });
      } catch (e) {
        // 读不出来就跳过这张
      }
    }
    return { file: file, text: parsed.text, images: images };
  }

  extFor(mime) {
    const map = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/heic': 'heic',
      'image/heif': 'heif',
    };
    return map[mime] || 'png';
  }

  // ----- 文件工具 -----

  async ensureFolder(folder) {
    const parts = normalizePath(folder).split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur = cur ? cur + '/' + part : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch (e) {
          // 并发创建 / 已存在
        }
      }
    }
  }

  async saveImages(images) {
    if (!images.length) return [];
    const folder = String(this.settings.imageFolder || '').trim().replace(/^\/+|\/+$/g, '') || '附件';
    await this.ensureFolder(folder);
    const stamp = formatDate(new Date(), 'YYYY-MM-DD HH-mm-ss');
    const paths = [];
    for (let i = 0; i < images.length; i++) {
      const base = images.length > 1 ? stamp + ' ' + (i + 1) : stamp;
      let p = normalizePath(folder + '/' + base + '.' + this.extFor(images[i].mime));
      let j = 1;
      while (this.app.vault.getAbstractFileByPath(p)) {
        p = normalizePath(folder + '/' + base + ' ' + j + '.' + this.extFor(images[i].mime));
        j++;
      }
      await this.app.vault.createBinary(p, images[i].bytes);
      paths.push(p);
    }
    return paths;
  }

  async uniqueNotePath(folder, base) {
    let p = normalizePath(folder ? folder + '/' + base + '.md' : base + '.md');
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(p)) {
      p = normalizePath(folder ? folder + '/' + base + ' ' + i + '.md' : base + ' ' + i + '.md');
      i++;
    }
    return p;
  }

  // ----- 调「AI 笔记总结」插件（不改动它）-----

  aiPlugin() {
    const id = String(this.settings.aiPluginId || '').trim();
    if (!id) return null;
    let other = null;
    try {
      const pm = this.app.plugins;
      if (pm) {
        if (typeof pm.getPlugin === 'function') other = pm.getPlugin(id);
        if (!other && pm.plugins) other = pm.plugins[id];
      }
    } catch (e) {
      other = null;
    }
    return other;
  }

  // 一张图一个请求：多图时不会因为请求体过大或模型只收单图而整批失败
  async describeImages(images) {
    const maxImages = Math.max(1, Math.min(20, Number(this.settings.visionMaxImages) || 6));
    const list = images.slice(0, maxImages);
    const parts = [];
    const errors = [];
    for (let i = 0; i < list.length; i++) {
      try {
        const desc = await this.describeOne(list[i]);
        if (desc) parts.push('第 ' + (i + 1) + ' 张图：\n' + desc);
      } catch (e) {
        errors.push('第 ' + (i + 1) + ' 张：' + (e && e.message ? e.message : String(e)));
      }
    }
    this._visionPartial = errors;
    if (!parts.length) {
      throw new Error(errors.length ? errors.join('；') : '没有可识别的图片');
    }
    return parts.join('\n\n');
  }

  async describeOne(img) {
    const url = String(this.settings.visionApiUrl || '').trim();
    const key = String(this.settings.visionApiKey || '').trim();
    const model = String(this.settings.visionModel || '').trim();
    if (!url || !key || !model) throw new Error('视觉模型没配全（地址 / Key / 模型）');
    if (url.indexOf('/chat/completions') < 0) {
      throw new Error('视觉模型地址要填 API 接口地址（一般以 /chat/completions 结尾），不能填网站首页或密钥管理页');
    }

    const small = await this.compressImage(img);
    const content = [
      { type: 'text', text: this.settings.visionPrompt || '请描述这张图片的内容。' },
      { type: 'image_url', image_url: { url: 'data:' + small.mime + ';base64,' + bytesToBase64(small.bytes) } },
    ];

    let response;
    try {
      response = await requestUrl({
        url: url,
        method: 'POST',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: content }],
          temperature: 0.2,
          stream: false,
        }),
        throw: false,
      });
    } catch (e) {
      throw new Error('请求发不出去（' + (e && e.message ? e.message : String(e)) + '）');
    }

    if (!response || response.status < 200 || response.status >= 300) {
      throw new Error('HTTP ' + (response ? response.status : '?') + this.responseDetail(response));
    }
    const data = response.json;
    const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof out !== 'string' || !out.trim()) {
      throw new Error('返回里没有文字' + this.responseDetail(response));
    }
    return out.trim();
  }

  // 从接口返回里抠出一小段可读的错误信息，方便定位问题
  responseDetail(response) {
    if (!response) return '';
    let detail = '';
    try {
      detail = response.json ? JSON.stringify(response.json) : String(response.text || '');
    } catch (e) {
      detail = '';
    }
    detail = String(detail).replace(/\s+/g, ' ').slice(0, 200);
    return detail ? '：' + detail : '';
  }

  // 发一条最小请求，验证地址 / Key / 模型名是否正确
  async testVision() {
    const url = String(this.settings.visionApiUrl || '').trim();
    const key = String(this.settings.visionApiKey || '').trim();
    const model = String(this.settings.visionModel || '').trim();
    if (!url || !key || !model) {
      new Notice('先把视觉模型的地址、Key、模型名都填上');
      return;
    }
    if (url.indexOf('/chat/completions') < 0) {
      new Notice('地址看着不对：应该填 API 接口地址（以 /chat/completions 结尾），不是网页', 10000);
      return;
    }
    new Notice('正在测试视觉模型…', 3000);
    try {
      const response = await requestUrl({
        url: url,
        method: 'POST',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: '你好，请只回复 ok' }],
          stream: false,
        }),
        throw: false,
      });
      if (response && response.status >= 200 && response.status < 300) {
        const out = response.json && response.json.choices && response.json.choices[0] &&
          response.json.choices[0].message && response.json.choices[0].message.content;
        new Notice('视觉模型连通 ✅ ' + (out ? String(out).slice(0, 40) : ''), 8000);
      } else {
        new Notice('视觉模型返回 HTTP ' + (response ? response.status : '?') + this.responseDetail(response), 12000);
      }
    } catch (e) {
      new Notice('请求发不出去：' + (e && e.message ? e.message : String(e)), 12000);
    }
  }

  // 发图前压缩：手机截图动辄 2MB，缩到长边 1568 + JPEG 后通常只有几百 KB
  async compressImage(img) {
    const maxSide = Math.max(320, Math.min(4096, Number(this.settings.visionMaxSide) || 1568));
    if (typeof document === 'undefined' || typeof Image === 'undefined') return img;
    let url = '';
    try {
      const blob = new Blob([img.bytes], { type: img.mime });
      url = URL.createObjectURL(blob);
      const el = await new Promise(function (resolve, reject) {
        const i = new Image();
        i.onload = function () { resolve(i); };
        i.onerror = function () { reject(new Error('图片解码失败')); };
        i.src = url;
      });
      const w = el.naturalWidth || el.width;
      const h = el.naturalHeight || el.height;
      const scale = Math.min(1, maxSide / Math.max(w, h));
      if (scale >= 1 && img.bytes.length < 400 * 1024) {
        URL.revokeObjectURL(url);
        return img;
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
      const outBlob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.85); });
      URL.revokeObjectURL(url);
      if (!outBlob) return img;
      const buf = new Uint8Array(await outBlob.arrayBuffer());
      return { mime: 'image/jpeg', bytes: buf };
    } catch (e) {
      if (url) { try { URL.revokeObjectURL(url); } catch (e2) { /* 忽略 */ } }
      return img;
    }
  }

  async summarize(text, images) {
    let payload = String(text || '').trim();
    this._visionError = '';
    this._visionPartial = [];

    if (this.settings.visionEnabled && images && images.length) {
      try {
        const imageText = await this.describeImages(images);
        payload = (payload ? payload + '\n\n' : '') + '以下是从图片中识别到的内容：\n' + imageText;
      } catch (e) {
        this._visionError = e && e.message ? e.message : String(e);
      }
    }
    if (!payload) throw new Error('没有可总结的内容');

    return await this.summarizePayload(payload);
  }

  // 交给主模型（AI 笔记总结插件）出总结
  async callPrimary(payload) {
    const other = this.aiPlugin();
    const api = other && other.api;
    if (api && typeof api.summarizeText === 'function') {
      return await api.summarizeText(payload, { systemPrompt: this.settings.summaryPrompt });
    }
    if (other && typeof other.callAI === 'function' && other.settings) {
      const s = other.settings;
      if (!(s.apiUrl && s.apiKey && s.model)) throw new Error('「AI 笔记总结」还没配置 API Key');
      const maxChars = Number(s.maxChars) || 0;
      const toSend = maxChars > 0 && payload.length > maxChars
        ? payload.slice(0, maxChars) + '\n\n…（内容过长，已截断）'
        : payload;
      const summary = await other.callAI('剪贴板内容', toSend, {
        apiUrl: s.apiUrl,
        apiKey: s.apiKey,
        model: s.model,
        systemPrompt: this.settings.summaryPrompt || s.systemPrompt,
      });
      if (!summary) throw new Error('AI 没有返回内容');
      return summary;
    }
    throw new Error('找不到可用的「AI 笔记总结」插件');
  }

  // 长文本：先分段各自总结，再合并成一份，避免被静默截断
  async summarizePayload(payload) {
    const enabled = this.settings.chunkEnabled !== false;
    const threshold = Math.max(2000, Number(this.settings.chunkThreshold) || 12000);
    if (!enabled || payload.length <= threshold) return await this.callPrimary(payload);

    const chunkSize = Math.max(1500, Math.floor(threshold * 0.7));
    const chunks = splitText(payload, chunkSize);
    if (chunks.length <= 1) return await this.callPrimary(payload);

    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      const prefix = '下面是一份长材料的第 ' + (i + 1) + '/' + chunks.length + ' 段，请只总结这一段：\n\n';
      parts.push(await this.callPrimary(prefix + chunks[i]));
    }
    const merged = parts.join('\n\n');
    if (merged.length <= threshold) {
      return await this.callPrimary(
        '下面是对同一份材料分段做的总结，请合并成一份整体总结：去掉重复，保留全部关键信息与数字，不要丢内容。\n\n' + merged
      );
    }
    return merged;
  }

  // ----- 主流程 -----

  async createFromSource(source) {
    let text = '';
    let images = [];
    let sourceNotePath = '';

    if (source === 'activeNote') {
      const note = await this.readActiveNote();
      if (!note) {
        new Notice('请先打开一篇 Markdown 笔记，再点这个。');
        return;
      }
      text = note.text;
      images = note.images;
      sourceNotePath = note.file.path;
      if (!text && !images.length) {
        new Notice('这篇笔记里没有可总结的文字或图片。');
        return;
      }
    } else {
      const rawText = await this.readClipboardText();
      const fromClipboard = await this.readClipboardImages();
      // 有些应用复制图片时，文字里带的是 base64 —— 抠出来当图片，别当正文
      const parsed = extractImagesFromText(rawText);
      text = parsed.text;
      images = fromClipboard.concat(parsed.images);
      if (!text && !images.length) {
        new Notice('剪贴板里没读到内容。请先复制一段文字（或图片），再点一次。');
        return;
      }
    }

    const dateKey = formatDate(new Date(), 'YYYY-MM-DD');
    const time = formatDate(new Date(), 'HH:mm');
    const folder = String(this.settings.folder || '').trim().replace(/^\/+|\/+$/g, '');
    if (folder) await this.ensureFolder(folder);

    const imagePaths = await this.saveImages(images);

    let summary = '';
    let summaryError = '';
    const shouldSummarize = !!text || (this.settings.visionEnabled && !!images.length);
    if (shouldSummarize) {
      try {
        summary = await this.summarize(text, images);
      } catch (e) {
        summaryError = e && e.message ? e.message : String(e);
      }
    }

    let resultPath;
    if (this.settings.appendToToday) {
      resultPath = await this.upsertToday(dateKey, time, summary, imagePaths, text);
    } else {
      const title = formatDate(new Date(), this.settings.nameFormat);
      const content = this.buildNote(title, dateKey, time, summary, imagePaths, text, false);
      const path = await this.uniqueNotePath(folder, title);
      const file = await this.app.vault.create(path, content);
      await this.app.workspace.getLeaf(false).openFile(file);
      if (!imagePaths.length) {
        const imageLine = content.split('\n').findIndex(function (l) { return l === '## 🖼️ 图片'; });
        if (imageLine >= 0) this.focusLine(file, imageLine + 2);
      }
      resultPath = path;
    }

    // 记录本次用到的图片和笔记，方便「总结后清理图片」
    const runInfo = {
      imagePaths: source === 'activeNote'
        ? images.map(function (i) { return i.path; }).filter(Boolean)
        : imagePaths.slice(),
      notePaths: source === 'activeNote' ? [sourceNotePath] : [resultPath],
    };
    this._lastRun = runInfo;

    // 只在总结确实产出了内容时才清理，避免把还没用上的图删掉
    if (this.settings.cleanupAfterSummary && summary && !summaryError) {
      const cleaned = await this.cleanupImages(runInfo);
      if (cleaned) new Notice('已清理 ' + cleaned + ' 张图片（移到回收站，可恢复）', 5000);
    }

    if (summaryError) {
      new Notice('AI 总结没成功（' + summaryError + '）。已保存原文。', 9000);
    } else if (this._visionError) {
      new Notice('图片识别没成功（' + this._visionError + '），已只按文字总结。', 8000);
    } else if (this._visionPartial && this._visionPartial.length) {
      new Notice('部分图片没识别成功（' + this._visionPartial.join('；') + '），其余已写入。', 9000);
    } else if (!text) {
      new Notice('已把图片内容整理进笔记。', 5000);
    } else {
      new Notice(this.settings.appendToToday ? '已追加到当天笔记' : '已生成：' + resultPath, 4000);
    }
  }

  // 追加模式：一天一篇
  async upsertToday(dateKey, time, summary, imagePaths, text) {
    const folder = String(this.settings.folder || '').trim().replace(/^\/+|\/+$/g, '');
    const notePath = normalizePath(folder ? folder + '/' + dateKey + '.md' : dateKey + '.md');
    let file = this.app.vault.getAbstractFileByPath(notePath);

    if (file instanceof TFile) {
      await this.appendBlocks(file, time, summary, imagePaths, text);
    } else {
      if (folder) await this.ensureFolder(folder);
      const content = this.buildNote(dateKey, dateKey, time, summary, imagePaths, text, true);
      file = await this.app.vault.create(notePath, content);
    }

    await this.app.workspace.getLeaf(false).openFile(file);
    if (!imagePaths.length) {
      const current = await this.app.vault.read(file);
      const imgLine = current.split('\n').findIndex(function (l) { return l.trim() === '## 🖼️ 图片'; });
      if (imgLine >= 0) this.focusLine(file, imgLine + 2);
    }
    return notePath;
  }

  buildNote(title, dateKey, time, summary, imagePaths, text, withTime) {
    const lines = [];
    lines.push('---');
    lines.push('date: ' + dateKey);
    lines.push('tags:');
    lines.push('  - 剪贴板');
    lines.push('---');
    lines.push('');
    lines.push('# ' + title);
    if (summary) {
      lines.push('');
      lines.push('## 🤖 AI 总结');
      lines.push('');
      if (withTime) lines.push('### ' + time, '');
      lines.push(summary);
    }
    lines.push('');
    lines.push('## 🖼️ 图片');
    lines.push('');
    if (imagePaths.length) {
      imagePaths.forEach(function (p) { lines.push('![[' + p + ']]'); });
    } else {
      lines.push('> ' + this.settings.imageHint);
    }
    if (this.settings.saveOriginal && text) {
      lines.push('');
      lines.push('## 📄 原文');
      lines.push('');
      if (withTime) lines.push('### ' + time, '');
      lines.push(text);
    }
    lines.push('');
    return lines.join('\n');
  }

  async appendBlocks(file, time, summary, imagePaths, text) {
    const summaryLines = summary ? ['', '### ' + time, ''].concat(summary.trim().split('\n')) : null;
    const imageLines = imagePaths.length
      ? [''].concat(imagePaths.map(function (p) { return '![[' + p + ']]'; }))
      : null;
    const originalLines = (this.settings.saveOriginal && text)
      ? ['', '### ' + time, ''].concat(text.trim().split('\n'))
      : null;

    await this.app.vault.process(file, function (data) {
      let out = data;
      if (summaryLines) out = appendToSection(out, '## 🤖 AI 总结', summaryLines);
      if (imageLines) out = appendToSection(out, '## 🖼️ 图片', imageLines);
      if (originalLines) out = appendToSection(out, '## 📄 原文', originalLines);
      return out;
    });
  }

  focusLine(file, line) {
    const self = this;
    setTimeout(function () {
      try {
        const view = self.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file || view.file.path !== file.path) return;
        const state = view.getState && view.getState();
        if (state && state.mode === 'preview') {
          state.mode = 'source';
          const set = view.setState(state, { history: false });
          if (set && typeof set.then === 'function') set.then(function () { self.setCursor(view, line); }).catch(function () {});
        } else {
          self.setCursor(view, line);
        }
      } catch (e) {
        // 定位失败不影响结果
      }
    }, 300);
  }

  setCursor(view, line) {
    try {
      const editor = view.editor;
      const target = Math.min(line, Math.max(0, editor.lineCount() - 1));
      editor.setCursor({ line: target, ch: 0 });
      if (typeof editor.focus === 'function') editor.focus();
    } catch (e) {
      // 忽略
    }
  }

  // ----- 总结后清理图片（默认关，只清本次用到的，移到回收站）-----

  async trashFile(file) {
    const fm = this.app.fileManager;
    if (fm && typeof fm.trashFile === 'function') {
      await fm.trashFile(file);
      return;
    }
    if (this.app.vault && typeof this.app.vault.trash === 'function') {
      await this.app.vault.trash(file, true);
      return;
    }
    await this.app.vault.delete(file, true);
  }

  async cleanupImages(info) {
    if (!info || !info.imagePaths || !info.imagePaths.length) return 0;

    // 1) 先把笔记里的图片引用去掉，避免留下断链
    for (const p of info.notePaths || []) {
      const note = this.app.vault.getAbstractFileByPath(p);
      if (!(note instanceof TFile)) continue;
      const paths = info.imagePaths;
      try {
        await this.app.vault.process(note, function (data) {
          return stripImageEmbeds(data, paths);
        });
      } catch (e) {
        // 单个笔记失败不影响其它
      }
    }

    // 2) 再把图片文件移进回收站（可恢复）
    let n = 0;
    for (const p of info.imagePaths) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) continue;
      try {
        await this.trashFile(f);
        n++;
      } catch (e) {
        // 忽略单张失败
      }
    }
    return n;
  }

  cleanupLast() {
    const info = this._lastRun;
    if (!info || !info.imagePaths || !info.imagePaths.length) {
      new Notice('还没有可清理的图片（本次总结没用过图片）');
      return;
    }
    return this.cleanupImages(info).then((n) => {
      new Notice('已清理 ' + n + ' 张图片（移到回收站，可恢复）', 6000);
      this._lastRun = null;
    });
  }
}

// ---------- 设置页 ----------

class ClipboardSummarySettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const containerEl = this.containerEl;
    const tab = this;
    const plugin = this.plugin;
    const s = plugin.settings;
    containerEl.empty();

    const ver = plugin.manifest && plugin.manifest.version ? plugin.manifest.version : '?';
    containerEl.createEl('h2', { text: '剪贴板摘要 v' + ver });
    containerEl.createEl('p', {
      text: '把剪贴板、或当前笔记里的文字和图片，整理成一篇带日期的 AI 总结笔记。',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('侧边栏图标 / 桌面快捷指令 触发的动作')
      .setDesc('命令面板里两个动作都有，这里决定图标和 obsidian://clipboard 用哪个')
      .addDropdown(function (d) {
        return d
          .addOption('clipboard', '读剪贴板')
          .addOption('activeNote', '读当前打开的笔记（含笔记里的图片）')
          .setValue(String(s.primaryAction || 'clipboard'))
          .onChange(async function (v) {
            s.primaryAction = v;
            await plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('笔记保存文件夹')
      .setDesc('留空表示放库根目录')
      .addText(function (t) {
        return t.setPlaceholder('剪贴板').setValue(s.folder).onChange(async function (v) {
          s.folder = v.trim();
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('笔记命名格式')
      .setDesc('moment 格式，默认 YYYY-MM-DD HH-mm；同名会自动加序号')
      .addText(function (t) {
        return t.setPlaceholder('YYYY-MM-DD HH-mm').setValue(s.nameFormat).onChange(async function (v) {
          s.nameFormat = v.trim() || 'YYYY-MM-DD HH-mm';
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('追加到当天笔记')
      .setDesc('开：一天只建一篇，之后每次点按钮把新内容按时间追加进去；关：每次点按钮都新建一篇')
      .addToggle(function (tg) {
        return tg.setValue(!!s.appendToToday).onChange(async function (v) {
          s.appendToToday = v;
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('AI 插件 ID')
      .setDesc('默认 ai-note-summary，一般不用改')
      .addText(function (t) {
        return t.setPlaceholder('ai-note-summary').setValue(s.aiPluginId).onChange(async function (v) {
          s.aiPluginId = v.trim() || 'ai-note-summary';
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('总结提示词')
      .setDesc('决定 AI 怎么整理剪贴板内容')
      .addTextArea(function (t) {
        t.setValue(s.summaryPrompt).onChange(async function (v) {
          s.summaryPrompt = v;
          await plugin.saveSettings();
        });
        t.inputEl.rows = 3;
        t.inputEl.style.width = '100%';
        return t;
      });

    containerEl.createEl('h3', { text: '图片识别（可选，双模型）' });
    containerEl.createEl('p', {
      text: '用一个视觉模型先把图片转成文字，再交给上面的主模型总结——适合你继续用 DeepSeek、只额外配一个视觉模型。',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('启用图片识别')
      .setDesc('关着时图片只保存进笔记，不参与 AI 总结')
      .addToggle(function (tg) {
        return tg.setValue(!!s.visionEnabled).onChange(async function (v) {
          s.visionEnabled = v;
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('视觉模型 API 地址')
      .setDesc('例如通义：https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
      .addText(function (t) {
        t.setValue(s.visionApiUrl).onChange(async function (v) {
          s.visionApiUrl = v.trim();
          await plugin.saveSettings();
        });
        t.inputEl.style.width = '100%';
        return t;
      });

    new Setting(containerEl)
      .setName('视觉模型 API Key')
      .addText(function (t) {
        t.inputEl.type = 'password';
        t.setValue(s.visionApiKey).onChange(async function (v) {
          s.visionApiKey = v.trim();
          await plugin.saveSettings();
        });
        t.inputEl.style.width = '100%';
        return t;
      });

    new Setting(containerEl)
      .setName('视觉模型名称')
      .setDesc('例如 qwen-vl-plus')
      .addText(function (t) {
        return t.setPlaceholder('qwen-vl-plus').setValue(s.visionModel).onChange(async function (v) {
          s.visionModel = v.trim();
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('视觉提示词')
      .setDesc('让视觉模型做什么（提取文字 / 描述画面）')
      .addTextArea(function (t) {
        t.setValue(s.visionPrompt).onChange(async function (v) {
          s.visionPrompt = v;
          await plugin.saveSettings();
        });
        t.inputEl.rows = 2;
        t.inputEl.style.width = '100%';
        return t;
      });

    new Setting(containerEl)
      .setName('一次最多识别几张')
      .setDesc('默认 6。图片是一张一张发的，多图不会互相拖累')
      .addText(function (t) {
        return t.setPlaceholder('6').setValue(String(s.visionMaxImages)).onChange(async function (v) {
          const n = Number(v);
          s.visionMaxImages = Number.isFinite(n) && n > 0 ? Math.min(20, Math.round(n)) : 6;
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('发图前压缩到长边多少像素')
      .setDesc('默认 1568。手机截图动辄 2MB，压缩后通常只剩几百 KB，更快也更不容易失败')
      .addText(function (t) {
        return t.setPlaceholder('1568').setValue(String(s.visionMaxSide)).onChange(async function (v) {
          const n = Number(v);
          s.visionMaxSide = Number.isFinite(n) && n >= 320 ? Math.min(4096, Math.round(n)) : 1568;
          await plugin.saveSettings();
        });
      });

    containerEl.createEl('h3', { text: '长文本' });
    new Setting(containerEl)
      .setName('长文本分段总结')
      .setDesc('内容太长时先分段各自总结、再合并成一份，避免被接口静默截断')
      .addToggle(function (tg) {
        return tg.setValue(s.chunkEnabled !== false).onChange(async function (v) {
          s.chunkEnabled = v;
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('超过多少字开始分段')
      .setDesc('默认 12000')
      .addText(function (t) {
        return t.setPlaceholder('12000').setValue(String(s.chunkThreshold)).onChange(async function (v) {
          const n = Number(v);
          s.chunkThreshold = Number.isFinite(n) && n >= 2000 ? Math.round(n) : 12000;
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('保留原文')
      .setDesc('在笔记末尾保留剪贴板的原始文字，方便核对 AI 总结')
      .addToggle(function (tg) {
        return tg.setValue(!!s.saveOriginal).onChange(async function (v) {
          s.saveOriginal = v;
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('总结后清理图片')
      .setDesc('总结成功后，把本次用到的图片移出笔记并放进 Obsidian 回收站（可恢复）。默认关闭；命令面板里还有「清除最近一次总结用到的图片」可手动清')
      .addToggle(function (tg) {
        return tg.setValue(!!s.cleanupAfterSummary).onChange(async function (v) {
          s.cleanupAfterSummary = v;
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('图片文件夹')
      .setDesc('从剪贴板读到的图片会存到这里')
      .addText(function (t) {
        return t.setPlaceholder('剪贴板/附件').setValue(s.imageFolder).onChange(async function (v) {
          s.imageFolder = v.trim();
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('图片占位提示')
      .setDesc('读不到剪贴板图片时，在「图片」节显示这行字提醒手动粘贴')
      .addText(function (t) {
        t.setValue(s.imageHint).onChange(async function (v) {
          s.imageHint = v;
          await plugin.saveSettings();
        });
        t.inputEl.style.width = '100%';
        return t;
      });

    containerEl.createEl('h3', { text: '快捷启动（不用命令面板）' });
    containerEl.createEl('p', {
      text: '三种方式任选：① 手机端「移动端 → 管理工具栏」里添加本插件命令；② 左侧边栏的剪贴板图标；③ 手机桌面图标——把下面这串做成「打开 URL」的快捷指令即可。',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('桌面快捷指令地址')
      .addText(function (t) {
        t.setValue('obsidian://clipboard');
        t.inputEl.style.width = '100%';
        return t;
      });

    new Setting(containerEl)
      .setName('试用一下')
      .addButton(function (b) {
        return b.setButtonText('从剪贴板生成').setCta().onClick(function () {
          plugin.runSource('clipboard');
        });
      })
      .addButton(function (b) {
        return b.setButtonText('处理当前笔记').onClick(function () {
          plugin.runSource('activeNote');
        });
      })
      .addButton(function (b) {
        return b.setButtonText('测试视觉模型').onClick(function () {
          plugin.testVision();
        });
      })
      .addButton(function (b) {
        return b.setButtonText('恢复默认').setWarning().onClick(async function () {
          plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
          await plugin.saveSettings();
          tab.display();
          new Notice('已恢复默认设置');
        });
      });
  }
}

module.exports = ClipboardSummaryPlugin;
