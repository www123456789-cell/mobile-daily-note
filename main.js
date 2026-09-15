'use strict';

const obsidian = require('obsidian');
const Plugin = obsidian.Plugin;
const PluginSettingTab = obsidian.PluginSettingTab;
const Setting = obsidian.Setting;
const Notice = obsidian.Notice;
const TFile = obsidian.TFile;
const normalizePath = obsidian.normalizePath;
const moment = obsidian.moment || (typeof window !== 'undefined' ? window.moment : null);

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 板块定义：title 是写进笔记的标题，keyword/aliases 用来判断“这个板块是否已经存在”。
// 所以你可以手动把标题改成「## 今日课程」不带 emoji，插件依然认得出来。
const SECTIONS = [
  { key: 'courses', title: '📚 今日课程', keyword: '今日课程', aliases: ['课程'] },
  { key: 'todos', title: '✅ 代办计划', keyword: '代办计划', aliases: ['待办计划', '待办', 'TODO'] },
  { key: 'images', title: '🖼️ 待添加图片', keyword: '待添加图片', aliases: ['图片'] },
  { key: 'notes', title: '📝 随手记', keyword: '随手记', aliases: ['记录'] },
  { key: 'review', title: '🌙 今日回顾', keyword: '今日回顾', aliases: ['回顾'] },
];

function sectionByKey(key) {
  return SECTIONS.filter(function (s) { return s.key === key; })[0];
}

const DEFAULT_SETTINGS = {
  folder: '日记',
  fileNameFormat: 'YYYY-MM-DD',
  templatePath: '',
  courses: [
    '# 一行一天，格式 星期X: 课程1, 课程2（周一/星期一都行，多天可用逗号并列）',
    '周一: 高等数学, 大学英语',
    '周二: 线性代数',
    '周三: 大学物理, 数据结构',
    '周四: 概率论',
    '周五: 英语口语',
  ].join('\n'),
  todoPresets: '复习今日课程\n完成课后作业\n整理今日笔记',
  imageSlots: 2,
  imageHint: '手机端：点这一行，用键盘上方的 📎 插入刚拍的照片或截图',
  addFrontmatter: true,
  cssClass: 'daily-mobile',
  openAfterCreate: true,
  autoFixSections: true,
  // —— 与「AI 笔记总结」插件联动 ——
  aiPluginId: 'ai-note-summary',
  transcriptFolder: '',
  transcriptKeywords: '录音,转写,课堂,讲座',
  transcriptExclude: '总结',
  transcriptTodayOnly: true,
  autoAnalyzeOnOpen: true,
};

// ---------- 纯函数区：不依赖 Obsidian 对象，方便单独测试 ----------

function getLines(raw) {
  return String(raw == null ? '' : raw)
    .split('\n')
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l && l.charAt(0) !== '#'; });
}

function normalizeDay(text) {
  return String(text == null ? '' : text).trim().replace(/^星期/, '周').replace(/\s+/g, '');
}

function matchesSection(line, section) {
  const body = line.replace(/^#{1,6}\s*/, '').trim();
  const names = [section.keyword].concat(section.aliases || []);
  return names.some(function (n) { return body.indexOf(n) >= 0; });
}

// 在 content 的某个板块末尾插入若干行；找不到该板块时补到文末，绝不改动已有内容。
function insertIntoSection(content, section, lines) {
  const text = String(content == null ? '' : content);
  const all = text.split('\n');

  let start = -1;
  for (let i = 0; i < all.length; i++) {
    if (/^#{1,6}\s/.test(all[i]) && matchesSection(all[i], section)) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    const base = text.replace(/\s*$/, '');
    return base + '\n\n## ' + section.title + '\n' + lines.join('\n') + '\n';
  }

  let end = all.length;
  for (let i = start + 1; i < all.length; i++) {
    if (/^#{1,6}\s/.test(all[i])) {
      end = i;
      break;
    }
  }

  let insertAt = end;
  while (insertAt - 1 > start && all[insertAt - 1].trim() === '') insertAt--;

  const next = all.slice();
  next.splice.apply(next, [insertAt, 0].concat(lines));
  return next.join('\n');
}

// ---------- AI 分析写回相关：同样是纯函数，方便单独测试 ----------

const AI_BEGIN_PREFIX = '<!-- ans:begin source="';
const AI_END_PREFIX = '<!-- ans:end source="';

function escapeAttr(value) {
  return String(value == null ? '' : value).replace(/"/g, '&quot;');
}

function escapeRegExp(value) {
  return String(value == null ? '' : value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// FNV-1a 32 位：用来判断源笔记内容有没有变过，避免反复花 API 的钱
function hashText(text) {
  let h = 0x811c9dc5;
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

function buildAIBlock(info) {
  return [
    AI_BEGIN_PREFIX + escapeAttr(info.key) + '" hash="' + info.hash + '" -->',
    '### ' + info.title,
    '> 来源：[[' + info.link + '|' + info.name + ']]　由 AI 生成，请核对后使用',
    '',
    String(info.summary == null ? '' : info.summary).trim(),
    AI_END_PREFIX + escapeAttr(info.key) + '" -->',
  ].join('\n');
}

// 已有该来源的分析块就原地替换，没有就追加到目标板块末尾
function upsertAIBlock(content, section, key, block) {
  const text = String(content == null ? '' : content);
  const beginNeedle = AI_BEGIN_PREFIX + escapeAttr(key) + '"';
  const beginIdx = text.indexOf(beginNeedle);
  if (beginIdx >= 0) {
    const endNeedle = AI_END_PREFIX + escapeAttr(key) + '" -->';
    const endIdx = text.indexOf(endNeedle, beginIdx);
    if (endIdx >= 0) {
      return text.slice(0, beginIdx) + block + text.slice(endIdx + endNeedle.length);
    }
  }
  return insertIntoSection(text, section, block.split('\n'));
}

function findAIBlockHash(content, key) {
  const re = new RegExp(escapeRegExp(AI_BEGIN_PREFIX + escapeAttr(key)) + '" hash="([0-9a-f]+)"');
  const m = String(content == null ? '' : content).match(re);
  return m ? m[1] : null;
}

// ---------- 插件本体 ----------

class MobileDailyNotePlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.addRibbonIcon('calendar-plus', '打开今日笔记', this.openDailyNote.bind(this));

    this.addCommand({
      id: 'open-today',
      name: '打开或创建今日笔记',
      callback: this.openDailyNote.bind(this),
    });

    this.addCommand({
      id: 'add-todo',
      name: '今日笔记：加一条待办',
      callback: this.addTodoLine.bind(this),
    });

    this.addCommand({
      id: 'add-image-slot',
      name: '今日笔记：在“待添加图片”加一个占位',
      callback: this.addImageSlot.bind(this),
    });

    this.addCommand({
      id: 'analyze-today-transcripts',
      name: 'AI 分析今日转写笔记并写入课程栏',
      callback: this.analyzeTranscripts.bind(this),
    });

    this.addCommand({
      id: 'analyze-active-note-into-today',
      name: '把当前笔记的 AI 分析写入今日课程栏',
      callback: this.analyzeActiveNote.bind(this),
    });

    this.addCommand({
      id: 'insert-image-placeholder',
      name: '光标处插入图片占位',
      editorCallback: function (editor) { editor.replaceSelection('\n- [ ] 📷 \n'); },
    });

    // 手机桌面一键按钮：obsidian://daily-note 直接打开/创建今日笔记，
    // 详情看设置页里「手机桌面一键按钮」那一项。
    this.registerObsidianProtocolHandler('daily-note', this.openDailyNote.bind(this));
    this.registerObsidianProtocolHandler('daily-todo', this.addTodoLine.bind(this));

    this.addSettingTab(new DailyNoteSettingTab(this.app, this));
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ----- 日期与课程 -----

  today() {
    const m = moment ? moment() : null;
    if (m) {
      return {
        dateStr: m.format(this.settings.fileNameFormat || 'YYYY-MM-DD'),
        weekday: WEEKDAYS[m.day()],
      };
    }
    const d = new Date();
    const pad = function (n) { return String(n).length < 2 ? '0' + n : String(n); };
    return {
      dateStr: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
      weekday: WEEKDAYS[d.getDay()],
    };
  }

  getCoursesFor(weekday) {
    const day = normalizeDay(weekday);
    const out = [];
    getLines(this.settings.courses).forEach(function (line) {
      const idx = line.search(/[:：]/);
      if (idx < 0) return;
      const days = line.slice(0, idx).split(/[,，、/]/).map(normalizeDay).filter(Boolean);
      if (days.indexOf(day) < 0) return;
      line
        .slice(idx + 1)
        .split(/[,，;；、]/)
        .map(function (c) { return c.trim(); })
        .filter(Boolean)
        .forEach(function (c) { out.push(c); });
    });
    return out;
  }

  imageSlotCount() {
    const n = Number(this.settings.imageSlots);
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(8, Math.round(n)));
  }

  todoLines() {
    return getLines(this.settings.todoPresets);
  }

  // ----- 生成内容 -----

  sectionBlocks(weekday) {
    const courses = this.getCoursesFor(weekday);
    const todos = this.todoLines();
    const slots = this.imageSlotCount();
    const self = this;

    return SECTIONS.map(function (section) {
      let body;
      if (section.key === 'courses') {
        body = courses.length
          ? courses.map(function (c) { return '- [ ] ' + c; }).join('\n')
          : '- [ ] ';
      } else if (section.key === 'todos') {
        body = todos
          .map(function (t) { return '- [ ] ' + t; })
          .concat(['- [ ] '])
          .join('\n');
      } else if (section.key === 'images') {
        const lines = [];
        if (self.settings.imageHint) lines.push('> ' + self.settings.imageHint);
        for (let i = 0; i < slots; i++) lines.push('- [ ] 📷 ');
        body = lines.join('\n') || '- [ ] 📷 ';
      } else if (section.key === 'notes') {
        body = '';
      } else {
        body = '- 完成：\n- 没完成：\n- 明天先做：';
      }
      return {
        key: section.key,
        text: body ? '## ' + section.title + '\n' + body : '## ' + section.title + '\n',
      };
    });
  }

  frontmatter(dateStr, weekday) {
    const lines = ['---', 'date: ' + dateStr, 'weekday: ' + weekday, 'tags:', '  - 日记'];
    if (this.settings.cssClass) lines.push('cssclasses:', '  - ' + this.settings.cssClass);
    lines.push('---');
    return lines.join('\n');
  }

  async readTemplate() {
    const p = String(this.settings.templatePath || '').trim();
    if (!p) return null;
    const file = this.app.vault.getAbstractFileByPath(normalizePath(p));
    if (file instanceof TFile) return await this.app.vault.read(file);
    new Notice('模板文件没找到，已改用内置模板：' + p);
    return null;
  }

  applyTemplate(raw, dateStr, weekday) {
    const courses = this.getCoursesFor(weekday);
    const todos = this.todoLines();
    const imageBlock = this.sectionBlocks(weekday).filter(function (b) { return b.key === 'images'; })[0];
    return String(raw)
      .replace(/\{\{date:([^}]+)\}\}/g, function (m, fmt) {
        return moment ? moment().format(String(fmt).trim()) : dateStr;
      })
      .replace(/\{\{date\}\}/g, dateStr)
      .replace(/\{\{weekday\}\}/g, weekday)
      .replace(/\{\{courses\}\}/g, courses.length ? courses.map(function (c) { return '- [ ] ' + c; }).join('\n') : '- [ ] ')
      .replace(/\{\{todos\}\}/g, todos.map(function (t) { return '- [ ] ' + t; }).concat(['- [ ] ']).join('\n'))
      .replace(/\{\{images\}\}/g, imageBlock.text.split('\n').slice(1).join('\n'));
  }

  async buildContent(dateStr, weekday) {
    const tpl = await this.readTemplate();
    if (tpl !== null) return this.applyTemplate(tpl, dateStr, weekday);

    const parts = [];
    if (this.settings.addFrontmatter) parts.push(this.frontmatter(dateStr, weekday));
    parts.push('# ' + dateStr + ' ' + weekday);
    this.sectionBlocks(weekday).forEach(function (block) { parts.push(block.text); });
    return parts.join('\n\n') + '\n';
  }

  // ----- 文件读写 -----

  dailyPath(dateStr) {
    const folder = String(this.settings.folder || '').trim().replace(/^\/+|\/+$/g, '');
    return normalizePath(folder ? folder + '/' + dateStr + '.md' : dateStr + '.md');
  }

  // 直接查磁盘，绕过 Obsidian 的内存索引（同步刚写进来的文件可能还没被索引）
  async existsOnDisk(path) {
    try {
      const adapter = this.app.vault.adapter;
      if (adapter && typeof adapter.exists === 'function') return Boolean(await adapter.exists(path));
    } catch (e) {
      // 查不了就当不存在，后面还有创建后的兜底检查
    }
    return false;
  }

  async ensureFolder(folder) {
    const parts = normalizePath(folder).split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      cur = cur ? cur + '/' + parts[i] : parts[i];
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch (e) {
          // 已存在或并发创建，忽略
        }
      }
    }
  }

  fillMissingSections(data, dateStr, weekday) {
    const missing = this.sectionBlocks(weekday).filter(function (b) {
      const section = sectionByKey(b.key);
      const names = [section.keyword].concat(section.aliases || []);
      return !names.some(function (n) { return String(data).indexOf(n) >= 0; });
    });
    if (!missing.length) return data;
    const base = String(data).replace(/\s*$/, '');
    return base + '\n\n' + missing.map(function (m) { return m.text; }).join('\n\n') + '\n';
  }

  async ensureTodayFile() {
    const info = this.today();
    const path = this.dailyPath(info.dateStr);
    let existing = this.app.vault.getAbstractFileByPath(path);
    const self = this;

    if (existing && !(existing instanceof TFile)) {
      new Notice('路径被文件夹占用了：' + path);
      return null;
    }

    // 索引里没有、但磁盘上已经有了（同步刚写进来 / 索引还没刷新）：
    // 这种情况绝不能去 create，否则 Obsidian 会因重名建出「xxx 1.md」副本。
    if (!(existing instanceof TFile) && (await this.existsOnDisk(path))) {
      await new Promise(function (r) { setTimeout(r, 400); });
      existing = self.app.vault.getAbstractFileByPath(path);
      if (!(existing instanceof TFile)) {
        new Notice('今天的笔记其实已经存在，只是 Obsidian 还没索引到。等几秒再点一次即可，已阻止产生重复副本：' + path, 6000);
        return null;
      }
    }

    if (existing instanceof TFile) {
      if (this.settings.autoFixSections) {
        await this.app.vault.process(existing, function (data) {
          return self.fillMissingSections(data, info.dateStr, info.weekday);
        });
      }
      return { file: existing, path: path, dateStr: info.dateStr, weekday: info.weekday, created: false };
    }

    const folder = String(this.settings.folder || '').trim().replace(/^\/+|\/+$/g, '');
    if (folder) await this.ensureFolder(folder);
    const content = await this.buildContent(info.dateStr, info.weekday);
    const file = await this.app.vault.create(path, content);

    // 兜底：万一还是被 Obsidian 改名了（说明我们判断错了），把这份多余的副本删掉，
    // 改用真正该用的那一份，避免库里越攒越多「xxx 1.md」。
    if (normalizePath(file.path) !== normalizePath(path)) {
      const wrongPath = file.path;
      try {
        await this.app.vault.delete(file, true);
      } catch (e) {
        console.error('[mobile-daily-note]', e);
      }
      const real = this.app.vault.getAbstractFileByPath(path);
      if (real instanceof TFile) {
        new Notice('检测到重名，已清理多余副本「' + wrongPath + '」，改用已有笔记。');
        return { file: real, path: path, dateStr: info.dateStr, weekday: info.weekday, created: false };
      }
      new Notice('创建今日笔记时遇到重名冲突，请手动检查：' + wrongPath, 8000);
      return null;
    }

    return { file: file, path: path, dateStr: info.dateStr, weekday: info.weekday, created: true };
  }

  async openDailyNote() {
    // 防止连点两次导致重复创建
    if (this._opening) return;
    this._opening = true;
    try {
      const res = await this.ensureTodayFile();
      if (!res) return;
      if (res.created) new Notice('已创建今日笔记：' + res.dateStr);
      if (this.settings.openAfterCreate) {
        await this.app.workspace.getLeaf(false).openFile(res.file);
      } else {
        new Notice('今日笔记已就绪：' + res.path);
      }
      this.maybeAutoAnalyze();
    } catch (e) {
      console.error('[mobile-daily-note]', e);
      new Notice('打开今日笔记失败：' + (e && e.message ? e.message : e));
    } finally {
      this._opening = false;
    }
  }

  async insertIntoToday(key, lines) {
    const section = sectionByKey(key);
    try {
      const res = await this.ensureTodayFile();
      if (!res) return;
      await this.app.vault.process(res.file, function (data) {
        return insertIntoSection(data, section, lines);
      });
      if (this.settings.openAfterCreate) {
        await this.app.workspace.getLeaf(false).openFile(res.file);
      }
      new Notice('已写入「' + section.title + '」');
    } catch (e) {
      console.error('[mobile-daily-note]', e);
      new Notice('写入失败：' + (e && e.message ? e.message : e));
    }
  }

  addTodoLine() {
    return this.insertIntoToday('todos', ['- [ ] ']);
  }

  addImageSlot() {
    return this.insertIntoToday('images', ['- [ ] 📷 ']);
  }

  // ----- 与「AI 笔记总结」插件联动 -----

  // 找到「AI 笔记总结」插件，包装成一个统一的小接口；
  // 全程只调用它现成的方法，不要求、也不对它做任何修改。
  summaryProvider() {
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
    if (!other) return null;

    // 路线 A：对方插件自己暴露了 api（如果有这种版本，优先用它）
    const api = other.api;
    if (api && typeof api.summarizeFile === 'function') {
      return {
        via: 'api',
        isConfigured: function () {
          return typeof api.isConfigured === 'function' ? Boolean(api.isConfigured()) : true;
        },
        summarizeFile: function (file, options) {
          return api.summarizeFile(file, options);
        },
      };
    }

    // 路线 B：原版插件没有对外 api，但它实例上的 callAI + settings 是现成的，
    // 直接按它原本的调用方式用它（截断逻辑也照它的设置来，行为保持一致）。
    if (typeof other.callAI === 'function' && other.settings) {
      const self = this;
      const owner = other;
      return {
        via: 'callAI',
        isConfigured: function () {
          const s = owner.settings || {};
          return Boolean(s.apiUrl && s.apiKey && s.model);
        },
        summarizeFile: async function (file, options) {
          const raw = String((await self.app.vault.cachedRead(file)) || '').trim();
          if (!raw) throw new Error('《' + file.name + '》是空的，没有可总结的内容');
          const s = owner.settings || {};
          const maxChars = Number(s.maxChars) || 0;
          const payload = maxChars > 0 && raw.length > maxChars
            ? raw.slice(0, maxChars) + '\n\n…（内容过长，以上已截断）'
            : raw;
          const summary = await owner.callAI(file.name, payload, {
            apiUrl: s.apiUrl,
            apiKey: s.apiKey,
            model: s.model,
            systemPrompt: (options && options.systemPrompt) || s.systemPrompt,
          });
          if (!summary) throw new Error('AI 没有返回内容，请检查它的模型配置');
          return summary;
        },
      };
    }

    return null;
  }

  dateVariants(dateStr) {
    const parts = String(dateStr).split('-');
    if (parts.length !== 3) return [String(dateStr)];
    const y = parts[0];
    const mo = parts[1];
    const d = parts[2];
    return [
      y + '-' + mo + '-' + d,
      y + mo + d,
      mo + '-' + d,
      Number(mo) + '月' + Number(d) + '日',
      Number(mo) + '/' + Number(d),
    ];
  }

  isTodayFile(file) {
    const name = String(file.basename || '');
    const variants = this.dateVariants(this.today().dateStr);
    for (let i = 0; i < variants.length; i++) {
      if (name.indexOf(variants[i]) >= 0) return true;
    }
    const stat = file.stat;
    if (!stat) return false;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const from = start.getTime();
    const to = from + 24 * 60 * 60 * 1000;
    return (stat.mtime >= from && stat.mtime < to) || (stat.ctime >= from && stat.ctime < to);
  }

  matchesTranscriptKeywords(file) {
    const keywords = String(this.settings.transcriptKeywords || '')
      .split(/[\n,，;；]/)
      .map(function (k) { return k.trim().toLowerCase(); })
      .filter(Boolean);
    if (!keywords.length) return true;
    const hay = (file.path + ' ' + file.basename).toLowerCase();
    return keywords.some(function (k) { return hay.indexOf(k) >= 0; });
  }

  // 排除项：默认把「-总结.md」这类文件排掉，免得 AI 去总结 AI 的总结
  isExcluded(file) {
    const words = String(this.settings.transcriptExclude || '')
      .split(/[\n,，;；]/)
      .map(function (k) { return k.trim().toLowerCase(); })
      .filter(Boolean);
    if (!words.length) return false;
    const hay = (file.path + ' ' + file.basename).toLowerCase();
    return words.some(function (w) { return hay.indexOf(w) >= 0; });
  }

  collectTranscripts() {
    const folder = String(this.settings.transcriptFolder || '').trim().replace(/^\/+|\/+$/g, '');
    const prefix = folder ? normalizePath(folder) + '/' : '';
    const todayPath = this.dailyPath(this.today().dateStr);
    const self = this;

    return this.app.vault
      .getMarkdownFiles()
      .filter(function (f) {
        if (f.path === todayPath) return false;
        if (prefix && f.path.indexOf(prefix) !== 0) return false;
        if (self.isExcluded(f)) return false;
        if (!self.matchesTranscriptKeywords(f)) return false;
        if (self.settings.transcriptTodayOnly && !self.isTodayFile(f)) return false;
        return true;
      })
      .sort(function (a, b) {
        const am = a.stat ? a.stat.mtime : 0;
        const bm = b.stat ? b.stat.mtime : 0;
        return am - bm;
      });
  }

  // 笔记名里带课程名时，就把分析归到那门课下面
  findCourseFor(name) {
    const courses = this.getCoursesFor(this.today().weekday);
    const target = String(name || '').toLowerCase();
    if (!target) return '';
    for (let i = 0; i < courses.length; i++) {
      const course = String(courses[i]).trim();
      if (course.length < 2) continue;
      const key = course.toLowerCase();
      if (target.indexOf(key) >= 0 || key.indexOf(target) >= 0) return course;
    }
    return '';
  }

  // 分析单篇并写入今日笔记；返回 'analyzed' 或 'skipped'
  async analyzeInto(todayFile, provider, file) {
    const raw = await this.app.vault.cachedRead(file);
    const hash = hashText(raw);
    const current = await this.app.vault.read(todayFile);
    if (findAIBlockHash(current, file.path) === hash) return 'skipped';

    const summary = await provider.summarizeFile(file, { sourceName: file.basename });
    const course = this.findCourseFor(file.basename);
    const block = buildAIBlock({
      key: file.path,
      link: file.path.replace(/\.md$/i, ''),
      name: file.basename,
      hash: hash,
      title: course ? '🤖 ' + course + ' · AI 分析' : '🤖 ' + file.basename + ' · AI 分析',
      summary: summary,
    });

    await this.app.vault.process(todayFile, function (data) {
      return upsertAIBlock(data, sectionByKey('courses'), file.path, block);
    });
    return 'analyzed';
  }

  async runAnalysis(files, options) {
    const silent = Boolean(options && options.silent);
    const provider = this.summaryProvider();
    if (!provider) {
      if (!silent) {
        new Notice('没找到可用的「AI 笔记总结」插件（' + this.settings.aiPluginId + '）。请确认它已安装并启用。');
      }
      return;
    }
    if (!provider.isConfigured()) {
      if (!silent) new Notice('「AI 笔记总结」还没填 API Key，先去它的设置里配好。');
      return;
    }

    const res = await this.ensureTodayFile();
    if (!res) return;

    // 先筛一遍：内容没变过的直接跳过，既不弹提示也不花 API 的钱
    const pending = [];
    let skipped = 0;
    const current = await this.app.vault.read(res.file);
    for (let i = 0; i < files.length; i++) {
      const raw = await this.app.vault.cachedRead(files[i]);
      if (findAIBlockHash(current, files[i].path) === hashText(raw)) skipped++;
      else pending.push(files[i]);
    }

    if (!pending.length) {
      if (!silent) new Notice('没有需要分析的笔记（' + skipped + ' 篇内容没变）');
      return;
    }

    const progress = new Notice('正在分析 ' + pending.length + ' 篇转写笔记…', 0);
    let analyzed = 0;
    const errors = [];
    for (let i = 0; i < pending.length; i++) {
      try {
        const outcome = await this.analyzeInto(res.file, provider, pending[i]);
        if (outcome === 'analyzed') analyzed++;
        else skipped++;
      } catch (e) {
        console.error('[mobile-daily-note]', pending[i].path, e);
        errors.push(pending[i].basename + '：' + (e && e.message ? e.message : e));
      }
    }
    progress.hide();

    if (analyzed > 0 && this.settings.openAfterCreate) {
      await this.app.workspace.getLeaf(false).openFile(res.file);
    }

    const parts = [];
    if (analyzed) parts.push('已写入 ' + analyzed + ' 篇 AI 分析');
    if (skipped) parts.push('跳过 ' + skipped + ' 篇（内容没变）');
    if (!analyzed && !skipped) parts.push('没有可写入的内容');
    if (errors.length) parts.push('失败 ' + errors.length + ' 篇');

    const text = parts.join('，') + (errors.length ? '\n' + errors.join('\n') : '');
    const showResult = !silent || analyzed > 0 || errors.length > 0;
    if (showResult) new Notice(text, errors.length ? 10000 : 4000);
  }

  async analyzeTranscripts() {
    const files = this.collectTranscripts();
    if (!files.length) {
      new Notice('没匹配到转写笔记。可在设置里调整「转写笔记文件夹 / 关键词 / 只看今天的」。');
      return;
    }
    await this.runAnalysis(files);
  }

  async analyzeActiveNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      new Notice('请先打开一篇 Markdown 笔记');
      return;
    }
    if (file.path === this.dailyPath(this.today().dateStr)) {
      new Notice('当前打开的就是今日笔记，换一篇转写笔记再试');
      return;
    }
    await this.runAnalysis([file]);
  }

  // 打开今日笔记时顺带分析（新内容才花钱，没变就跳过）
  maybeAutoAnalyze() {
    if (!this.settings.autoAnalyzeOnOpen) return;
    if (this._autoAnalyzing) return;
    if (!this.summaryProvider()) return;
    const files = this.collectTranscripts();
    if (!files.length) return;

    const self = this;
    this._autoAnalyzing = true;
    (async function () {
      try {
        await self.runAnalysis(files, { silent: true });
      } catch (e) {
        console.error('[mobile-daily-note]', e);
      }
      self._autoAnalyzing = false;
    })();
  }
}

// ---------- 设置页 ----------

class DailyNoteSettingTab extends PluginSettingTab {
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

    containerEl.createEl('h2', { text: '每日笔记助手' });
    containerEl.createEl('p', {
      text: '改完即时生效，不需要重启。课程表与待办默认项都是每行一条。',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('笔记存放文件夹')
      .setDesc('留空表示库根目录；不存在会自动创建。例如：日记/2026')
      .addText(function (t) {
        return t.setPlaceholder('日记').setValue(s.folder).onChange(async function (v) {
          s.folder = v;
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('文件名格式')
      .setDesc('moment 格式，默认 YYYY-MM-DD')
      .addText(function (t) {
        return t.setPlaceholder('YYYY-MM-DD').setValue(s.fileNameFormat).onChange(async function (v) {
          s.fileNameFormat = v.trim() || 'YYYY-MM-DD';
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('一周课程表')
      .setDesc('格式 星期X: 课程1, 课程2。某天没课就写「周三:」。以 # 开头的行会被忽略。')
      .addTextArea(function (t) {
        t.setValue(s.courses).onChange(async function (v) {
          s.courses = v;
          await plugin.saveSettings();
        });
        t.inputEl.rows = 8;
        t.inputEl.style.width = '100%';
        t.inputEl.style.fontFamily = 'var(--font-monospace)';
        return t;
      });

    new Setting(containerEl)
      .setName('待办默认项')
      .setDesc('每行一条，作为每天的初始待办；留空则只留一个空待办')
      .addTextArea(function (t) {
        t.setValue(s.todoPresets).onChange(async function (v) {
          s.todoPresets = v;
          await plugin.saveSettings();
        });
        t.inputEl.rows = 5;
        t.inputEl.style.width = '100%';
        return t;
      });

    new Setting(containerEl)
      .setName('图片占位数量')
      .setDesc('「待添加图片」里预生成几个空占位（0–8）')
      .addSlider(function (sl) {
        return sl
          .setLimits(0, 8, 1)
          .setValue(plugin.imageSlotCount())
          .setDynamicTooltip()
          .onChange(async function (v) {
            s.imageSlots = v;
            await plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('图片提示语')
      .setDesc('写在「待添加图片」顶部的一行引用；留空则不显示')
      .addText(function (t) {
        t.setValue(s.imageHint).onChange(async function (v) {
          s.imageHint = v;
          await plugin.saveSettings();
        });
        t.inputEl.style.width = '100%';
        return t;
      });

    new Setting(containerEl)
      .setName('自定义模板文件')
      .setDesc('可选。库内路径如 模板/日报模板.md，支持 {{date}} {{weekday}} {{courses}} {{todos}} {{images}}；留空用内置模板')
      .addText(function (t) {
        return t.setPlaceholder('模板/日报模板.md').setValue(s.templatePath).onChange(async function (v) {
          s.templatePath = v.trim();
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('写入 frontmatter')
      .setDesc('写入 date / weekday / tags，方便 Dataview 之类检索')
      .addToggle(function (tg) {
        return tg.setValue(!!s.addFrontmatter).onChange(async function (v) {
          s.addFrontmatter = v;
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('CSS 类名')
      .setDesc('写入 frontmatter 的 cssclasses，配合本插件 styles.css 优化手机端显示；留空则不加')
      .addText(function (t) {
        return t.setPlaceholder('daily-mobile').setValue(s.cssClass).onChange(async function (v) {
          s.cssClass = v.trim();
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('创建后自动打开')
      .setDesc('关闭时只在后台生成文件并弹提示')
      .addToggle(function (tg) {
        return tg.setValue(!!s.openAfterCreate).onChange(async function (v) {
          s.openAfterCreate = v;
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('自动补全缺失板块')
      .setDesc('当天笔记已存在时，只把缺的板块追加到文末，不修改你已经写好的内容')
      .addToggle(function (tg) {
        return tg.setValue(!!s.autoFixSections).onChange(async function (v) {
          s.autoFixSections = v;
          await plugin.saveSettings();
        });
      });

    containerEl.createEl('h3', { text: '与「AI 笔记总结」联动' });
    containerEl.createEl('p', {
      text: '让转写笔记的 AI 分析自动出现在「今日课程」板块里。只要「AI 笔记总结」已安装、启用并填好 API Key 即可——它保持原版就行，本插件不会改动它。',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('AI 插件 ID')
      .setDesc('默认 ai-note-summary；除非你改过那个插件的 manifest id，否则不用动')
      .addText(function (t) {
        return t.setPlaceholder('ai-note-summary').setValue(s.aiPluginId).onChange(async function (v) {
          s.aiPluginId = v.trim() || 'ai-note-summary';
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('转写笔记文件夹')
      .setDesc('只在哪个文件夹里找转写笔记；留空表示在整个库里找')
      .addText(function (t) {
        return t.setPlaceholder('转写').setValue(s.transcriptFolder).onChange(async function (v) {
          s.transcriptFolder = v.trim();
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('转写笔记关键词')
      .setDesc('文件名或路径含这些词才算转写笔记，逗号分隔；留空表示不做名字过滤')
      .addText(function (t) {
        t.setValue(s.transcriptKeywords).onChange(async function (v) {
          s.transcriptKeywords = v;
          await plugin.saveSettings();
        });
        t.inputEl.style.width = '100%';
        return t;
      });

    new Setting(containerEl)
      .setName('排除关键词')
      .setDesc('文件名或路径含这些词就跳过，逗号分隔。默认「总结」——避免把已经生成的「xxx-总结.md」又送去 AI 总结一遍')
      .addText(function (t) {
        t.setValue(s.transcriptExclude).onChange(async function (v) {
          s.transcriptExclude = v;
          await plugin.saveSettings();
        });
        t.inputEl.style.width = '100%';
        return t;
      });

    new Setting(containerEl)
      .setName('只分析今天的转写笔记')
      .setDesc('按「文件名含今天日期」或「创建/修改时间在今天」判断；关掉会把匹配到的所有笔记都分析一遍')
      .addToggle(function (tg) {
        return tg.setValue(!!s.transcriptTodayOnly).onChange(async function (v) {
          s.transcriptTodayOnly = v;
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('打开今日笔记时自动分析')
      .setDesc('内容没变过的转写笔记会跳过，不会重复调用 API；关掉则只在手动运行命令时才分析')
      .addToggle(function (tg) {
        return tg.setValue(!!s.autoAnalyzeOnOpen).onChange(async function (v) {
          s.autoAnalyzeOnOpen = v;
          await plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('立即分析一次')
      .setDesc('按上面的规则扫描今天的转写笔记，把 AI 分析写进今日笔记的课程栏')
      .addButton(function (b) {
        return b.setButtonText('分析今日转写笔记').onClick(async function () {
          await plugin.analyzeTranscripts();
        });
      });

    containerEl.createEl('h3', { text: '手机桌面一键按钮' });
    containerEl.createEl('p', {
      text: '在手机系统的快捷指令里新建一个「打开 URL」动作，填下面这个地址，再添加到主屏幕，就能像 App 图标一样一点直达。'
        + 'iOS 用自带的「快捷指令」App；Android 用支持自定义 URL 的快捷方式 App（如 Shortcut Maker）。',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('打开/创建今日笔记')
      .setDesc('选中下面这串复制走：obsidian://daily-note')
      .addText(function (t) {
        t.setValue('obsidian://daily-note');
        t.inputEl.style.width = '100%';
        return t;
      });

    new Setting(containerEl)
      .setName('快速记一条待办')
      .setDesc('同上，这串是往今日笔记的待办板块里加一条：obsidian://daily-todo')
      .addText(function (t) {
        t.setValue('obsidian://daily-todo');
        t.inputEl.style.width = '100%';
        return t;
      });

    new Setting(containerEl)
      .setName('试一试 / 恢复默认')
      .setDesc('先用当前设置生成今天这篇看看效果')
      .addButton(function (b) {
        return b.setButtonText('打开今日笔记').setCta().onClick(async function () {
          await plugin.openDailyNote();
        });
      })
      .addButton(function (b) {
        return b.setButtonText('恢复默认设置').setWarning().onClick(async function () {
          plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
          await plugin.saveSettings();
          tab.display();
          new Notice('已恢复默认设置');
        });
      });
  }
}

module.exports = MobileDailyNotePlugin;
