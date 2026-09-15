'use strict';

const obsidian = require('obsidian');
const Plugin = obsidian.Plugin;
const PluginSettingTab = obsidian.PluginSettingTab;
const Setting = obsidian.Setting;
const Notice = obsidian.Notice;
const MarkdownView = obsidian.MarkdownView;
const normalizePath = obsidian.normalizePath;
const moment = obsidian.moment || (typeof window !== 'undefined' ? window.moment : null);

const DEFAULT_SETTINGS = {
  folder: '剪贴板',
  nameFormat: 'YYYY-MM-DD HH-mm',
  aiPluginId: 'ai-note-summary',
  summaryPrompt: '把下面这段内容整理成简洁、准确的中文要点总结，保留关键信息与数字，不编造、不扩写。',
  saveOriginal: true,
  imageFolder: '剪贴板/附件',
  imageHint: '把复制的图片粘贴到这一节',
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

  async summarize(text) {
    const other = this.aiPlugin();
    const api = other && other.api;
    if (api && typeof api.summarizeText === 'function') {
      return await api.summarizeText(text, { systemPrompt: this.settings.summaryPrompt });
    }
    if (other && typeof other.callAI === 'function' && other.settings) {
      const s = other.settings;
      if (!(s.apiUrl && s.apiKey && s.model)) throw new Error('「AI 笔记总结」还没配置 API Key');
      const maxChars = Number(s.maxChars) || 0;
      const payload = maxChars > 0 && text.length > maxChars
        ? text.slice(0, maxChars) + '\n\n…（内容过长，已截断）'
        : text;
      const summary = await other.callAI('剪贴板内容', payload, {
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

    const title = formatDate(new Date(), this.settings.nameFormat);
    const date = formatDate(new Date(), 'YYYY-MM-DD');
    const folder = String(this.settings.folder || '').trim().replace(/^\/+|\/+$/g, '');
    if (folder) await this.ensureFolder(folder);

    const imagePaths = await this.saveImages(images);

    let summary = '';
    let summaryError = '';
    if (text) {
      try {
        summary = await this.summarize(text);
      } catch (e) {
        summaryError = e && e.message ? e.message : String(e);
      }
    }

    const lines = [];
    lines.push('---');
    lines.push('date: ' + date);
    lines.push('tags:');
    lines.push('  - 剪贴板');
    lines.push('---');
    lines.push('');
    lines.push('# ' + title);
    lines.push('');
    if (summary) {
      lines.push('## 🤖 AI 总结');
      lines.push('');
      lines.push(summary);
      lines.push('');
    }
    lines.push('## 🖼️ 图片');
    lines.push('');
    if (imagePaths.length) {
      imagePaths.forEach(function (p) { lines.push('![[' + p + ']]'); });
    } else {
      lines.push('> ' + this.settings.imageHint);
    }
    lines.push('');
    if (this.settings.saveOriginal && text) {
      lines.push('## 📄 原文');
      lines.push('');
      lines.push(text);
      lines.push('');
    }

    const content = lines.join('\n');
    const path = await this.uniqueNotePath(folder, title);
    const file = await this.app.vault.create(path, content);
    await this.app.workspace.getLeaf(false).openFile(file);

    // 没自动读到的图片：把光标放到「图片」节，方便长按粘贴
    const imageLine = lines.findIndex(function (l) { return l === '## 🖼️ 图片'; });
    if (imageLine >= 0 && !imagePaths.length) {
      this.focusLine(file, imageLine + 2);
    }

    if (summaryError) {
      new Notice('AI 总结没成功（' + summaryError + '）。已保存原文。', 9000);
    } else if (!text) {
      new Notice('剪贴板没有文字，已把图片放进新笔记。', 5000);
    } else {
      new Notice('已生成：' + path, 4000);
    }
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
