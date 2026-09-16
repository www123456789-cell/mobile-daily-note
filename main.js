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

const SECTION_ORDER = ['## 🤖 AI 总结', '## 🖼️ 图片', '## 📄 原文'];

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

    this.addRibbonIcon('clipboard-pen', '剪贴板生成 AI 总结', this.run.bind(this));

    this.addCommand({
      id: 'clipboard-to-note',
      name: '剪贴板生成 AI 总结笔记',
      callback: this.run.bind(this),
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
    if (this._running) return;
    this._running = true;
    try {
      await this.createFromClipboard();
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

  async describeImages(images) {
    const url = String(this.settings.visionApiUrl || '').trim();
    const key = String(this.settings.visionApiKey || '').trim();
    const model = String(this.settings.visionModel || '').trim();
    if (!url || !key || !model) throw new Error('视觉模型没配全（地址 / Key / 模型）');

    const content = [{ type: 'text', text: this.settings.visionPrompt || '请描述这张图片的内容。' }];
    images.forEach(function (img) {
      content.push({
        type: 'image_url',
        image_url: { url: 'data:' + img.mime + ';base64,' + bytesToBase64(img.bytes) },
      });
    });

    const response = await requestUrl({
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
    if (response.status < 200 || response.status >= 300) {
      throw new Error('视觉模型返回 HTTP ' + response.status);
    }
    const data = response.json;
    const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof out !== 'string' || !out.trim()) throw new Error('视觉模型没有返回文字');
    return out.trim();
  }

  async summarize(text, images) {
    let payload = String(text || '').trim();
    this._visionError = '';

    if (this.settings.visionEnabled && images && images.length) {
      try {
        const imageText = await this.describeImages(images);
        payload = (payload ? payload + '\n\n' : '') + '以下是从图片中识别到的内容：\n' + imageText;
      } catch (e) {
        this._visionError = e && e.message ? e.message : String(e);
      }
    }
    if (!payload) throw new Error('没有可总结的内容');

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

  // ----- 主流程 -----

  async createFromClipboard() {
    const text = await this.readClipboardText();
    const images = await this.readClipboardImages();
    if (!text && !images.length) {
      new Notice('剪贴板里没读到内容。请先复制一段文字（或图片），再点一次。');
      return;
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

    if (summaryError) {
      new Notice('AI 总结没成功（' + summaryError + '）。已保存原文。', 9000);
    } else if (this._visionError) {
      new Notice('图片识别没成功（' + this._visionError + '），已只按文字总结。', 8000);
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

    containerEl.createEl('h2', { text: '剪贴板摘要' });
    containerEl.createEl('p', {
      text: '一键把剪贴板上的文字（和能读到的图片）整理成一篇带日期的 AI 总结笔记。',
      cls: 'setting-item-description',
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
      .setName('保留原文')
      .setDesc('在笔记末尾保留剪贴板的原始文字，方便核对 AI 总结')
      .addToggle(function (tg) {
        return tg.setValue(!!s.saveOriginal).onChange(async function (v) {
          s.saveOriginal = v;
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
          plugin.run();
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
